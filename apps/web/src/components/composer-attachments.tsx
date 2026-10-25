"use client";

import { type AttachmentRef, UPLOAD_ACCEPT } from "@assistant/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, uploadFile } from "../lib/api.ts";
import {
	type Attachment,
	attached,
	failed,
	finished,
	isUploading,
	progressed,
	refusal,
	removed,
	started,
} from "../lib/attachments.ts";

export type AttachmentsState = {
	list: readonly Attachment[];
	/** The files of the message being written, ready to be named in it. */
	ready: AttachmentRef[];
	uploading: boolean;
	add(files: readonly File[]): void;
	remove(key: string): void;
	/** Forget them all: the message went. */
	clear(): void;
	/** The same, readable from a callback that was made earlier (what `onNew` needs). */
	current(): readonly Attachment[];
};

/**
 * The files the owner is attaching to the message they are writing: each uploads as soon as it is picked, with its own
 * progress, so that sending is only naming files that are already stored. An upload still running when the thread is
 * left (another agent, a closed tab) is stopped.
 */
export function useAttachments(): AttachmentsState {
	const [list, setList] = useState<readonly Attachment[]>([]);
	const latest = useRef<readonly Attachment[]>([]);
	const running = useRef(new Map<string, () => void>());
	const counter = useRef(0);

	const update = useCallback((change: (current: readonly Attachment[]) => Attachment[]) => {
		latest.current = change(latest.current);
		setList(latest.current);
	}, []);

	const add = useCallback(
		(files: readonly File[]) => {
			for (const file of files) {
				const problem = refusal(file, latest.current);
				const key = `upload-${++counter.current}`;
				update((current) => started(current, key, file));
				if (problem !== undefined) {
					update((current) => failed(current, key, problem));
					continue;
				}
				const upload = uploadFile(file, (fraction) => update((current) => progressed(current, key, fraction)));
				running.current.set(key, upload.abort);
				upload.done.then(
					(response) => update((current) => finished(current, key, response.file)),
					(error: unknown) => {
						// A removed attachment is gone from the list already; there is nothing to mark.
						if (error instanceof ApiRequestError && error.code === "aborted") return;
						update((current) =>
							failed(current, key, error instanceof ApiRequestError ? error.message : "The upload failed."),
						);
					},
				);
				void upload.done.finally(() => running.current.delete(key)).catch(() => {});
			}
		},
		[update],
	);

	const remove = useCallback(
		(key: string) => {
			running.current.get(key)?.();
			update((current) => removed(current, key));
		},
		[update],
	);

	const clear = useCallback(() => update(() => []), [update]);

	useEffect(() => {
		const stops = running.current;
		return () => {
			for (const stop of stops.values()) stop();
		};
	}, []);

	return useMemo(
		() => ({
			list,
			ready: attached(list),
			uploading: isUploading(list),
			add,
			remove,
			clear,
			current: () => latest.current,
		}),
		[list, add, remove, clear],
	);
}

/** The paperclip. Opens the file picker; the files start uploading at once. */
export function AttachButton({ attachments }: { attachments: AttachmentsState }) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<button
				type="button"
				className="composer__attach"
				aria-label="Attach a file"
				title="Attach a file: an image, PDF, CSV or text file, up to 20 MB"
				onClick={() => input.current?.click()}
			>
				📎
			</button>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				accept={UPLOAD_ACCEPT}
				onChange={(event) => {
					attachments.add([...(event.target.files ?? [])]);
					// The same file can be picked again after it was removed.
					event.target.value = "";
				}}
			/>
		</>
	);
}

/** What is attached to the message being written: each file with its progress, a way to take it off, and why it failed. */
export function AttachmentTray({ attachments }: { attachments: AttachmentsState }) {
	if (attachments.list.length === 0) return null;
	return (
		<ul className="attachments" aria-label="Attached files">
			{attachments.list.map((item) => (
				<li key={item.key} className={`attachment attachment--${item.status}`}>
					<span className="attachment__name">{item.name}</span>
					{item.status === "uploading" ? (
						<progress
							className="attachment__progress"
							max={1}
							value={item.progress}
							aria-label={`Uploading ${item.name}`}
						/>
					) : null}
					{item.status === "error" ? (
						<span className="attachment__error" role="alert">
							{item.error}
						</span>
					) : null}
					<button
						type="button"
						className="attachment__remove"
						aria-label={`Remove ${item.name}`}
						onClick={() => attachments.remove(item.key)}
					>
						✕
					</button>
				</li>
			))}
		</ul>
	);
}
