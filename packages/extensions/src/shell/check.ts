import { readFile, stat } from "node:fs/promises";
import { type ExecFn, execProgram } from "../broker/broker.ts";
import { hardeningFlags, type ShellSandboxConfig } from "./sandbox.ts";

/**
 * What the egress rules must block for a sandbox on a network (`ops/shell-egress.sh` writes the same list into its
 * marker): private, link-local, loopback, ULA and the tailnet.
 */
export const BLOCKED_EGRESS_RANGES = [
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"169.254.0.0/16",
	"127.0.0.0/8",
	"100.64.0.0/10",
	"fc00::/7",
	"fe80::/10",
	"fd7a:115c:a1e0::/48",
] as const;

export type EgressMarker = { owner: number; mode: number; text: string };

export type ShellHostCheckDeps = {
	exec?: ExecFn;
	/** Read the marker `ops/shell-egress.sh` writes. Default: the file system. Undefined: there is none. */
	readMarker?: (path: string) => Promise<EgressMarker | undefined>;
};

export type ShellHostConfig = ShellSandboxConfig & { egressMarker: string };

const ENGINE_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };

async function readMarkerFile(path: string): Promise<EgressMarker | undefined> {
	try {
		const info = await stat(path);
		return { owner: info.uid, mode: info.mode, text: await readFile(path, "utf8") };
	} catch {
		return undefined;
	}
}

/** `key=value` lines. */
const parseMarker = (text: string): Map<string, string> =>
	new Map(
		text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"))
			.map((line) => {
				const at = line.indexOf("=");
				return [line.slice(0, at), line.slice(at + 1)] as [string, string];
			}),
	);

/**
 * The start-up check for `ZIMPOEN_SHELL=on`. Returns every problem (empty: fine); the server refuses to start otherwise.
 *
 * - gVisor: a probe container with the full hardening flags and `--runtime=runsc` must run `true`. That fails when the
 *   engine has no `runsc` runtime or the image was not pulled.
 * - Egress (only for a network other than `none`): the root-owned marker `ops/shell-egress.sh` writes must exist, name
 *   this network and its bridge, and list every range of {@link BLOCKED_EGRESS_RANGES}; the network's bridge must be that
 *   one. `/run` is cleared at boot, as non-persisted rules are, so a reboot without the script fails the check.
 */
export async function checkShellHost(config: ShellHostConfig, deps: ShellHostCheckDeps = {}): Promise<string[]> {
	const exec = deps.exec ?? execProgram;
	const run = (args: string[]) =>
		exec({ file: config.bin, args, env: ENGINE_ENV, timeoutMs: 120_000, maxBytes: 16 * 1024 });
	const problems: string[] = [];

	const probe = await run(["run", ...hardeningFlags(config), config.image, "true"]);
	if (probe.exitCode !== 0) {
		problems.push(
			`a gVisor probe container did not run (${config.bin} run --runtime=runsc ... ${config.image} true: exit ${probe.exitCode}: ` +
				`${probe.output.trim().slice(0, 300)}). Install gVisor and register it as the 'runsc' runtime, and pull the image ` +
				`(${config.bin} pull ${config.image}).`,
		);
	}
	if (config.network === "none") return problems;

	const marker = await (deps.readMarker ?? readMarkerFile)(config.egressMarker);
	const runScript = `Run ops/shell-egress.sh --network ${config.network} as root (it applies the rules and writes the marker).`;
	if (marker === undefined) {
		problems.push(
			`ZIMPOEN_SHELL_NETWORK=${config.network} but the egress marker ${config.egressMarker} is missing. ${runScript}`,
		);
		return problems;
	}
	if (marker.owner !== 0 || (marker.mode & 0o022) !== 0) {
		problems.push(
			`the egress marker ${config.egressMarker} must be owned by root and writable only by root. ${runScript}`,
		);
		return problems;
	}
	const fields = parseMarker(marker.text);
	if (fields.get("network") !== config.network) {
		problems.push(
			`the egress marker names network '${fields.get("network") ?? ""}', not '${config.network}'. ${runScript}`,
		);
	}
	const listed = new Set((fields.get("blocked") ?? "").split(",").map((range) => range.trim()));
	const missing = BLOCKED_EGRESS_RANGES.filter((range) => !listed.has(range));
	if (missing.length > 0) problems.push(`the egress rules do not block ${missing.join(", ")}. ${runScript}`);

	const bridge = fields.get("bridge") ?? "";
	const format =
		config.engine === "docker" ? '{{index .Options "com.docker.network.bridge.name"}}' : "{{.NetworkInterface}}";
	const inspect = await run(["network", "inspect", "--format", format, config.network]);
	if (inspect.exitCode !== 0) {
		problems.push(`network '${config.network}' does not exist (${inspect.output.trim().slice(0, 200)}). ${runScript}`);
	} else if (bridge === "" || inspect.output.trim() !== bridge) {
		problems.push(
			`network '${config.network}' uses bridge '${inspect.output.trim()}', but the egress rules filter '${bridge}'. ${runScript}`,
		);
	}
	return problems;
}
