import { checkShellHost, createEngineRunner, type ShellDeps, type ShellHostCheckDeps } from "@assistant/extensions";
import type { ShellConfig } from "./config.ts";

/**
 * The sandboxed shell for `ZIMPOEN_SHELL=on` (upgrade §8). Checks the host first and throws, listing every problem, when
 * gVisor is missing or a network sandbox has no egress rules: the server must not start with a shell it cannot contain.
 * Off: undefined, and no container engine is touched.
 */
export async function loadShell(config: ShellConfig, host: ShellHostCheckDeps = {}): Promise<ShellDeps | undefined> {
	if (config.mode === "off") return undefined;
	const problems = await checkShellHost(config, host);
	if (problems.length > 0) {
		throw new Error(
			`ZIMPOEN_SHELL=on but the sandbox is not safe to use:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n` +
				"Fix these, or set ZIMPOEN_SHELL=off. See docs/ARCHITECTURE.md §5.8.",
		);
	}
	return { runner: createEngineRunner(config, host.exec) };
}
