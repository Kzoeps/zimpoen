import PDFDocument from "pdfkit";
import type { HtmlElement, HtmlNode, ParsedTemplate } from "./html.ts";

/**
 * Lays the template's HTML subset out on A4 or Letter pages with pdfkit (pure JavaScript, the standard Helvetica fonts, no
 * browser and no files at run time). The subset is what an invoice needs: headings, paragraphs, lists, tables (also for
 * side-by-side columns), rules, images and the usual text styles; `docs/setup-invoice.md` lists it. Text outside Latin-1 and
 * the Windows-1252 punctuation cannot be drawn with these fonts and comes out as `?`.
 *
 * Layout is one pass that paints as it goes. To know the height of something before painting it (a table row, a box with a
 * background) the same code runs in `dry` mode, which only moves the cursor.
 */

/** A template problem the owner can fix in their file: the message says what and where. */
export class TemplateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateError";
	}
}

const PAGE_POINTS = { A4: { width: 595.28, height: 841.89 }, Letter: { width: 612, height: 792 } } as const;
const MARGIN = 48;
const LINE_HEIGHT = 1.25;
const PX = 0.75;

type TextStyle = { size: number; bold: boolean; italic: boolean; underline: boolean; color: string; link?: string };
type Align = "left" | "center" | "right";
type Inherited = TextStyle & { align: Align };

const BASE: Inherited = { size: 10, bold: false, italic: false, underline: false, color: "#111111", align: "left" };

const BLOCK_TAGS = new Set([
	"div",
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"ul",
	"ol",
	"li",
	"table",
	"hr",
	"address",
	"section",
	"header",
	"footer",
	"blockquote",
	"body",
	"html",
	"main",
	"article",
	"nav",
	"pre",
	"img",
]);
const SKIPPED = new Set(["head", "title", "script", "style", "template", "noscript"]);
const COLORS: Readonly<Record<string, string>> = {
	black: "#000000",
	white: "#ffffff",
	gray: "#808080",
	grey: "#808080",
	silver: "#c0c0c0",
	red: "#cc0000",
	blue: "#0000cc",
	green: "#008000",
	navy: "#000080",
	orange: "#ff8c00",
	teal: "#008080",
	maroon: "#800000",
	purple: "#800080",
};

// ----- text ----------------------------------------------------------------------------------------------------------------

/** What the standard fonts can draw (WinAnsi): Latin-1 and the Windows-1252 punctuation; the rupee sign is written "Rs.". */
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

export function toWinAnsi(input: string): string {
	let out = "";
	for (const char of input.normalize("NFC")) {
		const code = char.codePointAt(0) as number;
		if (code === 0x20b9) out += "Rs.";
		else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(char)) out += char;
		else if (code === 0x09 || code === 0x0a || code === 0x0d) out += " ";
		else if (code === 0xad || (code >= 0x200b && code <= 0x200f)) continue;
		else out += "?";
	}
	return out;
}

const fontOf = (style: TextStyle): string =>
	style.bold
		? style.italic
			? "Helvetica-BoldOblique"
			: "Helvetica-Bold"
		: style.italic
			? "Helvetica-Oblique"
			: "Helvetica";

// ----- CSS values --------------------------------------------------------------------------------------------------------

type Length = { value: number; percent: boolean };

function parseLength(raw: string | undefined, em: number): Length | undefined {
	if (raw === undefined) return undefined;
	const match = /^(-?\d*\.?\d+)\s*(px|pt|mm|cm|in|em|rem|%)?$/i.exec(raw.trim());
	if (match === null) return undefined;
	const n = Number(match[1]);
	switch ((match[2] ?? "px").toLowerCase()) {
		case "%":
			return { value: n, percent: true };
		case "pt":
			return { value: n, percent: false };
		case "mm":
			return { value: n * 2.8346, percent: false };
		case "cm":
			return { value: n * 28.346, percent: false };
		case "in":
			return { value: n * 72, percent: false };
		case "em":
		case "rem":
			return { value: n * em, percent: false };
		default:
			return { value: n * PX, percent: false };
	}
}

/** A length in points; a percentage is of `of`. */
const points = (length: Length | undefined, of: number): number | undefined =>
	length === undefined ? undefined : length.percent ? (length.value / 100) * of : length.value;

function parseColor(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
	if (hex !== null) {
		const digits = hex[1] as string;
		return digits.length === 3 ? `#${[...digits].map((digit) => digit + digit).join("")}` : `#${digits}`;
	}
	const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(value);
	if (rgb !== null) {
		return `#${[rgb[1], rgb[2], rgb[3]].map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0")).join("")}`;
	}
	return COLORS[value];
}

type Border = { width: number; color: string };

/** `1px solid #ccc` (the style word is ignored: every line is solid), `none`, or a bare colour or width. */
function parseBorder(raw: string | undefined, em: number): Border | null | undefined {
	if (raw === undefined) return undefined;
	const words = raw.trim().split(/\s+/);
	if (words.some((word) => word.toLowerCase() === "none" || word === "0")) return null;
	let width = 0.75;
	let color = "#000000";
	for (const word of words) {
		const length = parseLength(word, em);
		if (length !== undefined && !length.percent) width = Math.max(0.25, length.value);
		else color = parseColor(word) ?? color;
	}
	return { width, color };
}

/** `padding` or `margin` shorthand: one to four values, top right bottom left. */
function parseSides(raw: string | undefined, em: number): [number, number, number, number] | undefined {
	if (raw === undefined) return undefined;
	const values = raw
		.trim()
		.split(/\s+/)
		.map((word) => points(parseLength(word, em), 0));
	if (values.length === 0 || values.length > 4 || values.some((value) => value === undefined)) return undefined;
	const [a = 0, b = a, c = a, d = b] = values as number[];
	return [a, b, c, d];
}

// ----- the painter -------------------------------------------------------------------------------------------------------------

type Frame = { x: number; width: number };

type TableCell = { el: HtmlElement; span: number; style: Inherited; box: BoxStyle };
type TableRow = { el: HtmlElement; cells: TableCell[] };

type Piece = { text: string; style: TextStyle; width: number; space: boolean };
type Line = { pieces: Piece[]; width: number; height: number };
type Run = { kind: "text"; text: string; style: TextStyle } | { kind: "break"; style: TextStyle };

type BoxStyle = {
	marginTop: number;
	marginBottom: number;
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
	width?: Length;
	background?: string;
	borderTop?: Border | null;
	borderBottom?: Border | null;
	borderLeft?: Border | null;
	borderRight?: Border | null;
};

const HEADING: Readonly<Record<string, { size: number; marginBottom: number }>> = {
	h1: { size: 22, marginBottom: 8 },
	h2: { size: 16, marginBottom: 6 },
	h3: { size: 13, marginBottom: 4 },
	h4: { size: 11, marginBottom: 4 },
};

type PdfOptions = {
	/** Compress the page streams. Off only in tests, which read the text out of them. */
	compress?: boolean;
	title?: string;
	author?: string;
	/** Written large and faint across every page, over the template, which cannot remove it: "PREVIEW". */
	watermark?: string;
	/** Images the template refers to, by their `src`, already read and checked. */
	images: ReadonlyMap<string, Buffer>;
};

class Painter {
	readonly doc: PDFKit.PDFDocument;
	private readonly page: { width: number; height: number };
	private readonly images: ReadonlyMap<string, Buffer>;
	private dry = false;
	private noBreak = false;
	/** The widest line painted since it was last reset: how wide a table cell wants to be. */
	private widest = 0;
	y = MARGIN;

	constructor(doc: PDFKit.PDFDocument, size: "A4" | "Letter", images: ReadonlyMap<string, Buffer>) {
		this.doc = doc;
		this.page = PAGE_POINTS[size];
		this.images = images;
	}

	get bottom(): number {
		return this.page.height - MARGIN;
	}

	get frame(): Frame {
		return { x: MARGIN, width: this.page.width - 2 * MARGIN };
	}

	// -- cursor -----------------------------------------------------------------------------------------------------------------

	/** Run `paint` without drawing or breaking pages and say how far it moved the cursor and how wide its widest line was. */
	private measure(paint: () => void): { height: number; width: number } {
		const saved = { y: this.y, dry: this.dry, noBreak: this.noBreak, widest: this.widest };
		this.dry = true;
		this.widest = 0;
		paint();
		const result = { height: this.y - saved.y, width: this.widest };
		this.y = saved.y;
		this.dry = saved.dry;
		this.noBreak = saved.noBreak;
		this.widest = Math.max(saved.widest, this.widest);
		return result;
	}

	/** Start a new page when `height` more does not fit on this one (but never leave an empty page behind). */
	private ensure(height: number): void {
		if (this.dry || this.noBreak) return;
		if (this.y + height > this.bottom && this.y > MARGIN + 0.5) {
			this.doc.addPage();
			this.y = MARGIN;
		}
	}

	// -- styles -----------------------------------------------------------------------------------------------------------------

	private inherit(el: HtmlElement, parent: Inherited): Inherited {
		const style: Inherited = { ...parent };
		const heading = HEADING[el.tag];
		if (heading !== undefined) {
			style.size = heading.size;
			style.bold = true;
		}
		if (el.tag === "b" || el.tag === "strong" || el.tag === "th") style.bold = true;
		if (el.tag === "i" || el.tag === "em") style.italic = true;
		if (el.tag === "u" || el.tag === "a") style.underline = true;
		if (el.tag === "small") style.size = parent.size * 0.8;
		if (el.tag === "th") style.align = "center";
		const align = (el.attrs.align ?? "").toLowerCase();
		if (align === "left" || align === "center" || align === "right") style.align = align;
		const css = el.style;
		const size = parseLength(css["font-size"], parent.size);
		if (size !== undefined && !size.percent && size.value > 0) style.size = size.value;
		else if (size?.percent === true) style.size = (size.value / 100) * parent.size;
		if (css["font-weight"] !== undefined) style.bold = /^(bold|bolder|[6-9]00)$/i.test(css["font-weight"].trim());
		if (css["font-style"] !== undefined) style.italic = /^(italic|oblique)$/i.test(css["font-style"].trim());
		if (css["text-decoration"] !== undefined) style.underline = /underline/i.test(css["text-decoration"]);
		const color = parseColor(css.color) ?? parseColor(el.attrs.color);
		if (color !== undefined) style.color = color;
		const textAlign = css["text-align"]?.trim().toLowerCase();
		if (textAlign === "left" || textAlign === "center" || textAlign === "right") style.align = textAlign;
		if (el.tag === "a") {
			const href = el.attrs.href?.trim() ?? "";
			if (/^(https?:\/\/|mailto:)/i.test(href)) style.link = href;
		}
		return style;
	}

	private boxOf(el: HtmlElement, style: Inherited): BoxStyle {
		const css = el.style;
		const em = style.size;
		const box: BoxStyle = {
			marginTop: 0,
			marginBottom: 0,
			paddingTop: 0,
			paddingRight: 0,
			paddingBottom: 0,
			paddingLeft: 0,
		};
		if (el.tag === "p") box.marginBottom = 6;
		if (el.tag === "ul" || el.tag === "ol") box.marginBottom = 6;
		const heading = HEADING[el.tag];
		if (heading !== undefined) box.marginBottom = heading.marginBottom;
		if (el.tag === "hr") {
			box.marginTop = 6;
			box.marginBottom = 6;
		}
		const margin = parseSides(css.margin, em);
		if (margin !== undefined) [box.marginTop, , box.marginBottom] = margin;
		box.marginTop = points(parseLength(css["margin-top"], em), 0) ?? box.marginTop;
		box.marginBottom = points(parseLength(css["margin-bottom"], em), 0) ?? box.marginBottom;
		const padding = parseSides(css.padding, em);
		if (padding !== undefined) [box.paddingTop, box.paddingRight, box.paddingBottom, box.paddingLeft] = padding;
		box.paddingTop = points(parseLength(css["padding-top"], em), 0) ?? box.paddingTop;
		box.paddingRight = points(parseLength(css["padding-right"], em), 0) ?? box.paddingRight;
		box.paddingBottom = points(parseLength(css["padding-bottom"], em), 0) ?? box.paddingBottom;
		box.paddingLeft = points(parseLength(css["padding-left"], em), 0) ?? box.paddingLeft;
		const width = parseLength(css.width ?? el.attrs.width, em);
		if (width !== undefined) box.width = width;
		const background =
			parseColor(css.background) ?? parseColor(css["background-color"]) ?? parseColor(el.attrs.bgcolor);
		if (background !== undefined) box.background = background;
		const all = parseBorder(css.border, em);
		for (const [side, key] of [
			["borderTop", "border-top"],
			["borderBottom", "border-bottom"],
			["borderLeft", "border-left"],
			["borderRight", "border-right"],
		] as const) {
			const value = parseBorder(css[key], em) ?? all;
			if (value !== undefined) box[side] = value;
		}
		return box;
	}

	// -- inline content ------------------------------------------------------------------------------------------------------------

	private runsOf(nodes: readonly HtmlNode[], style: Inherited, runs: Run[] = []): Run[] {
		for (const node of nodes) {
			if (node.type === "text") {
				const text = toWinAnsi(node.text.replace(/[ \t\r\n\f\v]+/g, " "));
				if (text !== "") runs.push({ kind: "text", text, style });
			} else if (node.tag === "br") runs.push({ kind: "break", style });
			else if (!SKIPPED.has(node.tag)) this.runsOf(node.children, this.inherit(node, style), runs);
		}
		return runs;
	}

	private widthOf(text: string, style: TextStyle): number {
		return this.doc.font(fontOf(style)).fontSize(style.size).widthOfString(text);
	}

	/** Wrap runs into lines no wider than `width`: break at spaces, and inside a word that is wider than a line. */
	private lines(runs: readonly Run[], width: number, fallback: TextStyle): Line[] {
		const lines: Line[] = [];
		let line: Piece[] = [];
		let used = 0;
		const finish = (style: TextStyle): void => {
			while (line.length > 0 && (line[line.length - 1] as Piece).space) {
				used -= (line.pop() as Piece).width;
			}
			const height = Math.max(0, ...line.map((piece) => piece.style.size)) || style.size;
			lines.push({ pieces: line, width: Math.max(0, used), height: height * LINE_HEIGHT });
			line = [];
			used = 0;
		};
		for (const run of runs) {
			if (run.kind === "break") {
				finish(run.style);
				continue;
			}
			for (const part of run.text.split(/( )/)) {
				if (part === "") continue;
				const space = part === " ";
				if (space && line.length === 0) continue;
				const w = this.widthOf(part, run.style);
				if (!space && used + w > width + 0.01 && line.length > 0) finish(run.style);
				if (!space && w > width) {
					for (const piece of this.chop(part, run.style, width)) {
						if (used + piece.width > width + 0.01 && line.length > 0) finish(run.style);
						line.push(piece);
						used += piece.width;
					}
					continue;
				}
				line.push({ text: part, style: run.style, width: w, space });
				used += w;
			}
		}
		if (line.length > 0 || lines.length === 0) finish(runs.at(-1)?.style ?? fallback);
		return lines;
	}

	/** A word wider than the line, cut into pieces that fit. */
	private chop(word: string, style: TextStyle, width: number): Piece[] {
		const pieces: Piece[] = [];
		let current = "";
		for (const char of word) {
			if (current !== "" && this.widthOf(current + char, style) > width) {
				pieces.push({ text: current, style, width: this.widthOf(current, style), space: false });
				current = "";
			}
			current += char;
		}
		if (current !== "") pieces.push({ text: current, style, width: this.widthOf(current, style), space: false });
		return pieces;
	}

	private paintParagraph(runs: readonly Run[], frame: Frame, style: Inherited): void {
		const hasText = runs.some((run) => run.kind === "break" || run.text.trim() !== "");
		if (!hasText) return;
		for (const line of this.lines(runs, frame.width, style)) {
			this.ensure(line.height);
			this.widest = Math.max(this.widest, line.width);
			if (!this.dry) this.drawLine(line, frame, style.align);
			this.y += line.height;
		}
	}

	private drawLine(line: Line, frame: Frame, align: Align): void {
		let x =
			align === "center"
				? frame.x + (frame.width - line.width) / 2
				: align === "right"
					? frame.x + frame.width - line.width
					: frame.x;
		// Neighbouring pieces of one style are drawn together, so the text stays selectable as words.
		const groups: Array<{ text: string; style: TextStyle; width: number }> = [];
		for (const piece of line.pieces) {
			const last = groups.at(-1);
			if (last !== undefined && last.style === piece.style) {
				last.text += piece.text;
				last.width += piece.width;
			} else groups.push({ text: piece.text, style: piece.style, width: piece.width });
		}
		for (const group of groups) {
			const { style } = group;
			this.doc
				.font(fontOf(style))
				.fontSize(style.size)
				.fillColor(style.color)
				.text(group.text, x, this.y + style.size * 0.1, {
					lineBreak: false,
					underline: style.underline,
					...(style.link === undefined ? {} : { link: style.link }),
				});
			x += group.width;
		}
	}

	// -- blocks --------------------------------------------------------------------------------------------------------------------

	/** Children of a block: runs of inline nodes become paragraphs, block elements are painted one after another. */
	paintBlocks(nodes: readonly HtmlNode[], frame: Frame, style: Inherited): void {
		let inline: HtmlNode[] = [];
		const flush = (): void => {
			if (inline.length > 0) this.paintParagraph(this.runsOf(inline, style), frame, style);
			inline = [];
		};
		for (const node of nodes) {
			if (node.type === "element" && SKIPPED.has(node.tag)) continue;
			if (node.type === "element" && BLOCK_TAGS.has(node.tag)) {
				flush();
				this.paintElement(node, frame, style);
			} else inline.push(node);
		}
		flush();
	}

	private paintElement(el: HtmlElement, frame: Frame, parent: Inherited): void {
		const style = this.inherit(el, parent);
		switch (el.tag) {
			case "hr":
				this.paintRule(el, frame, style);
				break;
			case "img":
				this.paintImage(el, frame, style);
				break;
			case "table":
				this.paintTable(el, frame, style);
				break;
			case "ul":
			case "ol":
				this.paintList(el, frame, style);
				break;
			default:
				this.paintBox(el, frame, style, (inner) => this.paintBlocks(el.children, inner, style));
		}
	}

	/** A box with margins, padding, a background and borders around whatever `paintInside` paints in its frame. */
	private paintBox(el: HtmlElement, frame: Frame, style: Inherited, paintInside: (inner: Frame) => void): void {
		const box = this.boxOf(el, style);
		const outer = Math.min(frame.width, points(box.width, frame.width) ?? frame.width);
		const inner: Frame = {
			x: frame.x + box.paddingLeft,
			width: Math.max(10, outer - box.paddingLeft - box.paddingRight),
		};
		this.y += box.marginTop;
		const decorated =
			box.background !== undefined ||
			[box.borderTop, box.borderBottom, box.borderLeft, box.borderRight].some((border) => border);
		if (!decorated && box.paddingTop === 0 && box.paddingBottom === 0) {
			paintInside(inner);
		} else {
			const content = this.measure(() => paintInside(inner)).height;
			const height = box.paddingTop + content + box.paddingBottom;
			this.ensure(height);
			if (!this.dry) this.decorate({ x: frame.x, y: this.y, width: outer, height }, box);
			this.y += box.paddingTop;
			paintInside(inner);
			this.y += box.paddingBottom;
		}
		this.y += box.marginBottom;
	}

	private decorate(rect: { x: number; y: number; width: number; height: number }, box: BoxStyle): void {
		const { doc } = this;
		if (box.background !== undefined)
			doc.save().rect(rect.x, rect.y, rect.width, rect.height).fill(box.background).restore();
		const stroke = (border: Border | null | undefined, x1: number, y1: number, x2: number, y2: number): void => {
			if (!border) return;
			doc.save().lineWidth(border.width).strokeColor(border.color).moveTo(x1, y1).lineTo(x2, y2).stroke().restore();
		};
		const { x, y, width, height } = rect;
		stroke(box.borderTop, x, y, x + width, y);
		stroke(box.borderBottom, x, y + height, x + width, y + height);
		stroke(box.borderLeft, x, y, x, y + height);
		stroke(box.borderRight, x + width, y, x + width, y + height);
	}

	private paintRule(el: HtmlElement, frame: Frame, style: Inherited): void {
		const box = this.boxOf(el, style);
		this.y += box.marginTop;
		this.ensure(1);
		if (!this.dry) {
			const border = parseBorder(el.style.border, style.size) ?? parseBorder(el.style["border-top"], style.size);
			const line = border === null ? undefined : (border ?? { width: 0.75, color: "#999999" });
			if (line !== undefined) {
				this.doc
					.save()
					.lineWidth(line.width)
					.strokeColor(line.color)
					.moveTo(frame.x, this.y)
					.lineTo(frame.x + frame.width, this.y)
					.stroke()
					.restore();
			}
		}
		this.y += 1 + box.marginBottom;
	}

	private paintImage(el: HtmlElement, frame: Frame, style: Inherited): void {
		const src = el.attrs.src?.trim() ?? "";
		const data = this.images.get(src);
		if (data === undefined) return;
		let image: { width: number; height: number };
		try {
			// `openImage` reads the size of a PNG or JPEG; pdfkit's type declarations leave it out.
			image = (this.doc as unknown as { openImage(source: Buffer): { width: number; height: number } }).openImage(data);
		} catch {
			throw new TemplateError(`The image '${src.slice(0, 60)}' in the template is not a PNG or JPEG file.`);
		}
		const em = style.size;
		const asked = points(parseLength(el.style.width ?? el.attrs.width, em), frame.width);
		const natural = image.width * PX;
		const width = Math.min(frame.width, asked ?? natural);
		const height = (image.height / image.width) * width;
		const box = this.boxOf(el, style);
		this.y += box.marginTop;
		this.ensure(height);
		if (!this.dry) {
			const x =
				style.align === "center"
					? frame.x + (frame.width - width) / 2
					: style.align === "right"
						? frame.x + frame.width - width
						: frame.x;
			this.doc.image(data, x, this.y, { width });
		}
		this.y += height + box.marginBottom + 2;
	}

	private paintList(el: HtmlElement, frame: Frame, style: Inherited): void {
		const box = this.boxOf(el, style);
		this.y += box.marginTop;
		const indent = 18;
		const inner: Frame = { x: frame.x + indent, width: Math.max(10, frame.width - indent) };
		let number = 0;
		for (const child of el.children) {
			if (child.type !== "element" || child.tag !== "li") continue;
			number += 1;
			const item = this.inherit(child, style);
			const marker = el.tag === "ol" ? `${number}.` : "\u2022";
			this.ensure(item.size * LINE_HEIGHT);
			if (!this.dry) {
				this.doc
					.font(fontOf(item))
					.fontSize(item.size)
					.fillColor(item.color)
					.text(marker, frame.x + 2, this.y + item.size * 0.1, { lineBreak: false });
			}
			this.paintBlocks(child.children, inner, item);
		}
		this.y += box.marginBottom;
	}

	// -- tables ----------------------------------------------------------------------------------------------------------------------

	private paintTable(el: HtmlElement, frame: Frame, style: Inherited): void {
		const rows = this.readRows(el.children, style);
		if (rows.length === 0) return;
		const tableBox = this.boxOf(el, style);
		const tableWidth = Math.min(frame.width, points(tableBox.width, frame.width) ?? frame.width);
		const columns = Math.max(...rows.map((row) => row.cells.reduce((sum, cell) => sum + cell.span, 0)));
		const widths = this.columnWidths(rows, columns, tableWidth, (cell) =>
			this.cellContentWidth(cell.el, cell.style, cell.box),
		);
		// `border="1"` on the table draws every cell's border.
		const tableBorder =
			el.attrs.border !== undefined && Number(el.attrs.border) > 0
				? { width: 0.5, color: "#000000" }
				: tableBox.borderTop;
		this.y += tableBox.marginTop;
		for (const row of rows) this.paintRow(row, widths, frame.x, tableBorder);
		this.y += tableBox.marginBottom;
	}

	/** The rows of a table with the styles of their cells, looking inside `thead`, `tbody` and `tfoot`. */
	private readRows(nodes: readonly HtmlNode[], style: Inherited): TableRow[] {
		const rows: TableRow[] = [];
		for (const node of nodes) {
			if (node.type !== "element") continue;
			if (node.tag === "thead" || node.tag === "tbody" || node.tag === "tfoot") {
				rows.push(...this.readRows(node.children, style));
			} else if (node.tag === "tr") {
				const rowStyle = this.inherit(node, style);
				const rowBox = this.boxOf(node, rowStyle);
				const cells: TableCell[] = [];
				for (const cell of node.children) {
					if (cell.type !== "element" || (cell.tag !== "td" && cell.tag !== "th")) continue;
					const cellStyle = this.inherit(cell, rowStyle);
					const span = Math.max(1, Math.min(12, Math.floor(Number(cell.attrs.colspan ?? 1)) || 1));
					const box = this.boxOf(cell, cellStyle);
					if (cell.style.padding === undefined) {
						for (const side of ["paddingTop", "paddingBottom"] as const) box[side] = box[side] || 3;
						for (const side of ["paddingLeft", "paddingRight"] as const) box[side] = box[side] || 4;
					}
					// What a row says (`<tr bgcolor>`, a border under it) holds for the cells that say nothing themselves.
					if (box.background === undefined && rowBox.background !== undefined) box.background = rowBox.background;
					if (box.borderTop === undefined && rowBox.borderTop !== undefined) box.borderTop = rowBox.borderTop;
					if (box.borderBottom === undefined && rowBox.borderBottom !== undefined)
						box.borderBottom = rowBox.borderBottom;
					cells.push({ el: cell, span, style: cellStyle, box });
				}
				rows.push({ el: node, cells });
			}
		}
		return rows;
	}

	/** One row: as tall as its tallest cell, kept whole on one page, each cell painted inside its column. */
	private paintRow(
		row: TableRow,
		widths: readonly number[],
		left: number,
		tableBorder: Border | null | undefined,
	): void {
		let column = 0;
		const placed = row.cells.map((cell) => {
			const x = left + widths.slice(0, column).reduce((sum, width) => sum + width, 0);
			const width = widths.slice(column, column + cell.span).reduce((sum, value) => sum + value, 0);
			column += cell.span;
			const inner: Frame = {
				x: x + cell.box.paddingLeft,
				width: Math.max(8, width - cell.box.paddingLeft - cell.box.paddingRight),
			};
			const content = this.measure(() => {
				this.noBreak = true;
				this.paintBlocks(cell.el.children, inner, cell.style);
			}).height;
			return { cell, x, width, inner, height: cell.box.paddingTop + content + cell.box.paddingBottom };
		});
		const rowHeight = Math.max(0, ...placed.map((entry) => entry.height));
		this.ensure(rowHeight);
		// A cell's own `border: none` stays none; one that says nothing takes the table's border.
		const border = (side: Border | null | undefined): Border | null | undefined =>
			side === undefined ? tableBorder : side;
		for (const entry of placed) {
			if (!this.dry) {
				this.decorate(
					{ x: entry.x, y: this.y, width: entry.width, height: rowHeight },
					{
						...entry.cell.box,
						borderTop: border(entry.cell.box.borderTop),
						borderBottom: border(entry.cell.box.borderBottom),
						borderLeft: border(entry.cell.box.borderLeft),
						borderRight: border(entry.cell.box.borderRight),
					},
				);
			}
			const top = this.y;
			const saved = this.noBreak;
			this.noBreak = true;
			this.y = top + entry.cell.box.paddingTop;
			this.paintBlocks(entry.cell.el.children, entry.inner, entry.cell.style);
			this.noBreak = saved;
			this.y = top;
		}
		this.y += rowHeight;
	}

	/** How wide a cell's text would be on one line (plus its padding): the width it asks for. */
	private cellContentWidth(el: HtmlElement, style: Inherited, box: BoxStyle): number {
		const { width } = this.measure(() => {
			this.noBreak = true;
			this.paintBlocks(el.children, { x: 0, width: 100_000 }, style);
		});
		return width + box.paddingLeft + box.paddingRight;
	}

	/**
	 * Column widths: those a cell asks for with `width` (pixels, points or a percentage of the table) are kept; the other
	 * columns share what is left in proportion to how wide their text is, so a description is wide and a quantity narrow.
	 */
	private columnWidths<C extends { el: HtmlElement; span: number; box: BoxStyle }>(
		rows: ReadonlyArray<{ cells: C[] }>,
		columns: number,
		tableWidth: number,
		natural: (cell: C) => number,
	): number[] {
		const fixed: Array<number | undefined> = Array.from({ length: columns }, () => undefined);
		const wanted: number[] = Array.from({ length: columns }, () => 0);
		for (const row of rows) {
			let column = 0;
			for (const cell of row.cells) {
				if (cell.span === 1) {
					const asked = points(parseLength(cell.el.style.width ?? cell.el.attrs.width, 10), tableWidth);
					if (asked !== undefined && fixed[column] === undefined) fixed[column] = Math.max(8, asked);
					wanted[column] = Math.max(wanted[column] ?? 0, natural(cell));
				}
				column += cell.span;
			}
		}
		const fixedTotal = fixed.reduce<number>((sum, width) => sum + (width ?? 0), 0);
		const free = fixed.flatMap((width, index) => (width === undefined ? [index] : []));
		const widths = fixed.map((width) => width ?? 0);
		if (free.length === 0) {
			const scale = fixedTotal > tableWidth ? tableWidth / fixedTotal : 1;
			return widths.map((width) => width * scale);
		}
		const room = Math.max(free.length * 24, tableWidth - fixedTotal);
		const weights = free.map((index) => Math.max(wanted[index] ?? 0, 24));
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		free.forEach((index, position) => {
			widths[index] = (room * (weights[position] as number)) / total;
		});
		return widths;
	}
}

/** The `src` of every image in the template. */
export function imageSources(nodes: readonly HtmlNode[]): string[] {
	const sources = new Set<string>();
	const walk = (list: readonly HtmlNode[]): void => {
		for (const node of list) {
			if (node.type !== "element") continue;
			if (node.tag === "img" && node.attrs.src !== undefined && node.attrs.src.trim() !== "")
				sources.add(node.attrs.src.trim());
			walk(node.children);
		}
	};
	walk(nodes);
	return [...sources];
}

/** `text` across the middle of every page, turned 45 degrees, in a large faint red that leaves what is under it readable. */
function drawWatermark(doc: PDFKit.PDFDocument, text: string): void {
	const label = toWinAnsi(text);
	const range = doc.bufferedPageRange();
	for (let index = range.start; index < range.start + range.count; index++) {
		doc.switchToPage(index);
		const { width, height } = doc.page;
		doc.save();
		doc.font("Helvetica-Bold").fontSize(110).fillColor("#c0392b").fillOpacity(0.16);
		doc.rotate(-45, { origin: [width / 2, height / 2] });
		doc.text(label, (width - doc.widthOfString(label)) / 2, height / 2 - 55, { lineBreak: false });
		doc.restore();
	}
}

/** Lay the template out and return the PDF. */
export function renderPdf(template: ParsedTemplate, options: PdfOptions): Promise<Buffer> {
	const doc = new PDFDocument({
		size: template.pageSize === "Letter" ? "LETTER" : "A4",
		margin: MARGIN,
		compress: options.compress ?? true,
		// A watermark is drawn on pages that are finished, so they are kept until the end.
		...(options.watermark === undefined ? {} : { bufferPages: true }),
		info: {
			Title: toWinAnsi(options.title ?? template.title ?? "Invoice"),
			...(options.author === undefined ? {} : { Author: toWinAnsi(options.author) }),
			Creator: "Assistant",
		},
	});
	const chunks: Buffer[] = [];
	const done = new Promise<Buffer>((resolve, reject) => {
		doc.on("data", (chunk: Buffer) => chunks.push(chunk));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);
	});
	try {
		const painter = new Painter(doc, template.pageSize, options.images);
		painter.paintBlocks(template.nodes, painter.frame, BASE);
		if (options.watermark !== undefined) drawWatermark(doc, options.watermark);
		doc.end();
	} catch (error) {
		doc.end();
		done.catch(() => {});
		return Promise.reject(error);
	}
	return done;
}
