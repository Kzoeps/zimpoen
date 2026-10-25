import type { ApiErrorBody, AttachmentRef, UploadResponse } from "@assistant/shared";

/**
 * What the Android share sheet hands the installed web app (`share_target` in the manifest): a POST with the shared title,
 * text, link and files. The page cannot read a POST body, so a route handler does: it sends each file to the assistant's
 * own upload route and sends the owner on to the capture page with what was kept, where they choose who gets it.
 */

/** What the capture page is told by the address it was redirected to. */
export type SharedItem = {
	title: string;
	text: string;
	url: string;
	files: AttachmentRef[];
	/** Files that were refused, with the reason, so that the owner knows. */
	problems: string[];
};

export type ShareDeps = {
	/** Where the assistant server is (`ASSISTANT_API_ORIGIN`). */
	apiOrigin: string;
	fetch: typeof fetch;
};

/** The most of a shared text kept in the address: past that the text is kept as a file instead. */
export const MAX_SHARED_TEXT_CHARS = 1500;

const clip = (value: FormDataEntryValue | null, max: number): string =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * The route's answer to a share. The request is refused unless the browser itself delivered it (`Sec-Fetch-Site` none or
 * same-origin): the API checks the same header on the upload, but a share that has no files never reaches it, and no page
 * on another site should be able to push text into the capture page either. The headers that identify the caller and the
 * page's host are passed on as they came, so that the API makes the same decisions it would for the browser itself.
 */
export async function handleShare(request: Request, deps: ShareDeps): Promise<Response> {
	const site = request.headers.get("sec-fetch-site");
	if (site !== "none" && site !== "same-origin") {
		return new Response("The assistant takes a share only from the Android share sheet or its own page.", {
			status: 403,
		});
	}
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return new Response("The shared content could not be read.", { status: 400 });
	}

	const shared: SharedItem = {
		title: clip(form.get("title"), 200),
		text: clip(form.get("text"), 20_000),
		url: clip(form.get("url"), 2000),
		files: [],
		problems: [],
	};
	const files = form.getAll("files").filter((entry): entry is File => typeof entry !== "string" && entry.size > 0);
	// Text too long for an address is kept as a text file, and the capture page offers that file instead.
	if (shared.text.length > MAX_SHARED_TEXT_CHARS) {
		files.push(new File([shared.text], "shared-text.txt", { type: "text/plain" }));
		shared.text = "";
	}
	for (const file of files) {
		const outcome = await forward(file, request, deps);
		if ("file" in outcome) shared.files.push(outcome.file);
		else shared.problems.push(`${file.name}: ${outcome.problem}`);
	}
	return new Response(null, { status: 303, headers: { location: captureUrl(shared) } });
}

async function forward(
	file: File,
	request: Request,
	deps: ShareDeps,
): Promise<{ file: AttachmentRef } | { problem: string }> {
	const body = new FormData();
	body.set("file", file, file.name);
	const headers = new Headers();
	for (const name of ["tailscale-user-login", "sec-fetch-site"]) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	// The API compares the host the browser used with the names it answers to; this request's own Host is the API's.
	const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
	if (host !== null) headers.set("x-forwarded-host", host);
	try {
		const response = await deps.fetch(`${deps.apiOrigin}/api/uploads`, { method: "POST", headers, body });
		const parsed = (await response.json().catch(() => undefined)) as Partial<UploadResponse & ApiErrorBody> | undefined;
		if (response.ok && parsed?.file !== undefined) {
			const { id, name, mime, size } = parsed.file;
			return { file: { id, name, mime, size } };
		}
		return { problem: parsed?.error?.message ?? `the server answered ${response.status}.` };
	} catch {
		return { problem: "the assistant server could not be reached." };
	}
}

/** The capture page, with what was shared in its address. */
export function captureUrl(shared: SharedItem): string {
	const params = new URLSearchParams();
	if (shared.title !== "") params.set("title", shared.title);
	if (shared.text !== "") params.set("text", shared.text);
	if (shared.url !== "") params.set("url", shared.url);
	if (shared.files.length > 0) params.set("files", JSON.stringify(shared.files));
	for (const problem of shared.problems) params.append("problem", problem.slice(0, 300));
	const query = params.toString();
	return query === "" ? "/capture" : `/capture?${query}`;
}

/** What the capture page shows, read back from its address. Anything malformed is left out rather than trusted. */
export function readCapture(params: URLSearchParams): SharedItem {
	let files: AttachmentRef[] = [];
	try {
		const parsed: unknown = JSON.parse(params.get("files") ?? "[]");
		if (Array.isArray(parsed)) {
			files = parsed.flatMap((item): AttachmentRef[] => {
				const entry = item as Partial<AttachmentRef> | null;
				// The name ends up inside a line of the message, so it may not carry a line break or a bracket.
				return typeof entry?.id === "string" &&
					/^fi_[0-9a-f]{8}$/.test(entry.id) &&
					typeof entry.name === "string" &&
					typeof entry.mime === "string" &&
					/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(entry.mime) &&
					typeof entry.size === "number" &&
					Number.isFinite(entry.size)
					? [
							{
								id: entry.id,
								name:
									entry.name
										.replace(/[\r\n[\]·]+/g, " ")
										.trim()
										.slice(0, 100) || "file",
								mime: entry.mime,
								size: entry.size,
							},
						]
					: [];
			});
		}
	} catch {
		// A broken list is no list.
	}
	return {
		title: params.get("title") ?? "",
		text: params.get("text") ?? "",
		url: params.get("url") ?? "",
		files,
		problems: params.getAll("problem"),
	};
}

/** The message a share becomes: title, text and link as lines, and the files by reference. */
export function shareText(shared: Pick<SharedItem, "title" | "text" | "url">): string {
	const lines = [shared.title, shared.text, shared.url].filter((line) => line !== "");
	return [...new Set(lines)].join("\n");
}
