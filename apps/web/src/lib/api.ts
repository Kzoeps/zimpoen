import type {
	AgentSettingsResponse,
	AgentsResponse,
	AllAgentSettingsResponse,
	ApiErrorBody,
	ApprovalDecision,
	ApprovalState,
	DecideSuggestionRequest,
	DisconnectGoogleRequest,
	GoogleSettingsResponse,
	MessagesPage,
	PushConfigResponse,
	PushSubscribeRequest,
	RetryTaskResponse,
	ScheduleSettingsResponse,
	SendMessageRequest,
	SendMessageResponse,
	SuggestionDecision,
	SuggestionState,
	UpdateAgentSettingsRequest,
	UpdateScheduleRequest,
	UploadResponse,
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

/** The owner's answer to what the Inbox suggested: Add asks the PA to add the follow-up, Dismiss drops it. */
export const decideSuggestion = (id: string, decision: SuggestionDecision): Promise<SuggestionState> =>
	request(`/api/suggestions/${encodeURIComponent(id)}`, json({ decision } satisfies DecideSuggestionRequest));

export const retryTask = (taskId: number): Promise<RetryTaskResponse> =>
	request(`/api/admin/tasks/${taskId}/retry`, json({}));

export const fetchPushConfig = (): Promise<PushConfigResponse> => request("/api/push/config");

export const subscribePush = (subscription: PushSubscribeRequest): Promise<{ ok: boolean }> =>
	request("/api/push/subscribe", json(subscription));

export const unsubscribePush = (endpoint: string): Promise<{ removed: boolean }> =>
	request("/api/push/subscribe", json({ endpoint }, "DELETE"));

export const streamUrl = (conversationId: number): string => `/api/conversations/${conversationId}/stream`;

export const fetchSchedule = (): Promise<ScheduleSettingsResponse> => request("/api/settings/schedule");

export const updateSchedule = (job: string, change: UpdateScheduleRequest): Promise<ScheduleSettingsResponse> =>
	request(`/api/settings/schedule/${encodeURIComponent(job)}`, json(change, "PUT"));

/** The Google accounts the Inbox reads, how mail is classified (Jev or the local rules), and how the sync is doing. */
export const fetchGoogleSettings = (): Promise<GoogleSettingsResponse> => request("/api/settings/google");

/**
 * Forget an account's saved sign-in on the server and stop syncing it. The mail already read stays. Answers with the
 * settings as they are now. The address travels in the body, not in the path.
 */
export const disconnectGoogleAccount = (email: string): Promise<GoogleSettingsResponse> =>
	request("/api/settings/google/accounts", json({ email } satisfies DisconnectGoogleRequest, "DELETE"));

/** Where an uploaded file can be opened: images are shown, everything else downloads. */
export const fileUrl = (id: string): string => `/api/files/${encodeURIComponent(id)}`;

/** The part of `XMLHttpRequest` that {@link uploadFile} uses, so that tests can stand in for it. */
export type UploadRequest = Pick<
	XMLHttpRequest,
	"open" | "send" | "abort" | "status" | "responseText" | "onload" | "onerror" | "onabort"
> & { upload: Pick<XMLHttpRequest["upload"], "onprogress"> };

export type Upload = {
	/** Resolves with the stored file; rejects with an {@link ApiRequestError} whose message is fit to show. */
	done: Promise<UploadResponse>;
	/** Stops the upload. `done` then rejects with code `aborted`. */
	abort(): void;
};

/**
 * Upload one file to the server. Not `fetch`: only `XMLHttpRequest` reports how much of the body has been sent, which is
 * what the progress bar shows on a phone. The browser sets the multipart boundary and `Sec-Fetch-Site: same-origin`,
 * which the server requires for this route (`docs/design-notes.md`).
 */
export function uploadFile(
	file: File,
	onProgress: (fraction: number) => void,
	create: () => UploadRequest = () => new XMLHttpRequest(),
): Upload {
	const xhr = create();
	const done = new Promise<UploadResponse>((resolve, reject) => {
		xhr.open("POST", "/api/uploads");
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable && event.total > 0) onProgress(Math.min(event.loaded / event.total, 1));
		};
		xhr.onload = () => {
			const body = parseJson(xhr.responseText);
			if (xhr.status >= 200 && xhr.status < 300) return resolve(body as UploadResponse);
			const error = (body as Partial<ApiErrorBody> | undefined)?.error;
			reject(
				new ApiRequestError(
					xhr.status,
					error?.code ?? "http_error",
					error?.message ??
						(xhr.status >= 500
							? `The assistant server is not answering properly (HTTP ${xhr.status}). It may be restarting: try again in a few seconds.`
							: `The server answered ${xhr.status}.`),
				),
			);
		};
		xhr.onerror = () =>
			reject(
				new ApiRequestError(
					0,
					"network",
					"The upload did not reach the assistant. Check that you are connected and try again.",
				),
			);
		xhr.onabort = () => reject(new ApiRequestError(0, "aborted", "The upload was cancelled."));
		const form = new FormData();
		form.set("file", file, file.name);
		xhr.send(form);
	});
	return { done, abort: () => xhr.abort() };
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Idempotency key for one message. `crypto.randomUUID` needs a secure context, so fall back to random bytes. */
export function newRequestId(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
