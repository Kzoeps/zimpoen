import { type AppDb, getAgentRow } from "@assistant/db";
import type {
	AgentSettingsResponse,
	AgentsResponse,
	AllAgentSettingsResponse,
	MessagesPage,
	SendMessageResponse,
} from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Conversation, EntryId, Harness } from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import {
	AGENTS,
	type AgentDef,
	agentForConversation,
	asConversationId,
	countParkedTasks,
	listAgentSummaries,
} from "../agents.ts";
import type { AuthConfig } from "../config.ts";
import { listModelOptions, readAgentSettings, updateAgentSettings } from "../settings.ts";
import { runConversationStream } from "../stream.ts";
import type { UnansweredReader } from "../unanswered.ts";
import { toWireEntries } from "../wire.ts";
import { authMiddleware } from "./auth.ts";
import { ApiError, errorBody, errorHandler, notFound, notFoundHandler } from "./errors.ts";
import { type HostPolicy, requestGuard } from "./guard.ts";
import {
	parseHistoryQuery,
	parseId,
	parseSendMessage,
	parseUpdateSettings,
	readJsonObject,
	requireJsonContentType,
} from "./validation.ts";

/**
 * Largest request body, in bytes. A message is at most 20 000 characters, which is at most ~120 KB as JSON; the limit
 * is checked before the body is parsed, so an oversized one is never held in memory.
 */
export const MAX_REQUEST_BYTES = 256 * 1024;

/** Most event streams open at once. Each holds a Durable watch; the owner has a few tabs, not dozens. */
export const DEFAULT_MAX_STREAMS = 8;

export type AppDeps = {
	harness: Harness;
	db: AppDb;
	/** The models this process can serve: validates and lists what an agent may be set to. */
	models: Models;
	/** Reads why messages were never answered, for the snapshots of the event stream. */
	unanswered: UnansweredReader;
	auth: AuthConfig;
	/** Which `Host` headers this server answers to, for the port it actually listens on. */
	hosts: HostPolicy;
	agents?: readonly AgentDef[];
	/** SSE heartbeat interval. Default 15 s. */
	heartbeatMs?: number;
	maxStreams?: number;
	logger?: Pick<Console, "error">;
};

/**
 * The HTTP API of PLAN §5.5 that M1 needs. Every route is under `/api`, takes and returns JSON (the stream is SSE), and
 * answers errors with `{ error: { code, message } }`. Only conversations that belong to an agent are reachable.
 */
export function createApp(deps: AppDeps): Hono {
	const { harness, db } = deps;
	const agents = deps.agents ?? AGENTS;
	const context = BACKGROUND_CONTEXT;

	const app = new Hono();
	app.onError(errorHandler(deps.logger ?? console));
	app.notFound(notFoundHandler);
	// Order matters: refuse foreign hosts and cross-site browsers before identity, and size before parsing.
	app.use("/api/*", requestGuard(deps.hosts));
	app.use("/api/*", authMiddleware(deps.auth));
	app.use("/api/*", requireJsonContentType);
	app.use(
		"/api/*",
		bodyLimit({
			maxSize: MAX_REQUEST_BYTES,
			onError: (c) =>
				c.json(
					errorBody(
						"payload_too_large",
						`The request body is larger than ${MAX_REQUEST_BYTES / 1024} KB. Messages are limited to 20 000 characters.`,
					),
					413,
				),
		}),
	);
	let openStreams = 0;
	const maxStreams = deps.maxStreams ?? DEFAULT_MAX_STREAMS;

	/** The conversation behind `:id`, 404 unless an agent owns it. */
	async function conversationOf(raw: string): Promise<{ id: number; conversation: Conversation }> {
		const id = parseId(raw, "conversation id");
		if (agentForConversation(db, id, agents) === undefined) {
			throw notFound(`No agent has conversation ${id}. GET /api/agents lists the conversations.`);
		}
		const conversation = await harness.conversation(asConversationId(id), context);
		if (conversation === undefined) {
			throw notFound(`Conversation ${id} is missing from durable.sqlite. The databases may be out of sync.`);
		}
		return { id, conversation };
	}

	app.get("/api/agents", async (c) => {
		const body: AgentsResponse = {
			agents: await listAgentSummaries(harness, db, agents, context),
			health: { parkedTasks: await countParkedTasks(harness, context) },
		};
		return c.json(body);
	});

	/** The agent behind `:id` and its conversation id, 404 for a name that is not an agent. */
	function agentOf(raw: string): { def: AgentDef; conversationId: number } {
		const def = agents.find((candidate) => candidate.id === raw);
		const row = def === undefined ? undefined : getAgentRow(db, def.id);
		if (def === undefined || row === undefined) {
			throw notFound(`There is no agent '${raw}'. GET /api/agents lists them.`);
		}
		return { def, conversationId: row.conversationId };
	}

	app.get("/api/settings/agents", async (c) => {
		const body: AllAgentSettingsResponse = {
			agents: await Promise.all(
				agents.map(async (def) => {
					const { conversationId } = agentOf(def.id);
					return await readAgentSettings(harness, conversationId, def, deps.models, context);
				}),
			),
			models: listModelOptions(deps.models),
		};
		return c.json(body);
	});

	app.get("/api/settings/agents/:id", async (c) => {
		const { def, conversationId } = agentOf(c.req.param("id"));
		const body: AgentSettingsResponse = {
			agent: await readAgentSettings(harness, conversationId, def, deps.models, context),
			models: listModelOptions(deps.models),
		};
		return c.json(body);
	});

	app.put("/api/settings/agents/:id", async (c) => {
		const { def, conversationId } = agentOf(c.req.param("id"));
		const request = parseUpdateSettings(await readJsonObject(c));
		const body: AgentSettingsResponse = {
			agent: await updateAgentSettings(harness, conversationId, def, request, deps.models, context),
			models: listModelOptions(deps.models),
		};
		return c.json(body);
	});

	app.get("/api/conversations/:id/messages", async (c) => {
		const { conversation } = await conversationOf(c.req.param("id"));
		const { before, limit } = parseHistoryQuery(c);
		const page = await conversation.entries(
			{ order: "descending", ...(before === undefined ? {} : { maxEntryId: (before - 1) as EntryId }) },
			limit,
			undefined,
			context,
		);
		const oldest = page.items.at(-1);
		const body: MessagesPage = {
			entries: toWireEntries([...page.items].reverse()),
			...(page.next === undefined || oldest === undefined ? {} : { nextBefore: oldest.id }),
		};
		return c.json(body);
	});

	app.post("/api/conversations/:id/messages", async (c) => {
		const { conversation } = await conversationOf(c.req.param("id"));
		const { content, requestId, whenBusy } = parseSendMessage(await readJsonObject(c));
		// A repeated requestId returns the original submission, so a retry after a dropped response is safe.
		const submission = await conversation.submit(
			{ type: "input", content, requestId, ...(whenBusy === undefined ? {} : { whenBusy }) },
			context,
		);
		const body: SendMessageResponse = { submissionId: submission.id };
		return c.json(body, 202);
	});

	app.post("/api/conversations/:id/abort", async (c) => {
		const { conversation } = await conversationOf(c.req.param("id"));
		await conversation.abort(context);
		return c.json({ ok: true });
	});

	app.get("/api/conversations/:id/stream", async (c) => {
		const { id } = await conversationOf(c.req.param("id"));
		if (openStreams >= maxStreams) {
			throw new ApiError(
				429,
				"too_many_requests",
				`${maxStreams} live connections are already open. Close other assistant tabs or windows and reload.`,
			);
		}
		openStreams++;
		const response = streamSSE(c, async (sse) => {
			try {
				await runConversationStream({
					harness,
					conversationId: asConversationId(id),
					signal: c.req.raw.signal,
					unanswered: deps.unanswered,
					heartbeatMs: deps.heartbeatMs,
					write: (frame) => sse.writeSSE({ event: frame.event, data: frame.data }),
				});
			} finally {
				openStreams--;
			}
		});
		// Set after streamSSE, which writes its own `no-cache`. `no-transform` keeps proxies (Next's dev proxy included)
		// from compressing the stream, which would hold events back until a buffer fills.
		response.headers.set("Cache-Control", "no-cache, no-transform");
		response.headers.set("X-Accel-Buffering", "no");
		return response;
	});

	return app;
}
