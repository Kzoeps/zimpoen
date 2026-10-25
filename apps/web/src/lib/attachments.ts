import { type AttachmentRef, type FileSummary, formatSize, MAX_UPLOAD_BYTES } from "@assistant/shared";

/**
 * The files the owner is attaching to the message they are writing, from the moment they pick one until the message is
 * sent. Pure state, so every transition is testable without a browser: the composer calls these and keeps the list.
 */
export type Attachment = {
	/** Local key: the file has no id until the server has stored it. */
	key: string;
	name: string;
	size: number;
	status: "uploading" | "ready" | "error";
	/** 0 to 1, while uploading. */
	progress: number;
	/** What the server stored, once it has. */
	file?: FileSummary;
	/** Why it failed, in words for the owner. */
	error?: string;
};

/** How many files one message may carry. A phone share sheet can offer many; a message that names fifty files is not one. */
export const MAX_ATTACHMENTS = 10;

/** Why a file is not even tried, or undefined when it is. The server decides again from the content. */
export function refusal(file: { name: string; size: number }, current: readonly Attachment[]): string | undefined {
	if (current.length >= MAX_ATTACHMENTS) {
		return `A message can carry ${MAX_ATTACHMENTS} files. Send this one first, then attach “${file.name}” to the next.`;
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		return `“${file.name}” is ${formatSize(file.size)}; the most the assistant takes is ${formatSize(MAX_UPLOAD_BYTES)}.`;
	}
	if (file.size === 0) return `“${file.name}” is empty.`;
	return undefined;
}

export const started = (
	list: readonly Attachment[],
	key: string,
	file: { name: string; size: number },
): Attachment[] => [...list, { key, name: file.name, size: file.size, status: "uploading", progress: 0 }];

export const progressed = (list: readonly Attachment[], key: string, progress: number): Attachment[] =>
	list.map((item) => (item.key === key && item.status === "uploading" ? { ...item, progress } : item));

export const finished = (list: readonly Attachment[], key: string, file: FileSummary): Attachment[] =>
	list.map((item) =>
		item.key === key ? { key, name: file.name, size: file.size, status: "ready", progress: 1, file } : item,
	);

export const failed = (list: readonly Attachment[], key: string, error: string): Attachment[] =>
	list.map((item) => (item.key === key ? { ...item, status: "error", error } : item));

export const removed = (list: readonly Attachment[], key: string): Attachment[] =>
	list.filter((item) => item.key !== key);

export const isUploading = (list: readonly Attachment[]): boolean => list.some((item) => item.status === "uploading");

/** The stored files the message will reference, in the order they were attached. */
export function attached(list: readonly Attachment[]): AttachmentRef[] {
	return list.flatMap((item) =>
		item.status === "ready" && item.file !== undefined
			? [{ id: item.file.id, name: item.file.name, mime: item.file.mime, size: item.file.size }]
			: [],
	);
}
