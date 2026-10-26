/**
 * A web page as readable text: the title, the words in reading order with paragraphs and list items on their own lines,
 * and the links listed by number so the model can follow one. Scripts, styles, navigation chrome and forms are dropped.
 * Deliberately simple (no DOM): good enough for articles, docs, prices and listings, and nothing on the page is run.
 */

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	rsquo: "’",
	lsquo: "‘",
	rdquo: "”",
	ldquo: "“",
	copy: "©",
	euro: "€",
	pound: "£",
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] === "#") {
			const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

const DROP =
	/<(script|style|noscript|template|svg|canvas|iframe|object|head|nav|footer|form|select|button)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK =
	/<\/?(p|div|section|article|main|header|aside|h[1-6]|ul|ol|li|tr|table|thead|tbody|blockquote|pre|br|hr|dt|dd|figure|figcaption)\b[^>]*>/gi;

export type PageText = { title: string; text: string; links: string[] };

export function htmlToText(html: string, base: string): PageText {
	const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const links: string[] = [];
	let body = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROP, " ");
	body = body.replace(
		/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
		(_whole, _q, href: string, inner: string) => {
			let absolute: string;
			try {
				absolute = new URL(decodeEntities(href), base).toString();
			} catch {
				return inner;
			}
			if (!/^https?:/i.test(absolute)) return inner;
			let index = links.indexOf(absolute);
			if (index === -1) {
				links.push(absolute);
				index = links.length - 1;
			}
			return `${inner} [${index + 1}]`;
		},
	);
	body = body
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<h([1-6])\b[^>]*>/gi, (_w, level: string) => `\n\n${"#".repeat(Number(level))} `)
		.replace(/<(td|th)\b[^>]*>/gi, " | ")
		.replace(BLOCK, "\n")
		.replace(/<[^>]+>/g, "");
	const text = decodeEntities(body)
		.split("\n")
		.map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, text, links };
}
