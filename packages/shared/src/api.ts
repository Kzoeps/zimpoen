import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AgentId, AgentSummary } from "./agents.ts";

/** Longest message the composer may send, in UTF-16 code units. */
export const MAX_MESSAGE_CHARS = 20_000;

/** Client-generated idempotency key of a message: a retried POST with the same one never sends it twice. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export const DEFAULT_HISTORY_PAGE = 50;
export const MAX_HISTORY_PAGE = 200;

export type SendMessageRequest = {
	content: string;
	requestId: string;
	/** What to do when the agent is already answering: `followUp` (default) waits for the answer, `steer` interrupts. */
	whenBusy?: "steer" | "followUp";
};

export type SendMessageResponse = {
	/** Durable submission id. Its outcome arrives on the stream as a `submission` event. */
	submissionId: number;
};

/** Older entries, oldest first. Page back with `before` set to `nextBefore` until it is absent. */
export type MessagesPage = {
	entries: EntryRecord[];
	nextBefore?: number;
};

export const API_ERROR_CODES = [
	"unauthorized",
	/** The request is not one this server answers: a `Host` it does not serve, or a cross-site browser request. */
	"forbidden",
	"invalid_json",
	"invalid_request",
	"payload_too_large",
	"not_found",
	"too_many_requests",
	"unavailable",
	"internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Every non-2xx response has this body. `message` says what went wrong and what to do about it. */
export type ApiErrorBody = {
	error: { code: ApiErrorCode; message: string };
};

/** What `GET /api/agents` says about the server itself, so the UI can show trouble that the chat cannot. */
export type ServerHealth = {
	/**
	 * Tasks Durable gave up on after they were cut off by crashes again and again. A parked task does nothing until it
	 * is retried, so the agent whose run it was stops answering. Zero when all is well.
	 */
	parkedTasks: number;
};

export type AgentsResponse = {
	agents: AgentSummary[];
	health: ServerHealth;
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly unknown[]).includes(value);
}

export type ModelSelection = { provider: string; modelId: string };

/** A model this server can serve right now, with the thinking levels it supports. */
export type ModelOption = ModelSelection & {
	/** Display name. */
	name: string;
	thinkingLevels: ThinkingLevel[];
};

/** One agent's model and thinking level, which the owner can change at runtime. */
export type AgentSettings = {
	id: AgentId;
	name: string;
	avatar: string;
	/** Absent only for a conversation that never had a model chosen. */
	model?: ModelSelection;
	thinkingLevel?: ThinkingLevel;
	/** False when this server cannot serve `model` (for example an agent created on the dev model, now in OpenAI mode). */
	modelAvailable: boolean;
};

export type AgentSettingsResponse = { agent: AgentSettings; models: ModelOption[] };

export type AllAgentSettingsResponse = { agents: AgentSettings[]; models: ModelOption[] };

/** At least one field. Takes effect from the agent's next request. */
export type UpdateAgentSettingsRequest = {
	model?: ModelSelection;
	thinkingLevel?: ThinkingLevel;
};
