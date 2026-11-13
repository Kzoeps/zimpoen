import { createHash } from "node:crypto";
import { type ExecFn, execProgram } from "../broker/broker.ts";
import { capBytes } from "../broker/scrub.ts";

/**
 * The sandboxed shell (PLAN upgrade §8, rule 5 as rewritten): every command runs in a fresh gVisor container
 * (`--runtime=runsc`) of its agent, never on the host. The host side only ever runs the container engine with a fixed
 * argv; the command string reaches `/bin/sh -c` inside the container and nothing on the host interprets it.
 */
export type ShellEngine = "docker" | "podman";

export type ShellSandboxConfig = {
	engine: ShellEngine;
	/** Absolute path of the engine's CLI (`/usr/bin/docker`). */
	bin: string;
	/** The image every command runs in. It must already be pulled: runs use `--pull=never`. */
	image: string;
	/** `none` (default: no network at all) or the dedicated network `ops/shell-egress.sh` filters. */
	network: string;
};

/** Fixed per-container limits. Not settings: raising them is a code change someone reviews. */
export const SHELL_LIMITS = {
	cpus: "1",
	memory: "512m",
	pids: 128,
	tmpfsSize: "64m",
	/** What the model sees of a command's combined stdout and stderr. */
	maxOutputBytes: 64 * 1024,
	defaultTimeoutMs: 60_000,
	maxTimeoutMs: 300_000,
	maxCommandChars: 8000,
} as const;

/** Resolvers a sandbox on a network uses. */
export const PUBLIC_DNS = ["1.1.1.1", "9.9.9.9"] as const;

/** Where an agent's workspace volume is mounted in its container. */
export const SHELL_WORKDIR = "/workspace";

/** The uid:gid commands run as inside the container. */
export const SHELL_USER = "1000:1000";

export type ShellRunRequest = {
	/** The agent the container belongs to (`pa`, `bot:<slug>`). Picks its volume. */
	agentId: string;
	command: string;
	timeoutMs: number;
	/** Makes the container name unique per call, so a timed-out one can be removed by name. */
	callId: string;
};

export type ShellRunResult = { exitCode: number; output: string; timedOut: boolean; truncated: boolean };

/** Runs one command in an agent's sandbox. The real one drives docker/podman; tests use a fake. */
export interface ContainerRunner {
	run(req: ShellRunRequest): Promise<ShellRunResult>;
}

const AGENT_ID = /^(pa|health|accountant|bot:[a-z][a-z0-9-]{1,31})$/;

/** The agent's named volume: `zimpoen-shell-pa`, `zimpoen-shell-bot-research`. Throws for an id that is not an agent's. */
export function volumeName(agentId: string): string {
	if (!AGENT_ID.test(agentId)) throw new Error(`'${agentId}' cannot have a shell sandbox.`);
	return `zimpoen-shell-${agentId.replace(":", "-")}`;
}

export function containerName(agentId: string, callId: string): string {
	const hash = createHash("sha256").update(callId).digest("hex").slice(0, 12);
	return `${volumeName(agentId)}-${hash}`;
}

/**
 * The flags every sandbox container gets, the probe included: gVisor, read-only root, no capabilities, no new privileges,
 * cpu/memory/pids limits, a small `/tmp`, the chosen network, never a pull.
 */
export function hardeningFlags(config: ShellSandboxConfig): string[] {
	return [
		"--rm",
		"--pull=never",
		"--runtime=runsc",
		"--read-only",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		`--pids-limit=${SHELL_LIMITS.pids}`,
		`--memory=${SHELL_LIMITS.memory}`,
		`--memory-swap=${SHELL_LIMITS.memory}`,
		`--cpus=${SHELL_LIMITS.cpus}`,
		`--network=${config.network}`,
		// The egress rules drop everything to the host, the engine's own resolver included: use public resolvers.
		...(config.network === "none" ? [] : PUBLIC_DNS.map((server) => `--dns=${server}`)),
		"--tmpfs",
		`/tmp:rw,nosuid,nodev,size=${SHELL_LIMITS.tmpfsSize}`,
		"--label=zimpoen.shell=1",
	];
}

/**
 * The argv of one command's container. The only mount is the agent's named volume: no host path is ever mounted, and
 * no host environment is passed.
 */
export function buildRunArgv(config: ShellSandboxConfig, req: ShellRunRequest): string[] {
	return [
		config.bin,
		"run",
		...hardeningFlags(config),
		`--name=${containerName(req.agentId, req.callId)}`,
		`--label=zimpoen.agent=${req.agentId}`,
		"--mount",
		`type=volume,src=${volumeName(req.agentId)},dst=${SHELL_WORKDIR}`,
		`--workdir=${SHELL_WORKDIR}`,
		`--user=${SHELL_USER}`,
		`--env=HOME=${SHELL_WORKDIR}`,
		"--hostname=sandbox",
		config.image,
		// The deadline inside the container too: if the server dies mid-call, the engine still kills the command.
		"timeout",
		"-s",
		"KILL",
		String(innerTimeoutSeconds(req.timeoutMs)),
		"/bin/sh",
		"-c",
		req.command,
	];
}

/** A little later than the host's own kill, so the host normally reports the timeout. */
export const innerTimeoutSeconds = (timeoutMs: number): number => Math.ceil(timeoutMs / 1000) + 5;

/**
 * Remove every sandbox container left over (by label), for instance by a server that died mid-call. Run at start, before
 * any call. Returns how many were removed; throws when the engine cannot list them.
 */
export async function reapContainers(config: ShellSandboxConfig, exec: ExecFn = execProgram): Promise<number> {
	const run = (args: string[]) =>
		exec({ file: config.bin, args, env: ENGINE_ENV, timeoutMs: ADMIN_TIMEOUT_MS, maxBytes: 64 * 1024 });
	const list = await run(["ps", "--all", "--quiet", "--filter", "label=zimpoen.shell=1"]);
	if (list.exitCode !== 0) throw new Error(`Could not list leftover sandbox containers: ${list.output.trim()}`);
	const ids = list.output.split(/\s+/).filter((id) => /^[0-9a-f]{6,64}$/.test(id));
	if (ids.length === 0) return 0;
	const removed = await run(["rm", "--force", ...ids]);
	if (removed.exitCode !== 0) throw new Error(`Could not remove leftover sandbox containers: ${removed.output.trim()}`);
	return ids.length;
}

/** The engine CLI sees only this: no server secrets, no proxy settings. */
const ENGINE_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };

const ADMIN_TIMEOUT_MS = 60_000;

/**
 * The real runner. Per call: make sure the agent's volume exists (created once and handed to {@link SHELL_USER}, the
 * only step that runs as root, still with every other capability dropped), run the command, and on a timeout or an
 * output overflow force-remove the container, since killing the CLI leaves it running.
 */
export function createEngineRunner(config: ShellSandboxConfig, exec: ExecFn = execProgram): ContainerRunner {
	const admin = (args: string[]) =>
		exec({ file: config.bin, args, env: ENGINE_ENV, timeoutMs: ADMIN_TIMEOUT_MS, maxBytes: 16 * 1024 });
	const ready = new Set<string>();

	const ensureVolume = async (agentId: string): Promise<void> => {
		const volume = volumeName(agentId);
		if (ready.has(volume)) return;
		const inspect = await admin(["volume", "inspect", volume]);
		if (inspect.exitCode !== 0) {
			const create = await admin(["volume", "create", "--label=zimpoen.shell=1", volume]);
			if (create.exitCode !== 0)
				throw new Error(`Could not create the sandbox volume ${volume}: ${create.output.trim()}`);
		}
		// Chowned once per process, whether or not the volume existed: a chown that failed earlier (or a volume the
		// engine recreated root-owned) is fixed on the next call instead of leaving /workspace unwritable for good.
		const chown = await admin([
			"run",
			...hardeningFlags({ ...config, network: "none" }),
			"--cap-add=CHOWN",
			"--user=0:0",
			"--mount",
			`type=volume,src=${volume},dst=${SHELL_WORKDIR}`,
			config.image,
			"chown",
			SHELL_USER,
			SHELL_WORKDIR,
		]);
		if (chown.exitCode !== 0) throw new Error(`Could not prepare the sandbox volume ${volume}: ${chown.output.trim()}`);
		ready.add(volume);
	};

	return {
		async run(req) {
			await ensureVolume(req.agentId);
			const [file, ...args] = buildRunArgv(config, req) as [string, ...string[]];
			const result = await exec({
				file,
				args,
				env: ENGINE_ENV,
				timeoutMs: req.timeoutMs,
				maxBytes: SHELL_LIMITS.maxOutputBytes + 1,
			});
			if (result.timedOut || result.truncated) {
				await admin(["rm", "--force", containerName(req.agentId, req.callId)]).catch(() => undefined);
			}
			const capped = capBytes(result.output, SHELL_LIMITS.maxOutputBytes);
			return { exitCode: result.exitCode, output: capped.text, timedOut: result.timedOut, truncated: result.truncated };
		},
	};
}
