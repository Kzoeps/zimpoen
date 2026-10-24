import type {
	AgentSettingsResponse,
	AgentsResponse,
	AllAgentSettingsResponse,
	ApiErrorBody,
	ApprovalDecision,
	ApprovalState,
	MessagesPage,
	PushConfigResponse,
	PushSubscribeRequest,
	RetryTaskResponse,
	SendMessageRequest,
	SendMessageResponse,
	UpdateAgentSettingsRequest,
} from "@assistant/shared";

/** A failed call to the server, with a message fit to show the user. `status` is 0 when the server was unreachable. */
export class ApiRequestError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ApiRequestError";
		this.status = status;
		this.code = code;
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, init);
	} catch {
		throw new ApiRequestError(
			0,
			"network",
			"Cannot reach the assistant server. Check that it is running and that you are connected.",
		);
	}
	if (response.ok) return (await response.json()) as T;
	// A proxy in front of the server answers with its own bodies ({"message": "Bad gateway"}), not our error shape.
	const body = (await response.json().catch(() => undefined)) as Partial<ApiErrorBody> | undefined;
	throw new ApiRequestError(
		response.status,
		body?.error?.code ?? "http_error",
		body?.error?.message ?? unexplainedFailure(response),
	);
}

/** Only a proxy or a crashed server answers without our error body: a 5xx then usually means the server is restarting. */
function unexplainedFailure(response: Response): string {
	if (response.status >= 500) {
		return `The assistant server is not answering properly (HTTP ${response.status}). It may be restarting: wait a few seconds and try again.`;
	}
	return `The server answered ${response.status} ${response.statusText}.`;
}

const json = (body: unknown, method = "POST"): RequestInit => ({
	method,
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

export const fetchAgents = (): Promise<AgentsResponse> => request("/api/agents");

export const fetchAgentSettings = (): Promise<AllAgentSettingsResponse> => request("/api/settings/agents");

export const updateAgentSettings = (
	agentId: string,
	change: UpdateAgentSettingsRequest,
): Promise<AgentSettingsResponse> =>
	request(`/api/settings/agents/${encodeURIComponent(agentId)}`, json(change, "PUT"));

export const sendMessage = (conversationId: number, body: SendMessageRequest): Promise<SendMessageResponse> =>
	request(`/api/conversations/${conversationId}/messages`, json(body));

export const abortRun = (conversationId: number): Promise<{ ok: boolean }> =>
	request(`/api/conversations/${conversationId}/abort`, json({}));

export const fetchEarlier = (conversationId: number, before: number, limit = 50): Promise<MessagesPage> =>
	request(`/api/conversations/${conversationId}/messages?before=${before}&limit=${limit}`);

export const decideApproval = (actionId: string, decision: ApprovalDecision): Promise<ApprovalState> =>
	request(`/api/approvals/${encodeURIComponent(actionId)}`, json({ decision }));

export const retryTask = (taskId: number): Promise<RetryTaskResponse> =>
	request(`/api/admin/tasks/${taskId}/retry`, json({}));

export const fetchPushConfig = (): Promise<PushConfigResponse> => request("/api/push/config");

export const subscribePush = (subscription: PushSubscribeRequest): Promise<{ ok: boolean }> =>
	request("/api/push/subscribe", json(subscription));

export const unsubscribePush = (endpoint: string): Promise<{ removed: boolean }> =>
	request("/api/push/subscribe", json({ endpoint }, "DELETE"));

export const streamUrl = (conversationId: number): string => `/api/conversations/${conversationId}/stream`;

/** Idempotency key for one message. `crypto.randomUUID` needs a secure context, so fall back to random bytes. */
export function newRequestId(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
