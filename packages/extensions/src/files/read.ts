import type { Context } from "@earendil-works/chord";
import { type BinaryReader, type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { detectBinary, hasNoNul, imageSize, SNIFF_BYTES } from "./sniff.ts";

/** Lines of a text or CSV file shown at once. The model continues with `offset`. */
export const DEFAULT_TEXT_LINES = 200;
export const MAX_TEXT_LINES = 2000;
/** Bytes of text shown at once, whatever the line limit: a CSV with one enormous line must not fill the context. */
export const MAX_TEXT_BYTES = 32 * 1024;
/** The largest image read: a phone photo is a few MB, and the file is held in memory while it is prepared. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/**
 * The most pixels an image may have before the decoder sees it. A few kilobytes of PNG can declare 20000x20000 pixels,
 * and decoding takes 4 bytes a pixel (1.6 GB) in memory: the process would die, and Durable would run the same read again
 * after every restart. 100 megapixels (400 MB) still takes a 50 or 108 megapixel phone photo.
 */
export const MAX_IMAGE_PIXELS = 100_000_000;

/** What reading a file for the model found. */
export type ReadOutcome =
	| {
			type: "image";
			mime: string;
			size: number;
			/** Base64, prepared for the model (turned upright, shrunk to fit). */
			data: string;
			mimeType: string;
			notes: string[];
	  }
	| {
			type: "text";
			kind: "csv" | "text";
			mime: string;
			size: number;
			text: string;
			/** 1-based, as `offset` takes them. `lastLine` is 0 for an empty file. */
			firstLine: number;
			lastLine: number;
			totalLines: number;
			/** 1-based number of a line that is longer than the cap and shown only in part: its end is not available. */
			truncatedLine?: number;
	  }
	| { type: "unreadable"; kind: "pdf" | "other"; mime: string; size: number; reason: string };

type TextOutcome = Extract<ReadOutcome, { type: "text" }>;

export type ReadOptions = {
	/** First line to show, 1-based. */
	offset?: number | undefined;
	limit?: number | undefined;
	/** Resizes and turns images upright. Without one, an image that already fits is passed as it is. */
	images?: ImageProcessor | undefined;
	/** A name the file is called by, for `.csv` files, since a CSV is text that only its name distinguishes. */
	name?: string | undefined;
};

const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

/**
 * Read a file for the model through the call's environment, so the path policy (allowed folders, deny list, symbolic links
 * resolved) applies to every read; this never opens a path itself. Images become one image block the model can look at
 * (a receipt), text and CSV a bounded window of lines, and what cannot be read says why. Throws what the environment
 * refused, with its message: that is what the model is told.
 */
export async function readForModel(
	env: ExecutionEnv,
	path: string,
	options: ReadOptions,
	context: Context,
): Promise<ReadOutcome> {
	const reader = getOrThrow(await env.openBinaryReader(path, undefined, context));
	try {
		const info = getOrThrow(await reader.info(context));
		const head = getOrThrow(await reader.read(0, Math.min(info.size, SNIFF_BYTES), context));
		const binary = detectBinary(head);

		if (binary?.kind === "image") {
			if (info.size > MAX_IMAGE_BYTES) {
				throw new Error(
					`The image is ${(info.size / 1024 / 1024).toFixed(1)} MB, more than the ${MAX_IMAGE_BYTES / 1024 / 1024} MB that can be read.`,
				);
			}
			const bytes = getOrThrow(await reader.read(0, info.size, context));
			return await readImage(bytes, binary.mime, options.images);
		}
		if (binary?.kind === "pdf") {
			return {
				type: "unreadable",
				kind: "pdf",
				mime: binary.mime,
				size: info.size,
				reason:
					"This is a PDF, and the assistant cannot read the text of a PDF yet. Ask the owner for a photo of the page, " +
					"a CSV export, or the text itself.",
			};
		}
		if (!hasNoNul(head)) {
			return {
				type: "unreadable",
				kind: "other",
				mime: "application/octet-stream",
				size: info.size,
				reason: "This is a binary file of a kind the assistant cannot read.",
			};
		}
		return await readText(reader, info.size, options, context);
	} finally {
		await reader.close(context);
	}
}

async function readImage(bytes: Uint8Array, mime: string, images: ImageProcessor | undefined): Promise<ReadOutcome> {
	const notes: string[] = [];
	if (images === undefined) {
		if (base64Length(bytes.length) > DEFAULT_IMAGE_LIMITS.maxBytes) {
			throw new Error("The image is too large to send to the model, and no image processor is available to shrink it.");
		}
		return {
			type: "image",
			mime,
			size: bytes.length,
			data: Buffer.from(bytes).toString("base64"),
			mimeType: mime,
			notes,
		};
	}
	const size = imageSize(bytes, mime);
	if (size !== undefined && size.width * size.height > MAX_IMAGE_PIXELS) {
		throw new Error(
			`The image is ${size.width}x${size.height} pixels, more than the ${MAX_IMAGE_PIXELS / 1_000_000} megapixels that can be read. ` +
				"Ask the owner for a smaller copy, or a screenshot.",
		);
	}
	const prepared = await images.prepare(bytes, mime, DEFAULT_IMAGE_LIMITS);
	if (prepared === undefined)
		throw new Error(`The ${mime} image cannot be decoded or made small enough for the model.`);
	if (prepared.convertedFrom !== undefined)
		notes.push(`Converted from ${prepared.convertedFrom} to ${prepared.mimeType}.`);
	if (prepared.resized !== undefined) {
		const { from, to } = prepared.resized;
		notes.push(`Shrunk from ${from.width}x${from.height} to ${to.width}x${to.height} pixels.`);
	}
	return { type: "image", mime, size: bytes.length, data: prepared.data, mimeType: prepared.mimeType, notes };
}

async function readText(
	reader: BinaryReader,
	size: number,
	options: ReadOptions,
	context: Context,
): Promise<ReadOutcome> {
	const kind = options.name !== undefined && /\.csv$/i.test(options.name) ? "csv" : "text";
	const mime = kind === "csv" ? "text/csv" : "text/plain";
	if (size === 0) return { type: "text", kind, mime, size, text: "", firstLine: 1, lastLine: 0, totalLines: 0 };

	const startLine = Math.max(0, Math.trunc(options.offset ?? 1) - 1);
	const lineLimit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_TEXT_LINES), 1), MAX_TEXT_LINES);
	const scan = getOrThrow(await reader.scanLines({ startLine, endLine: startLine + lineLimit }, context));
	const last = getOrThrow(await reader.read(size - 1, 1, context));
	const totalLines = scan.newlines + (last[0] === 0x0a ? 0 : 1);
	if (startLine >= totalLines) {
		throw new Error(
			`offset ${startLine + 1} is beyond the end of the file, which has ${totalLines} line${totalLines === 1 ? "" : "s"}.`,
		);
	}
	// `scanLines` leaves out the newline that ends the window's last line, so a blank line selects no bytes at all: the
	// lines shown are counted from the window, never from the text.
	const inWindow = Math.min(lineLimit, totalLines - startLine);
	const windowBytes = scan.end - scan.start;
	const shape: Omit<TextOutcome, "text" | "lastLine" | "truncatedLine"> = {
		type: "text",
		kind,
		mime,
		size,
		firstLine: startLine + 1,
		totalLines,
	};
	if (windowBytes <= MAX_TEXT_BYTES) {
		const bytes =
			windowBytes === 0 ? new Uint8Array() : getOrThrow(await reader.read(scan.start, windowBytes, context));
		const whole = new TextDecoder("utf-8").decode(bytes);
		// A window that runs to the end of the file takes the file's final newline: that ends a line, it is not another one.
		const text = scan.end === size && whole.endsWith("\n") ? whole.slice(0, -1) : whole;
		return { ...shape, text, lastLine: startLine + inWindow };
	}
	// Over the cap: whole lines only, so that a row of a CSV is never cut in half and reported as shown.
	const bytes = getOrThrow(await reader.read(scan.start, MAX_TEXT_BYTES, context));
	const cut = bytes.lastIndexOf(0x0a);
	if (cut < 0) {
		// The first line alone is longer than the cap: its beginning is shown, and the answer says the rest is not.
		const part = new TextDecoder("utf-8").decode(bytes).replace(/\uFFFD$/, "");
		return { ...shape, text: part, lastLine: startLine + 1, truncatedLine: startLine + 1 };
	}
	const kept = bytes.subarray(0, cut);
	const lines = kept.reduce((count, byte) => (byte === 0x0a ? count + 1 : count), 1);
	return { ...shape, text: new TextDecoder("utf-8").decode(kept), lastLine: startLine + lines };
}
