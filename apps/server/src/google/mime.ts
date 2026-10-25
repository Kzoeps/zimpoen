import type { GmailMessage } from "@assistant/extensions";

/**
 * Gmail's message resource (`format=full`) as the text the assistant keeps: the headers it needs, decoded, and the readable
 * text of the body. Everything here reads untrusted input of any size, so it works in one pass over bounded text and no
 * pattern in it can backtrack.
 */

type Header = { name?: string; value?: string };
type Part = {
	mimeType?: string;
	filename?: string;
	headers?: Header[];
	body?: { data?: string; size?: number; attachmentId?: string };
	parts?: Part[];
};
export type RawGmailMessage = {
	id?: string;
	threadId?: string;
	labelIds?: string[];
	snippet?: string;
	internalDate?: string;
	payload?: Part;
};

/** The most of one body part that is decoded: a mail that is megabytes of HTML is not read in full. */
const MAX_PART_BYTES = 256 * 1024;
const MAX_PARTS = 200;
const MAX_DEPTH = 8;

export function header(part: Part | undefined, name: string): string {
	const wanted = name.toLowerCase();
	return part?.headers?.find((candidate) => candidate.name?.toLowerCase() === wanted)?.value ?? "";
}

function decodeBytes(bytes: Buffer, charset: string): string {
	try {
		return new TextDecoder(charset.trim().toLowerCase() || "utf-8").decode(bytes);
	} catch {
		return bytes.toString("utf8");
	}
}

/** RFC 2047 encoded words (`=?UTF-8?B?...?=`, `=?ISO-8859-1?Q?...?=`) in a header, decoded. Words next to each other join without the space between them. */
export function decodeMimeWords(value: string): string {
	const bounded = value.length > 4000 ? value.slice(0, 4000) : value;
	let previousEncoded = false;
	let output = "";
	let index = 0;
	while (index < bounded.length) {
		const start = bounded.indexOf("=?", index);
		if (start === -1) {
			output += bounded.slice(index);
			break;
		}
		const between = bounded.slice(index, start);
		const decoded = decodeWordAt(bounded, start);
		if (decoded === undefined) {
			output += between + bounded.slice(start, start + 2);
			previousEncoded = false;
			index = start + 2;
			continue;
		}
		if (!(previousEncoded && between.trim() === "")) output += between;
		output += decoded.text;
		previousEncoded = true;
		index = decoded.end;
	}
	return output;
}

function decodeWordAt(text: string, start: number): { text: string; end: number } | undefined {
	const charsetEnd = text.indexOf("?", start + 2);
	if (charsetEnd === -1) return undefined;
	const encoding = text[charsetEnd + 1]?.toLowerCase();
	if ((encoding !== "b" && encoding !== "q") || text[charsetEnd + 2] !== "?") return undefined;
	const dataEnd = text.indexOf("?=", charsetEnd + 3);
	if (dataEnd === -1) return undefined;
	const charset = text.slice(start + 2, charsetEnd).split("*")[0] ?? "utf-8";
	const data = text.slice(charsetEnd + 3, dataEnd);
	const bytes =
		encoding === "b"
			? Buffer.from(data, "base64")
			: Buffer.from(
					data
						.replaceAll("_", " ")
						.replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
					"latin1",
				);
	return { text: decodeBytes(bytes, charset), end: dataEnd + 2 };
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	hellip: "…",
	ndash: "–",
	mdash: "—",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
};

function decodeEntity(entity: string): string {
	if (entity.startsWith("#")) {
		const code =
			entity[1] === "x" || entity[1] === "X"
				? Number.parseInt(entity.slice(2), 16)
				: Number.parseInt(entity.slice(1), 10);
		return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
	}
	return NAMED_ENTITIES[entity.toLowerCase()] ?? `&${entity};`;
}

const BLOCK_TAGS = new Set([
	"br",
	"p",
	"div",
	"li",
	"tr",
	"table",
	"ul",
	"ol",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"hr",
	"section",
	"article",
	"header",
	"footer",
]);
const SKIPPED_TAGS = new Set(["script", "style", "head", "title"]);

/**
 * HTML as plain text, in one pass: tags are dropped (a block-level one becomes a line break; what is inside `script`,
 * `style` and `head` is dropped with them), entities are decoded, whitespace is left for the caller to collapse. Not an HTML
 * parser: it reads what a person would read.
 */
export function htmlToText(html: string): string {
	const source = html.length > MAX_PART_BYTES ? html.slice(0, MAX_PART_BYTES) : html;
	let output = "";
	let skipUntil: string | undefined;
	let index = 0;
	while (index < source.length) {
		const open = source.indexOf("<", index);
		const text = source.slice(index, open === -1 ? source.length : open);
		if (skipUntil === undefined) output += decodeEntities(text);
		if (open === -1) break;
		if (source.startsWith("<!--", open)) {
			const end = source.indexOf("-->", open + 4);
			index = end === -1 ? source.length : end + 3;
			continue;
		}
		const close = source.indexOf(">", open + 1);
		if (close === -1) break;
		const tag = source.slice(open + 1, close);
		const closing = tag.startsWith("/");
		const name = (tag.slice(closing ? 1 : 0).match(/^[A-Za-z][A-Za-z0-9]*/)?.[0] ?? "").toLowerCase();
		if (skipUntil !== undefined) {
			if (closing && name === skipUntil) skipUntil = undefined;
		} else if (!closing && SKIPPED_TAGS.has(name) && !tag.endsWith("/")) {
			skipUntil = name;
		} else if (BLOCK_TAGS.has(name)) {
			output += "\n";
		}
		index = close + 1;
	}
	return output;
}

/** The `;` that closes an entity starting at `amp`, if it is within 12 characters; -1 otherwise. */
function closingSemicolon(text: string, amp: number): number {
	const end = Math.min(text.length, amp + 13);
	for (let index = amp + 1; index < end; index++) if (text.charCodeAt(index) === 59) return index;
	return -1;
}

function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	let output = "";
	let index = 0;
	while (index < text.length) {
		const amp = text.indexOf("&", index);
		if (amp === -1) {
			output += text.slice(index);
			break;
		}
		output += text.slice(index, amp);
		// Look for the closing `;` in the next dozen characters only: searching to the end of the text for every `&` is
		// quadratic on a part that is nothing but ampersands.
		const semicolon = closingSemicolon(text, amp);
		if (semicolon === -1) {
			output += "&";
			index = amp + 1;
			continue;
		}
		output += decodeEntity(text.slice(amp + 1, semicolon));
		index = semicolon + 1;
	}
	return output;
}

function charsetOf(part: Part): string {
	const contentType = header(part, "content-type");
	const index = contentType.toLowerCase().indexOf("charset=");
	if (index === -1) return "utf-8";
	return (
		contentType
			.slice(index + 8)
			.split(";")[0]
			?.trim()
			.replace(/^"|"$/g, "") ?? "utf-8"
	);
}

function partText(part: Part): string {
	const data = part.body?.data;
	if (data === undefined || data === "") return "";
	const bytes = Buffer.from(data.length > MAX_PART_BYTES * 2 ? data.slice(0, MAX_PART_BYTES * 2) : data, "base64url");
	return decodeBytes(bytes.subarray(0, MAX_PART_BYTES), charsetOf(part));
}

const isAttachment = (part: Part): boolean =>
	(part.filename ?? "") !== "" || header(part, "content-disposition").toLowerCase().startsWith("attachment");

/** The readable text of a message: its `text/plain` parts, or when it has none its `text/html` parts turned into text. */
export function bodyText(payload: Part | undefined): string {
	const plain: string[] = [];
	const html: string[] = [];
	let seen = 0;
	const walk = (part: Part, depth: number): void => {
		if (seen++ >= MAX_PARTS || depth > MAX_DEPTH) return;
		const type = (part.mimeType ?? "").toLowerCase();
		if (part.parts !== undefined && part.parts.length > 0) {
			for (const child of part.parts) walk(child, depth + 1);
		} else if (!isAttachment(part)) {
			if (type === "text/plain" || (type === "" && part.body?.data !== undefined)) plain.push(partText(part));
			else if (type === "text/html") html.push(htmlToText(partText(part)));
		}
	};
	if (payload !== undefined) walk(payload, 0);
	const text = plain.join("\n").trim() !== "" ? plain.join("\n") : html.join("\n");
	return text;
}

/** One message as the module keeps it. A message with no id or no date is not one (undefined). */
export function parseGmailMessage(raw: RawGmailMessage): GmailMessage | undefined {
	if (typeof raw.id !== "string" || raw.id === "") return undefined;
	const payload = raw.payload;
	const internalDate = Number(raw.internalDate);
	const precedence = header(payload, "precedence").toLowerCase();
	const autoSubmitted = header(payload, "auto-submitted").toLowerCase();
	return {
		id: raw.id,
		threadId: raw.threadId ?? raw.id,
		labelIds: raw.labelIds ?? [],
		snippet: decodeEntities(raw.snippet ?? ""),
		internalDate: Number.isFinite(internalDate) && internalDate > 0 ? internalDate : Date.now(),
		from: decodeMimeWords(header(payload, "from")),
		to: decodeMimeWords([header(payload, "to"), header(payload, "cc")].filter((value) => value !== "").join(", ")),
		subject: decodeMimeWords(header(payload, "subject")),
		bulk:
			header(payload, "list-unsubscribe") !== "" ||
			["bulk", "list", "junk"].includes(precedence) ||
			(autoSubmitted !== "" && autoSubmitted !== "no"),
		text: bodyText(payload),
	};
}
