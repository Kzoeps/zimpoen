import { describe, expect, it } from "vitest";
import { type AttachmentRef, attachmentLine, formatSize, splitAttachments, withAttachments } from "../src/files.ts";

const receipt: AttachmentRef = { id: "fi_0a1b2c3d", name: "receipt.png", mime: "image/png", size: 340 * 1024 };
const bank: AttachmentRef = { id: "fi_deadbeef", name: "bank march.csv", mime: "text/csv", size: 1.5 * 1024 * 1024 };

describe("sizes for people", () => {
	it.each([
		[0, "0 B"],
		[1023, "1023 B"],
		[1024, "1 KB"],
		[340 * 1024, "340 KB"],
		[1.5 * 1024 * 1024, "1.5 MB"],
		[20 * 1024 * 1024, "20.0 MB"],
	])("writes %d bytes as %s", (bytes, text) => {
		expect(formatSize(bytes)).toBe(text);
	});
});

describe("naming files in a message", () => {
	it("writes one line per file after the words, which is what the model reads", () => {
		expect(withAttachments("Here is the bank statement", [receipt, bank])).toBe(
			[
				"Here is the bank statement",
				"",
				"[Attached file: receipt.png · image/png · 340 KB · id fi_0a1b2c3d]",
				"[Attached file: bank march.csv · text/csv · 1.5 MB · id fi_deadbeef]",
			].join("\n"),
		);
	});

	it("is the plain text when there are no files, and only the lines when there are no words", () => {
		expect(withAttachments("hello", [])).toBe("hello");
		expect(withAttachments("  \n", [receipt])).toBe(attachmentLine(receipt));
	});

	it("reads the lines back into files and gives the words back without them", () => {
		const sent = withAttachments("Here is the bank statement\nand the receipt", [receipt, bank]);

		expect(splitAttachments(sent)).toStrictEqual({
			text: "Here is the bank statement\nand the receipt",
			files: [
				{ id: "fi_0a1b2c3d", name: "receipt.png", mime: "image/png", size: 0, sizeText: "340 KB" },
				{ id: "fi_deadbeef", name: "bank march.csv", mime: "text/csv", size: 0, sizeText: "1.5 MB" },
			],
		});
	});

	it("finds a message made of lines only, and a message without any", () => {
		expect(splitAttachments(attachmentLine(receipt))).toMatchObject({ text: "", files: [{ id: "fi_0a1b2c3d" }] });
		expect(splitAttachments("just words\nover two lines")).toStrictEqual({
			text: "just words\nover two lines",
			files: [],
		});
	});

	it("keeps a line that only looks like a reference as part of the words", () => {
		for (const line of [
			"[Attached file: x.png · image/png · 1 KB]", // no id
			"[Attached file: x.png · image/png · 1 KB · id fi_123]", // id too short
			"[Attached file: x.png · image/png · 1 KB · id fi_0A1B2C3D]", // ids are lower-case hex
			"[Attached file: x.png · not a type · 1 KB · id fi_0a1b2c3d]",
			"see [Attached file: x.png · image/png · 1 KB · id fi_0a1b2c3d]", // not the whole line
		]) {
			expect(splitAttachments(`words\n${line}`)).toStrictEqual({ text: `words\n${line}`, files: [] });
		}
	});

	it("only reads references from the end: one in the middle of the words stays words", () => {
		const middle = attachmentLine(receipt);

		expect(splitAttachments(`${middle}\nand then I kept typing`)).toStrictEqual({
			text: `${middle}\nand then I kept typing`,
			files: [],
		});
	});
});
