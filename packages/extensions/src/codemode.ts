import { CODEMODE_OPTIONS_PREFIX, parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

/** How long a code mode script may run, wall clock, from its first start to its end (a restart does not reset it). */
export type CodemodeLimits = {
	/** What a script gets when it asks for nothing. */
	defaultTimeoutMs: number;
	/** The most a script may ask for with `// @options: {"timeout_ms": ...}`; a larger request is cut to this. */
	maxTimeoutMs: number;
};

export const DEFAULT_CODEMODE_LIMITS: CodemodeLimits = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000 };

/**
 * `source` with a `timeout_ms` option that is always there and never above `limits.maxTimeoutMs`.
 *
 * Durable starts a script with the time limit from the script's own `@options` line and nothing else: the sandbox's
 * configured `timeoutMs` is not read on that path, so a script that names no limit runs until the owner presses Stop (and
 * again after every restart), and one that names a day is allowed a day. With the option always present Durable also
 * stores the script's deadline, so a script that a restart interrupted past its deadline ends with an error instead of
 * starting over. The rest of the source is untouched; a malformed options line throws the error Durable would.
 */
export function boundCodemodeSource(source: string, limits: CodemodeLimits = DEFAULT_CODEMODE_LIMITS): string {
	const { code, options } = parseCodemodeSource(source);
	const asked = options.timeoutMs;
	if (asked !== undefined && asked <= limits.maxTimeoutMs) return source;
	const bounded = {
		...(options.maxOutputTokens === undefined ? {} : { max_output_tokens: options.maxOutputTokens }),
		timeout_ms: Math.min(asked ?? limits.defaultTimeoutMs, limits.maxTimeoutMs),
	};
	const header = `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify(bounded)}`;
	// After an options line `code` starts with that line's break and replaces the line; with none, `code` is the whole source.
	const hadOptionsLine = code !== source;
	return hadOptionsLine ? `${header}${code}` : `${header}\n${source}`;
}

function checkLimits(limits: CodemodeLimits): void {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
			throw new Error(
				`The code mode ${name} must be a whole number of milliseconds between 1 and 2147483647; got ${value}.`,
			);
		}
	}
	if (limits.defaultTimeoutMs > limits.maxTimeoutMs) {
		throw new Error(
			`The default code mode time limit (${limits.defaultTimeoutMs} ms) is above the most a script may ask for (${limits.maxTimeoutMs} ms).`,
		);
	}
}

type CodemodeOptions = Parameters<typeof createCodemodeExtension>[0];

/**
 * Durable's code mode extension, with every script bounded in time by {@link boundCodemodeSource}. The tool keeps its name,
 * description and replay behaviour; only the source it is given has the limit written into it.
 */
export function createBoundedCodemodeExtension(
	options: CodemodeOptions & { limits?: Partial<CodemodeLimits> },
): Extension {
	const { limits, ...rest } = options;
	const bounds: CodemodeLimits = { ...DEFAULT_CODEMODE_LIMITS, ...limits };
	checkLimits(bounds);
	const extension = createCodemodeExtension(rest);
	const bounded = (tool: ToolRegistration): ToolRegistration =>
		tool.name === CODEMODE_TOOL_NAME
			? {
					...tool,
					execute: async (args, api, context) => {
						const { code } = args as { code: string };
						return tool.execute({ code: boundCodemodeSource(code, bounds) }, api, context);
					},
				}
			: tool;
	return { ...extension, tools: (extension.tools ?? []).map(bounded) };
}
