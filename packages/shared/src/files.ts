/**
 * Files the owner gives the assistant: uploads from the composer or the Android share sheet, and files the PA found in
 * the folders it may read. What the browser and the server both need to know about them lives here.
 */

/** Largest upload, in bytes. The server refuses more with 413 before it reads the file. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * What a file is, decided by looking at its content, never at its name or the type the sender claimed. An upload is one of
 * the first four; `other` is a binary file the PA found in an allowed folder and cannot read.
 */
export type FileKind = "image" | "pdf" | "csv" | "text" | "other";

/** The `accept` list of the file picker: what the server takes (the server decides again from the content). */
export const UPLOAD_ACCEPT =
	"image/png,image/jpeg,image/gif,image/webp,application/pdf,text/csv,text/plain,.csv,.txt,.md";

/** A file in the index, as the API and the tools' cards describe it. */
export type FileSummary = {
	/** `fi_` and eight hex digits: what the tools and the message reference take. */
	id: string;
	/** The sanitised name the file is shown by. */
	name: string;
	/** The type found by sniffing the content, for example `image/jpeg`, `text/csv`. */
	mime: string;
	kind: FileKind;
	size: number;
	description?: string;
	tags?: string[];
	/** An upload, or a file the PA found in an allowed folder. */
	source: "upload" | "path";
	addedAt: number;
};

/** `POST /api/uploads`: the file as stored. */
export type UploadResponse = { file: FileSummary };

/** What a message needs to say about an attached file: enough for the model to call `read_file`, and for a chip. */
export type AttachmentRef = { id: string; name: string; mime: string; size: number };

/** `1.2 MB`, `340 KB`, `12 B`: sizes for people. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ATTACHMENT_LINE =
	/^\[Attached file: (.+) · ([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+) · (\d+(?:\.\d)? (?:B|KB|MB)) · id (fi_[0-9a-f]{8})\]$/;

/** The line that references one attached file in a message. {@link splitAttachments} reads it back. */
export function attachmentLine(file: AttachmentRef): string {
	return `[Attached file: ${file.name} · ${file.mime} · ${formatSize(file.size)} · id ${file.id}]`;
}

/** The message text with one reference line per file after it. The model reads the lines and opens a file with `read_file`. */
export function withAttachments(text: string, files: readonly AttachmentRef[]): string {
	if (files.length === 0) return text;
	const lines = files.map(attachmentLine).join("\n");
	return text.trim() === "" ? lines : `${text.trimEnd()}\n\n${lines}`;
}

/**
 * The reverse of {@link withAttachments}: the text of a message and the files its trailing lines reference. A line that
 * is not exactly in that form stays part of the text. The size is shown text only, so it comes back approximate.
 */
export function splitAttachments(content: string): {
	text: string;
	files: Array<AttachmentRef & { sizeText: string }>;
} {
	const lines = content.split("\n");
	const files: Array<AttachmentRef & { sizeText: string }> = [];
	while (lines.length > 0) {
		const match = ATTACHMENT_LINE.exec(lines.at(-1) ?? "");
		if (match === null) break;
		const [, name = "", mime = "", sizeText = "", id = ""] = match;
		files.unshift({ id, name, mime, size: 0, sizeText });
		lines.pop();
	}
	return { text: lines.join("\n").trimEnd(), files };
}

/** The card of `describe_file`: the file after the PA wrote down what it is. */
export type FileCard = {
	type: "file";
	event: "described" | "registered";
	file: FileSummary;
};

/** The card of `search_files`. */
export type FileListCard = {
	type: "file_list";
	heading: string;
	files: FileSummary[];
	total: number;
};
