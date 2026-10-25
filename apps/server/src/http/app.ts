import {
	type AppDb,
	deletePushSubscription,
	getAgentRow,
	listPushSubscriptions,
	upsertPushSubscription,
} from "@assistant/db";
import {
	ApprovalConflict,
	ApprovalNotFound,
	type ApprovalService,
	type DailyService,
	InvalidDailyTime,
	UnknownDailyJob,
} from "@assistant/extensions";
import type {
	AgentSettingsResponse,
	AgentsResponse,
	AllAgentSettingsResponse,
	MessagesPage,
	PushConfigResponse,
	RetryTaskResponse,
	ScheduleSettingsResponse,
	SendMessageResponse,
} from "@assistant/shared";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Conversation, EntryId, Harness, TaskId } from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import {
	AGENTS,
	type AgentDef,
	agentForConversation,
	asConversationId,
	listAgentSummaries,
	listParkedTasks,
} from "../agents.ts";
import type { AuthConfig } from "../config.ts";
import { listModelOptions, readAgentSettings, updateAgentSettings } from "../settings.ts";
import { runConversationStream } from "../stream.ts";
import type { UnansweredReader } from "../unanswered.ts";
import { toWireEntries } from "../wire.ts";
import { authMiddleware } from "./auth.ts";
import { ApiError, errorBody, errorHandler, invalidRequest, notFound, notFoundHandler } from "./errors.ts";
import { type HostPolicy, requestGuard } from "./guard.ts";
import { createFilesApp, createUploadsApp } from "./uploads.ts";
import {
	parseDecision,
	parseHistoryQuery,
	parseId,
	parsePushSubscribe,
	parsePushUnsubscribe,
	parseSendMessage,
	parseUpdateSchedule,
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

/** How many parked tasks `GET /api/agents` names. More than a handful means something else is wrong. */
const MAX_LISTED_PARKED = 20;

/** Devices that may be registered for notifications. One person has a few; a push is sent to each of them. */
export const MAX_PUSH_SUBSCRIPTIONS = 20;

export type AppDeps = {
	harness: Harness;
	db: AppDb;
	/** The models this process can serve: validates and lists what an agent may be set to. */
	models: Models;
	/** Reads why messages were never answered, for the snapshots of the event stream. */
	unanswered: UnansweredReader;
	/** Answers to approval requests: the Approve/Deny buttons, and a reply of YES. */
	approvals: ApprovalService;
	/** The VAPID public key browsers subscribe to Web Push with. */
	push: PushConfigResponse;
	/** The settings of the morning briefing and the evening wrap-up. */
	daily: DailyService;
	/** The owner's time zone, which the schedule's times are in. */
	timezone: string;
	/** Where uploads are kept (`<data>/files`, resolved). */
	filesDir: string;
	/** Where the assistant keeps what it makes (`<data>/workspace`, resolved), for the downloads that come from there. */
	workspaceDir?: string;
	/** Clock for stored timestamps. Default `Date.now`. */
	now?: () => number;
	auth: AuthConfig;
	/** Which `Host` headers this server answers to, for the port it actually listens on. */
	hosts: HostPolicy;
	agents?: readonly AgentDef[];
	/** SSE heartbeat interval. Default 15 s. */
	heartbeatMs?: number;
	maxStreams?: number;
	logger?: Pick<Console, "error"> & Partial<Pick<Console, "info">>;
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
	// The one write that is not JSON. It is registered before the JSON-only rule, which it must not reach, and carries its
	// own rules (uploads.ts); every other route is behind that rule. Do not move it, and do not add another like it.
	app.route(
		"/api/uploads",
		createUploadsApp({ db, filesDir: deps.filesDir, ...(deps.now === undefined ? {} : { now: deps.now }) }),
	);
	app.route(
		"/api/files",
		createFilesApp({
			db,
			filesDir: deps.filesDir,
			...(deps.workspaceDir === undefined ? {} : { workspaceDir: deps.workspaceDir }),
		}),
	);
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
		const parked = await listParkedTasks(harness, context);
		const body: AgentsResponse = {
			agents: await listAgentSummaries(harness, db, agents, context),
			health: { parkedTasks: parked.length, parked: parked.slice(0, MAX_LISTED_PARKED) },
		};
		return c.json(body);
	});

	app.post("/api/admin/tasks/:id/retry", async (c) => {
		const id = parseId(c.req.param("id"), "task id");
		const parked = await listParkedTasks(harness, context);
		if (!parked.some((task) => task.id === id)) {
			throw notFound(`No parked task has id ${id}. GET /api/agents lists the parked tasks (health.parked).`);
		}
		// Only after a person asked: the usual cause of parking is something that keeps killing the process.
		await harness.retryTask(id as TaskId, context);
		deps.logger?.info?.(`[durable] task ${id} was retried by request.`);
		const body: RetryTaskResponse = { ok: true };
		return c.json(body);
	});

	app.get("/api/push/config", (c) => c.json(deps.push));

	app.post("/api/push/subscribe", async (c) => {
		const { endpoint, keys } = parsePushSubscribe(await readJsonObject(c));
		const known = listPushSubscriptions(db);
		if (known.length >= MAX_PUSH_SUBSCRIPTIONS && !known.some((row) => row.endpoint === endpoint)) {
			throw new ApiError(
				409,
				"conflict",
				`${MAX_PUSH_SUBSCRIPTIONS} devices are already registered for notifications. Turn notifications off on one you ` +
					"no longer use (Settings, Notifications, Turn off) and try again.",
			);
		}
		const userAgent = c.req.header("user-agent")?.slice(0, 200);
		upsertPushSubscription(db, {
			endpoint,
			p256dh: keys.p256dh,
			auth: keys.auth,
			createdAt: (deps.now ?? Date.now)(),
			...(userAgent === undefined ? {} : { userAgent }),
		});
		return c.json({ ok: true }, 201);
	});

	app.delete("/api/push/subscribe", async (c) => {
		const { endpoint } = parsePushUnsubscribe(await readJsonObject(c));
		return c.json({ removed: deletePushSubscription(db, endpoint) });
	});

	app.post("/api/approvals/:id", async (c) => {
		const decision = parseDecision(await readJsonObject(c));
		try {
			return c.json(await deps.approvals.decide(c.req.param("id"), decision, "button"));
		} catch (error) {
			if (error instanceof ApprovalNotFound) throw notFound(error.message);
			if (error instanceof ApprovalConflict) throw new ApiError(409, "conflict", error.message);
			throw error;
		}
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

	app.get("/api/settings/schedule", (c) => {
		const body: ScheduleSettingsResponse = { timezone: deps.timezone, jobs: deps.daily.list() };
		return c.json(body);
	});

	app.put("/api/settings/schedule/:job", async (c) => {
		const change = parseUpdateSchedule(await readJsonObject(c));
		try {
			await deps.daily.update(c.req.param("job"), change);
		} catch (error) {
			if (error instanceof UnknownDailyJob) throw notFound(error.message);
			if (error instanceof InvalidDailyTime) throw invalidRequest(error.message);
			throw error;
		}
		const body: ScheduleSettingsResponse = { timezone: deps.timezone, jobs: deps.daily.list() };
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
		const { id, conversation } = await conversationOf(c.req.param("id"));
		const { content, requestId, whenBusy } = parseSendMessage(await readJsonObject(c));
		// A bare "YES" answers the newest approval request of this conversation. The server decides that, not the model.
		const approved = await deps.approvals.tryYes(id, content, requestId);
		if (approved !== undefined) {
			const body: SendMessageResponse = { submissionId: approved.submissionId };
			return c.json(body, 202);
		}
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
