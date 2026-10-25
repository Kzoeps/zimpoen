/**
 * Text that came out of an email is untrusted and arbitrary: any length, any characters. Everything that reaches a card,
 * a tool result, a prompt or a log passes through these first, so that it is one line, bounded, free of the characters
 * that spoof or hide text, and cannot close a block that a prompt opened.
 */

/** Controls, DEL and C1, zero-width characters, bidirectional overrides and isolates, the byte order mark. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this removes
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** `value` cut to `max` characters, with an ellipsis when something was left out. Never cuts a surrogate pair in half. */
export function clip(value: string, max: number): string {
	if (value.length <= max) return value;
	let end = max - 1;
	const last = value.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${value.slice(0, Math.max(0, end))}…`;
}

/** One line of at most `max` characters: invisible characters become spaces, angle brackets go, runs of spaces collapse. */
export function safeLine(value: string, max: number): string {
	// Bound the work before the regular expressions run: a header or body can be megabytes.
	const bounded = value.length > max * 4 ? value.slice(0, max * 4) : value;
	return clip(bounded.replace(INVISIBLE, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim(), max);
}

/**
 * The readable text of a body, kept as paragraphs: invisible characters other than line breaks and tabs are removed,
 * runs of spaces and of blank lines collapse. Bounded before it is processed.
 */
export function safeText(value: string, max: number): string {
	const bounded = value.length > max * 3 ? value.slice(0, max * 3) : value;
	const cleaned = bounded
		.replace(/\r\n?/g, "\n")
		.replace(INVISIBLE, (character) => (character === "\n" || character === "\t" ? character : ""))
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return clip(cleaned, max);
}

export type Address = { name: string; address: string };

const MAX_NAME = 120;
const MAX_ADDRESS = 200;

/**
 * `"Dabtonog Realty" <sales@dabtonog.example>` as a name and an address (lower case). A header without angle brackets is
 * an address when it has an `@` and a name otherwise. Scans once: no pattern backtracks on a hostile header.
 */
export function parseAddress(raw: string): Address {
	const header = raw.length > 2000 ? raw.slice(0, 2000) : raw;
	const open = header.lastIndexOf("<");
	const close = open === -1 ? -1 : header.indexOf(">", open);
	if (open !== -1 && close !== -1) {
		const address = header
			.slice(open + 1, close)
			.trim()
			.toLowerCase();
		const name = unquote(header.slice(0, open));
		return { name: safeLine(name === "" ? address : name, MAX_NAME), address: safeLine(address, MAX_ADDRESS) };
	}
	const bare = header.trim();
	if (bare.includes("@")) return { name: "", address: safeLine(bare.toLowerCase(), MAX_ADDRESS) };
	return { name: safeLine(unquote(bare), MAX_NAME), address: "" };
}

function unquote(value: string): string {
	let text = value.trim();
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
	return text.replaceAll('\\"', '"').trim();
}

/** The addresses of a `To` or `Cc` header, names dropped: `a@x.example, b@y.example`. Commas inside quotes or angle brackets do not split. */
export function addressList(raw: string, max = 500): string {
	const header = raw.length > 4000 ? raw.slice(0, 4000) : raw;
	const parts: string[] = [];
	let current = "";
	let quoted = false;
	let angled = false;
	for (const character of header) {
		if (character === '"') quoted = !quoted;
		else if (!quoted && character === "<") angled = true;
		else if (!quoted && character === ">") angled = false;
		if (character === "," && !quoted && !angled) {
			parts.push(current);
			current = "";
		} else {
			current += character;
		}
	}
	parts.push(current);
	const addresses = parts.map((part) => parseAddress(part).address).filter((address) => address !== "");
	return clip(addresses.join(", "), max);
}

/** `Name <address>` for a line of text: the name when there is one, the address beside it. */
export function describeSender(from: { name: string; address: string }): string {
	if (from.name === "" || from.name === from.address) return from.address === "" ? "(unknown sender)" : from.address;
	return from.address === "" ? from.name : `${from.name} <${from.address}>`;
}

/** The domain of an address: `dabtonog.example` for `sales@dabtonog.example`, or an empty string. */
export function domainOf(address: string): string {
	const at = address.lastIndexOf("@");
	return at === -1 ? "" : address.slice(at + 1);
}
