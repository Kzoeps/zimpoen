import { readFile } from "node:fs/promises";
import { type AppDb, getAgentRow } from "@assistant/db";
import { type ApprovalService, answerTextOf } from "@assistant/extensions";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId, Harness, SubmissionId } from "@earendil-works/pi-durable";
import { asConversationId } from "../agents.ts";
import type { Config } from "../config.ts";
import { type BridgeLogger, createTelegramBridge, type PaGateway, type TelegramBridge } from "./bridge.ts";
import { createTelegramClient } from "./client.ts";
import { createTranscriber, type Runner } from "./voice.ts";

export { telegramMigrations } from "./store.ts";

/** Read `<data>/secrets/telegram.json`. Throws a message that says what to put there. */
export async function readTelegramToken(path: string): Promise<string> {
	const hint = `Put {"token": "<bot token from @BotFather>"} in ${path} (mode 0600), or set ZIMPOEN_TELEGRAM=off.`;
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		throw new Error(`ZIMPOEN_TELEGRAM=on but ${path} cannot be read. ${hint}`);
	}
	let token: unknown;
	try {
		token = (JSON.parse(raw) as { token?: unknown }).token;
	} catch {
		throw new Error(`${path} is not valid JSON. ${hint}`);
	}
	if (typeof token !== "string" || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim())) {
		throw new Error(`${path} has no bot token in "token". ${hint}`);
	}
	return token.trim();
}

/** The PA as the bridge sees it: owner messages go in like the web's, YES included; the reply is the run's last text. */
export function createPaGateway(deps: { harness: Harness; db: AppDb; approvals: ApprovalService }): PaGateway {
	const context = BACKGROUND_CONTEXT;
	const paConversation = (): number => {
		const id = getAgentRow(deps.db, "pa")?.conversationId;
		if (id === undefined) throw new Error("The PA has no conversation yet.");
		return id;
	};
	return {
		async send(content, requestId) {
			const id = paConversation();
			const approved = await deps.approvals.tryYes(id, content, requestId);
			if (approved !== undefined) return { submissionId: approved.submissionId, approved: true };
			const conversation = await deps.harness.conversation(asConversationId(id), context);
			if (conversation === undefined) throw new Error(`Conversation ${id} is missing from durable.sqlite.`);
			const submission = await conversation.submit({ type: "input", content, requestId }, context);
			return { submissionId: submission.id, approved: false };
		},
		async reply(submissionId) {
			const handle = await deps.harness.submission(submissionId as SubmissionId, context);
			if (handle === undefined) return "That message was lost before the assistant saw it. Please send it again.";
			const settled = await handle.wait(context);
			if (settled.status !== "done") return `No answer came (${settled.reason ?? "the run ended"}).`;
			const entry = await deps.harness.commit((tx) => tx.entry(settled.answer as EntryId), context);
			return answerTextOf(entry);
		},
	};
}

export type TelegramSetupOptions = {
	harness: Harness;
	db: AppDb;
	approvals: ApprovalService;
	logger: BridgeLogger;
	now?: () => number;
	/** Telegram's Bot API stand-in and the ffmpeg/whisper runner, for tests. */
	fetch?: typeof fetch;
	base?: string;
	run?: Runner;
	pollSeconds?: number;
};

/** Start the bridge when `ZIMPOEN_TELEGRAM=on`; undefined (nothing started) when it is off. */
export async function startTelegram(
	config: Config,
	options: TelegramSetupOptions,
): Promise<TelegramBridge | undefined> {
	if (!config.telegram.enabled) return undefined;
	const token = await readTelegramToken(config.paths.telegram);
	const whisper = config.telegram.whisper;
	const bridge = createTelegramBridge({
		db: options.db,
		client: createTelegramClient(token, {
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
			...(options.base === undefined ? {} : { base: options.base }),
		}),
		pa: createPaGateway(options),
		...(whisper === undefined
			? {}
			: { transcribe: createTranscriber({ whisper, ...(options.run === undefined ? {} : { run: options.run }) }) }),
		logger: options.logger,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.pollSeconds === undefined ? {} : { pollSeconds: options.pollSeconds }),
	});
	if (whisper === undefined) options.logger.info("[telegram] voice notes are off (ZIMPOEN_WHISPER_BIN/MODEL not set).");
	bridge.start();
	return bridge;
}
