import type { FileKind } from "@assistant/shared";
import { OFFICE_DOCUMENTS } from "./convert.ts";

/**
 * What a file is, decided from its first bytes and never from its name or the type the sender claimed: a browser
 * reports whatever the file extension says, and an extension is chosen by whoever made the file.
 */
export type Detected = {
	kind: FileKind;
	/** Only types the server stores and serves back: raster images, PDF, Office documents, CSV and plain text. */
	mime: string;
	/** The extension a stored file gets, whatever it was called. */
	ext: string;
};

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
	signature.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** How many bytes of the start are enough to tell a PDF (its header may follow up to 1 KiB of other bytes) from the rest. */
export const SNIFF_BYTES = 8192;

/** A raster image or a PDF, by its signature. SVG is not on the list: it is a document that can carry scripts. */
export function detectBinary(head: Uint8Array): Detected | undefined {
	if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return { kind: "image", mime: "image/png", ext: "png" };
	if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
	if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))) {
		return { kind: "image", mime: "image/gif", ext: "gif" };
	}
	if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) {
		return { kind: "image", mime: "image/webp", ext: "webp" };
	}
	const header = ascii("%PDF-");
	for (let at = 0; at + header.length <= Math.min(head.length, 1024); at++) {
		if (startsWith(head, header, at)) return { kind: "pdf", mime: "application/pdf", ext: "pdf" };
	}
	return undefined;
}

/**
 * An Office document (Word, Excel, PowerPoint, OpenDocument), which the assistant reads by converting it to PDF. Its
 * name says which kind, and its first bytes must agree: a ZIP container for the modern formats, OLE for the old ones.
 */
export function detectOffice(head: Uint8Array, name: string | undefined): Detected | undefined {
	const ext = /\.([a-z]{3,4})$/i.exec(name ?? "")?.[1]?.toLowerCase();
	const mime = ext === undefined || ext === "rtf" ? undefined : OFFICE_DOCUMENTS[ext];
	if (ext === undefined || mime === undefined) return undefined;
	const zip = startsWith(head, [0x50, 0x4b, 0x03, 0x04]);
	const ole = startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
	const old = ext === "doc" || ext === "xls" || ext === "ppt";
	return (old ? ole : zip) ? { kind: "other", mime, ext } : undefined;
}

/** No NUL byte in the start: the quick test of whether a file is text at all. */
export const hasNoNul = (head: Uint8Array): boolean => !head.includes(0);

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

export type UploadVerdict = { ok: true; detected: Detected } | { ok: false; reason: string };

/**
 * Decide whether an upload is stored, and as what. Images and PDFs are told by their signature; anything else must be
 * UTF-8 text without NUL bytes, and is a CSV when the sender named it `.csv`, plain text otherwise. A file that holds a
 * private key is refused even as text: the rules keep `*.pem` and `*.key` away from the assistant, and an upload must not
 * be a way around them.
 */
export function judgeUpload(bytes: Uint8Array, name: string): UploadVerdict {
	if (bytes.length === 0) return { ok: false, reason: "The file is empty." };
	const binary = detectBinary(bytes.subarray(0, SNIFF_BYTES));
	if (binary !== undefined) return { ok: true, detected: binary };
	const office = detectOffice(bytes.subarray(0, SNIFF_BYTES), name);
	if (office !== undefined) return { ok: true, detected: office };
	if (!hasNoNul(bytes.subarray(0, SNIFF_BYTES))) return hasUtf16Mark(bytes) ? anotherEncoding() : notSupported();
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return anotherEncoding();
	}
	if (PRIVATE_KEY.test(text.slice(0, 64 * 1024))) {
		return {
			ok: false,
			reason: "The file looks like a private key. Keys are never stored where the assistant can read them.",
		};
	}
	return /\.csv$/i.test(name)
		? { ok: true, detected: { kind: "csv", mime: "text/csv", ext: "csv" } }
		: { ok: true, detected: { kind: "text", mime: "text/plain", ext: "txt" } };
}

/** A byte order mark of UTF-16: what Excel's "Unicode text" export and some bank downloads start with. */
const hasUtf16Mark = (bytes: Uint8Array): boolean =>
	(bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);

function anotherEncoding(): UploadVerdict {
	return {
		ok: false,
		reason:
			"This file is not UTF-8 text. If it is a CSV or text file in another encoding (bank exports are often Windows-1252 " +
			"or UTF-16), export or save it as UTF-8 and upload it again.",
	};
}

function notSupported(): UploadVerdict {
	return {
		ok: false,
		reason:
			"Only images (PNG, JPEG, GIF, WebP), PDF, Office documents (Word, Excel, PowerPoint, OpenDocument), CSV and plain text files can be uploaded. This file is none of them.",
	};
}

/**
 * A name that is safe to keep on disk and to put in a header: letters, digits, dots, dashes and underscores (of any
 * script), at most 80 characters, no leading dot, and the extension of what the file really is.
 */
export function safeName(original: string, ext: string): string {
	const stem = original
		.replace(/^.*[\\/]/, "")
		.replace(/\.[A-Za-z0-9]{1,8}$/, "")
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}._-]+/gu, "_")
		.replace(/^[._-]+/, "")
		.replace(/_{2,}/g, "_");
	// Cut on characters, not UTF-16 units: a name must not end in half of a surrogate pair.
	const cut = Array.from(stem).slice(0, 80).join("");
	return `${cut === "" ? "file" : cut}.${ext}`;
}

/** Width and height from the header of a PNG, JPEG, GIF or WebP, without decoding it. Undefined when the header cannot be read. */
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const at = (offset: number, length: number): boolean => offset + length <= bytes.length;
	if (mime === "image/png" && at(16, 8)) return { width: view.getUint32(16), height: view.getUint32(20) };
	if (mime === "image/gif" && at(6, 4)) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	if (mime === "image/webp" && at(12, 4)) {
		const chunk = String.fromCharCode(...bytes.subarray(12, 16));
		if (chunk === "VP8 " && at(26, 4))
			return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
		if (chunk === "VP8L" && at(21, 4)) {
			const bits = view.getUint32(21, true);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}
		if (chunk === "VP8X" && at(24, 6)) {
			const le24 = (from: number): number =>
				(bytes[from] ?? 0) | ((bytes[from + 1] ?? 0) << 8) | ((bytes[from + 2] ?? 0) << 16);
			return { width: le24(24) + 1, height: le24(27) + 1 };
		}
		return undefined;
	}
	if (mime === "image/jpeg") {
		// Walk the segments to the first start-of-frame marker (not DHT, JPG or DAC), which holds the size.
		let offset = 2;
		while (at(offset, 4) && bytes[offset] === 0xff) {
			const marker = bytes[offset + 1] ?? 0;
			if (marker === 0xff) {
				offset++;
				continue;
			}
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return at(offset + 4, 5)
					? { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
					: undefined;
			}
			offset += 2 + view.getUint16(offset + 2);
		}
	}
	return undefined;
}
