import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppDb } from "@assistant/db";
import { fileStore, judgeUpload, safeName } from "@assistant/extensions";
import { MAX_UPLOAD_BYTES, type UploadResponse } from "@assistant/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isInside } from "../paths.ts";
import { ApiError, errorBody, invalidRequest, notFound } from "./errors.ts";

/** What a multipart body adds to the file itself: boundaries and the headers of the parts. Generous, and still small. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export type UploadsDeps = {
	db: AppDb;
	/** `<data>/files`, resolved through symbolic links. Uploads live below it and nowhere else. */
	filesDir: string;
	/** `<data>/workspace`, resolved: the files the assistant made (invoice PDFs) live below it. Absent: none is served. */
	workspaceDir?: string;
	now?: () => number;
};

/**
 * `POST /api/uploads`: the one route of the API that is not JSON, and `GET /api/files/:id`, which gives an upload back.
 *
 * A multipart body cannot satisfy the JSON-only rule that protects every other write (`requireJsonContentType`): a page
 * on any website can submit a multipart form to this server from the owner's browser. So this route is an explicit
 * exception, registered before that rule on purpose and never by loosening it, and it stands on three others instead:
 *
 * 1. the `Host` allowlist and the refusal of `Sec-Fetch-Site: cross-site`, which every API request passes first;
 * 2. `Sec-Fetch-Site` is **required** here, and must be `same-origin` or `none` (see {@link requireBrowserOrigin});
 * 3. only `multipart/form-data` is accepted, and the file is judged by its content, never by its name.
 *
 * (`docs/design-notes.md`, "Uploads".)
 */
export function createUploadsApp(deps: UploadsDeps): Hono {
	const app = new Hono();
	const now = deps.now ?? Date.now;

	app.post(
		"/",
		requireBrowserOrigin,
		requireMultipart,
		bodyLimit({
			maxSize: MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES,
			onError: (c) =>
				c.json(
					errorBody(
						"payload_too_large",
						`The upload is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB, the most the assistant takes. Send a smaller file, or split it.`,
					),
					413,
				),
		}),
		async (c) => {
			const file = await readUploadedFile(c.req.raw);
			if (file.size > MAX_UPLOAD_BYTES) {
				throw new ApiError(
					413,
					"payload_too_large",
					`'${file.name.slice(0, 60)}' is ${(file.size / 1024 / 1024).toFixed(1)} MB; the most the assistant takes is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
				);
			}
			const bytes = new Uint8Array(await file.arrayBuffer());
			const verdict = judgeUpload(bytes, file.name);
			if (!verdict.ok) throw new ApiError(415, "invalid_request", verdict.reason);

			const id = fileStore.freshFileId(deps.db);
			const name = safeName(file.name, verdict.detected.ext);
			const stored = await storeFile(deps.filesDir, id, name, bytes, now());
			try {
				const { row } = fileStore.registerFile(deps.db, {
					id,
					path: stored,
					name,
					mime: verdict.detected.mime,
					kind: verdict.detected.kind,
					size: bytes.length,
					source: "upload",
					now: now(),
				});
				const body: UploadResponse = { file: fileStore.toSummary(row) };
				return c.json(body, 201);
			} catch (error) {
				// A file with no row is invisible to everyone and would stay on disk for ever.
				await rm(stored, { force: true });
				throw error;
			}
		},
	);

	return app;
}

/**
 * `GET /api/files/:id`: a file the assistant keeps for the owner as it was stored: an upload (from below the uploads
 * folder) or a file it made itself, such as an invoice PDF (from below the workspace). A file the PA indexed from the
 * owner's own folders is not the browser's business, and a row whose file moved outside the folder it must be in is
 * not served: the path is resolved again at every request. Whatever the file is, the browser is told not to guess:
 * images are shown, everything else is a download, and a sandboxing policy makes even a file the browser opens unable to
 * run anything.
 */
export function createFilesApp(deps: UploadsDeps): Hono {
	const app = new Hono();
	app.get("/:id", async (c) => {
		const row = fileStore.getFile(deps.db, c.req.param("id"));
		const root = row?.source === "upload" ? deps.filesDir : row?.source === "generated" ? deps.workspaceDir : undefined;
		if (row === undefined || root === undefined) {
			throw notFound(`No uploaded file has the id '${c.req.param("id").slice(0, 40)}'.`);
		}
		const real = await realpath(row.path).catch(() => undefined);
		if (real === undefined || !isInside(root, real)) {
			throw notFound("The file is no longer where the assistant stored it.");
		}
		const content = await readFile(real);
		const inline = row.kind === "image";
		return c.body(new Uint8Array(content), 200, {
			"content-type": row.kind === "text" || row.kind === "csv" ? `${row.mime}; charset=utf-8` : row.mime,
			"content-length": String(content.length),
			"content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
			"cache-control": "private, max-age=31536000, immutable",
		});
	});
	return app;
}

/**
 * `Sec-Fetch-Site` must be present and say `same-origin` (the assistant's own page) or `none` (the owner typed the address,
 * or the Android share sheet delivered a file). Elsewhere a missing header means "an old browser, or curl" and is allowed
 * because the JSON-only rule covers it; here nothing covers it, so a client without the header is refused. curl callers add
 * `-H 'Sec-Fetch-Site: none'`. A `cross-site` value never gets here: the guard in front refuses it.
 */
export const requireBrowserOrigin: MiddlewareHandler = async (c, next) => {
	const site = c.req.header("sec-fetch-site");
	if (site !== "same-origin" && site !== "none") {
		throw new ApiError(
			403,
			"forbidden",
			site === undefined
				? "Uploads must come from the assistant's own page: the request has no Sec-Fetch-Site header. From a script, add the header 'Sec-Fetch-Site: none'."
				: `Refused an upload that the browser marked as coming from another site (Sec-Fetch-Site: ${site.slice(0, 40)}). Use the assistant from its own address.`,
		);
	}
	await next();
};

/** Only a multipart form: a JSON body is the wrong shape for this route, as a multipart one is for every other. */
export const requireMultipart: MiddlewareHandler = async (c, next) => {
	if (!/^multipart\/form-data\s*;\s*boundary=/i.test(c.req.header("content-type") ?? "")) {
		throw new ApiError(
			415,
			"invalid_request",
			"POST /api/uploads takes a multipart/form-data body with the file in a field named 'file'.",
		);
	}
	await next();
};

/** The `file` field of a multipart body, or what to fix. */
async function readUploadedFile(request: Request): Promise<File> {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		throw invalidRequest("The multipart body could not be read. Send one file in a form field named 'file'.");
	}
	const file = form.get("file");
	if (!(file instanceof File)) throw invalidRequest("Send the file in a form field named 'file'.");
	return file;
}

/**
 * `<files>/<yyyy-mm>/<id>-<safe name>`, written to a temporary name first and renamed, so that a crash leaves no half
 * file under a real name. The id is the server's, the name is cleaned, and the folder is the server's too: nothing the
 * sender wrote reaches the path.
 */
async function storeFile(filesDir: string, id: string, name: string, bytes: Uint8Array, at: number): Promise<string> {
	const folder = join(filesDir, new Date(at).toISOString().slice(0, 7));
	const final = join(folder, `${id}-${name}`);
	await mkdir(folder, { recursive: true, mode: 0o700 });
	const partial = `${final}.part`;
	try {
		await writeFile(partial, bytes, { flag: "wx", mode: 0o600 });
		await rename(partial, final);
	} catch (error) {
		// A full disk fails the write, a rename can fail too: neither may leave the temporary file behind.
		// Unless the name was taken by another file's temporary: that one is not ours to remove.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") await rm(partial, { force: true });
		throw error;
	}
	if (dirname(final) !== folder) throw new Error("A stored file left its folder. This should be impossible.");
	return final;
}
