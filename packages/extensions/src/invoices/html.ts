/**
 * A tolerant reader for the small subset of HTML an invoice template uses (`docs/setup-invoice.md` lists it). It builds a
 * tree and never executes or fetches anything: `script` and `style` are dropped with their text, any tag the layout does not
 * know stays as a transparent wrapper with its text kept, and a tag that was not closed is closed when its parent ends.
 */

export type HtmlText = { type: "text"; text: string };

export type HtmlElement = {
	type: "element";
	tag: string;
	attrs: Record<string, string>;
	/** The `style` attribute as lower-case property to value. */
	style: Record<string, string>;
	children: HtmlNode[];
};

export type HtmlNode = HtmlText | HtmlElement;

export type PageSize = "A4" | "Letter";

export type ParsedTemplate = {
	nodes: HtmlNode[];
	pageSize: PageSize;
	title?: string;
};

const NAMED: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
	ndash: "\u2013",
	mdash: "\u2014",
	hellip: "\u2026",
	bull: "\u2022",
	middot: "\u00b7",
	copy: "\u00a9",
	reg: "\u00ae",
	trade: "\u2122",
	laquo: "\u00ab",
	raquo: "\u00bb",
	lsquo: "\u2018",
	rsquo: "\u2019",
	ldquo: "\u201c",
	rdquo: "\u201d",
	euro: "\u20ac",
	pound: "\u00a3",
	yen: "\u00a5",
	cent: "\u00a2",
	deg: "\u00b0",
	times: "\u00d7",
	divide: "\u00f7",
	plusmn: "\u00b1",
	sect: "\u00a7",
	para: "\u00b6",
};

/** `&amp;`, `&#39;`, `&#x2F;` and the few named ones above; anything else is left as written. */
export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,9});/gi, (whole, name: string) => {
		if (name.startsWith("#")) {
			const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
			const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
			return valid ? String.fromCodePoint(code) : whole;
		}
		return NAMED[name.toLowerCase()] ?? whole;
	});
}

export function parseStyle(source: string | undefined): Record<string, string> {
	const style: Record<string, string> = {};
	if (source === undefined) return style;
	for (const declaration of source.split(";")) {
		const colon = declaration.indexOf(":");
		if (colon < 0) continue;
		const property = declaration.slice(0, colon).trim().toLowerCase();
		const value = declaration
			.slice(colon + 1)
			.replace(/!important/gi, "")
			.trim();
		if (property !== "" && value !== "") style[property] = value;
	}
	return style;
}

const VOID = new Set(["br", "hr", "img", "meta", "link", "input", "col", "area", "base", "wbr"]);
const RAW_TEXT = new Set(["script", "style"]);
const CLOSES_P = new Set([
	"div",
	"ul",
	"ol",
	"table",
	"h1",
	"h2",
	"h3",
	"h4",
	"hr",
	"address",
	"section",
	"header",
	"footer",
	"p",
	"blockquote",
	"pre",
]);

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttributes(source: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const match of source.matchAll(ATTRIBUTE)) {
		const name = (match[1] as string).toLowerCase();
		if (name in attrs) continue;
		attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
	}
	return attrs;
}

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/y;

/** Read a template. Never throws: what cannot be understood becomes text or is dropped. */
export function parseHtml(source: string): ParsedTemplate {
	const root: HtmlElement = { type: "element", tag: "#root", attrs: {}, style: {}, children: [] };
	const stack: HtmlElement[] = [root];
	const top = (): HtmlElement => stack[stack.length - 1] as HtmlElement;
	let pageSize: PageSize = "A4";
	let title: string | undefined;

	const addText = (raw: string): void => {
		if (raw === "") return;
		const parent = top();
		const text = decodeEntities(raw);
		const last = parent.children[parent.children.length - 1];
		if (last?.type === "text") last.text += text;
		else parent.children.push({ type: "text", text });
	};

	const popWhile = (tags: readonly string[]): void => {
		while (stack.length > 1 && tags.includes(top().tag)) stack.pop();
	};

	/** The end tags HTML implies: a new list item ends the one before it, a new row ends the cells of the last. */
	const impliedEnds = (tag: string): void => {
		if (tag === "li") popWhile(["li"]);
		else if (tag === "td" || tag === "th") popWhile(["td", "th"]);
		else if (tag === "tr") popWhile(["td", "th", "tr"]);
		else if (tag === "thead" || tag === "tbody" || tag === "tfoot")
			popWhile(["td", "th", "tr", "thead", "tbody", "tfoot"]);
		if (CLOSES_P.has(tag) && top().tag === "p") stack.pop();
	};

	const open = (tag: string, attrs: Record<string, string>, selfClosing: boolean): void => {
		if (tag === "meta") {
			if (attrs.name?.toLowerCase() === "page-size")
				pageSize = attrs.content?.trim().toLowerCase() === "letter" ? "Letter" : "A4";
			return;
		}
		impliedEnds(tag);
		const element: HtmlElement = { type: "element", tag, attrs, style: parseStyle(attrs.style), children: [] };
		top().children.push(element);
		if (!VOID.has(tag) && !selfClosing) stack.push(element);
	};

	const close = (tag: string): void => {
		for (let index = stack.length - 1; index > 0; index--) {
			if ((stack[index] as HtmlElement).tag === tag) {
				stack.length = index;
				return;
			}
		}
	};

	let position = 0;
	while (position < source.length) {
		const next = source.indexOf("<", position);
		if (next < 0) {
			addText(source.slice(position));
			break;
		}
		addText(source.slice(position, next));
		if (source.startsWith("<!--", next)) {
			const end = source.indexOf("-->", next + 4);
			position = end < 0 ? source.length : end + 3;
			continue;
		}
		if (source[next + 1] === "!" || source[next + 1] === "?") {
			const end = source.indexOf(">", next);
			position = end < 0 ? source.length : end + 1;
			continue;
		}
		TAG.lastIndex = next;
		const match = TAG.exec(source);
		if (match === null) {
			addText("<");
			position = next + 1;
			continue;
		}
		position = next + match[0].length;
		const closing = match[1] === "/";
		const tag = (match[2] as string).toLowerCase();
		const rest = match[3] ?? "";
		if (closing) {
			close(tag);
			continue;
		}
		if (RAW_TEXT.has(tag)) {
			const end = source.toLowerCase().indexOf(`</${tag}`, position);
			const closeAt = end < 0 ? -1 : source.indexOf(">", end);
			position = closeAt < 0 ? source.length : closeAt + 1;
			continue;
		}
		if (tag === "title") {
			const end = source.toLowerCase().indexOf("</title", position);
			title = decodeEntities(source.slice(position, end < 0 ? source.length : end))
				.replace(/\s+/g, " ")
				.trim();
			const closeAt = end < 0 ? -1 : source.indexOf(">", end);
			position = closeAt < 0 ? source.length : closeAt + 1;
			continue;
		}
		const selfClosing = rest.trimEnd().endsWith("/");
		open(tag, parseAttributes(selfClosing ? rest.trimEnd().slice(0, -1) : rest), selfClosing);
	}
	return { nodes: root.children, pageSize, ...(title === undefined || title === "" ? {} : { title }) };
}
