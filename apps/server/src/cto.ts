import { execFile } from "node:child_process";
import { CARD_ID_PATTERN, type CodingLead, type CtoDeps, leadMessage, parseCardShow } from "@assistant/extensions";
import type { CtoConfig } from "./config.ts";

/** Runs one program with fixed argv and no shell. Resolves with stdout; rejects with a short message on failure. */
export type CtoExec = (file: string, args: readonly string[]) => Promise<string>;

const CTO_EXEC_TIMEOUT_MS = 30_000;

/**
 * `execFile` (never a shell) with a small, fixed environment: the board needs `HOME` to find its file and
 * `HC_BOARD_LIVE=1` to write the live board from outside an hc terminal. Nothing else of the server's environment
 * (model keys, tokens) reaches it.
 */
export const ctoExec: CtoExec = (file, args) =>
	new Promise((resolve, reject) => {
		execFile(
			file,
			[...args],
			{
				timeout: CTO_EXEC_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
					LANG: "C.UTF-8",
					HC_BOARD_LIVE: "1",
				},
			},
			(error, stdout, stderr) => {
				if (error === null) return resolve(String(stdout));
				const detail = String(stderr).trim() || error.message;
				reject(new Error(`${file} ${args[0] ?? ""} failed: ${detail.replace(/\s+/g, " ").slice(0, 300)}`));
			},
		);
	});

/**
 * The coding lead over `hc-board` and `hc` (PLAN upgrade §6). Every value in argv was validated by the tool (allowlisted
 * repo, capped text, no leading `-`) or is a card id checked against {@link CARD_ID_PATTERN}.
 *
 * Assumed contract (to verify on the real host): `hc-board create --key <k> --repo <r> --goal <g> --done-when <d>
 * --out-of-scope <o>` prints the card id on its last line and returns the existing card for a key it has seen;
 * `hc-board show <id>` prints the card as `<id> [<status>] <title>` and `  field: value` lines.
 */
export function createHcBoardLead(options: { boardBin: string; hcBin: string; exec?: CtoExec }): CodingLead {
	const exec = options.exec ?? ctoExec;
	const checkId = (cardId: string): string => {
		if (!CARD_ID_PATTERN.test(cardId)) throw new Error(`'${cardId.slice(0, 40)}' is not a card id.`);
		return cardId;
	};
	return {
		async createCard(request) {
			const out = await exec(options.boardBin, [
				"create",
				"--key",
				request.key,
				"--repo",
				request.repo,
				"--goal",
				request.goal,
				"--done-when",
				request.doneWhen,
				"--out-of-scope",
				request.outOfScope,
			]);
			const last = out.trim().split("\n").at(-1)?.trim() ?? "";
			return { cardId: checkId(last) };
		},
		async notifyLead(cardId) {
			await exec(options.hcBin, ["send", "lead", leadMessage(checkId(cardId))]);
		},
		async readCard(cardId) {
			let out: string;
			try {
				out = await exec(options.boardBin, ["show", checkId(cardId)]);
			} catch (error) {
				if (error instanceof Error && /no card|not found|unknown card/i.test(error.message)) return undefined;
				throw error;
			}
			return parseCardShow(out);
		},
	};
}

/** The CTO's deps when `ZIMPOEN_CTO=on`; undefined otherwise. */
export function ctoFor(config: CtoConfig, exec?: CtoExec): CtoDeps | undefined {
	if (config.mode === "off") return undefined;
	return {
		lead: createHcBoardLead({
			boardBin: config.boardBin,
			hcBin: config.hcBin,
			...(exec === undefined ? {} : { exec }),
		}),
		repos: config.repos,
		trust: config.trust,
	};
}
