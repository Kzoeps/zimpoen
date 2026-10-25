import { type FileSummary, MAX_UPLOAD_BYTES } from "@assistant/shared";
import { describe, expect, it } from "vitest";
import {
	type Attachment,
	attached,
	failed,
	finished,
	isUploading,
	MAX_ATTACHMENTS,
	progressed,
	refusal,
	removed,
	started,
} from "../src/lib/attachments.ts";

const stored = (id: string, name: string, mime = "image/png"): FileSummary => ({
	id,
	name,
	mime,
	kind: mime.startsWith("image/") ? "image" : "csv",
	size: 2048,
	source: "upload",
	addedAt: 1,
});

const empty: Attachment[] = [];

describe("the files being attached to a message", () => {
	it("moves a file from uploading to ready and names only the ready ones in the message", () => {
		let list = started(empty, "a", { name: "receipt.png", size: 2048 });
		list = started(list, "b", { name: "bank.csv", size: 4096 });
		list = progressed(list, "a", 0.5);
		expect(list.map((item) => [item.key, item.status, item.progress])).toStrictEqual([
			["a", "uploading", 0.5],
			["b", "uploading", 0],
		]);
		expect(isUploading(list)).toBe(true);
		expect(attached(list)).toStrictEqual([]);

		list = finished(list, "a", stored("fi_0a1b2c3d", "receipt.png"));

		expect(isUploading(list)).toBe(true); // b is still going: the send button waits
		expect(attached(list)).toStrictEqual([{ id: "fi_0a1b2c3d", name: "receipt.png", mime: "image/png", size: 2048 }]);
	});

	it("keeps the order the files were picked in, not the order they finished in", () => {
		let list = started(started(empty, "a", { name: "one.png", size: 1 }), "b", { name: "two.csv", size: 1 });
		list = finished(list, "b", stored("fi_bbbbbbbb", "two.csv", "text/csv"));
		list = finished(list, "a", stored("fi_aaaaaaaa", "one.png"));

		expect(attached(list).map((file) => file.id)).toStrictEqual(["fi_aaaaaaaa", "fi_bbbbbbbb"]);
	});

	it("shows the name the server stored, which is the one the message will carry", () => {
		const list = finished(
			started(empty, "a", { name: "my receipt (1).png", size: 1 }),
			"a",
			stored("fi_0a1b2c3d", "my receipt 1.png"),
		);

		expect(list[0]).toMatchObject({ name: "my receipt 1.png", status: "ready", progress: 1 });
	});

	it("does not send a file that failed, and says why", () => {
		let list = started(empty, "a", { name: "notes.exe", size: 1 });
		list = failed(list, "a", "The assistant takes images, PDFs, CSV and text files.");

		expect(list[0]).toMatchObject({ status: "error", error: "The assistant takes images, PDFs, CSV and text files." });
		expect(isUploading(list)).toBe(false);
		expect(attached(list)).toStrictEqual([]);
	});

	it("does not let a late progress report bring a finished or failed file back to uploading", () => {
		const done = finished(started(empty, "a", { name: "a.png", size: 1 }), "a", stored("fi_0a1b2c3d", "a.png"));
		const broken = failed(started(empty, "b", { name: "b.png", size: 1 }), "b", "no");

		expect(progressed(done, "a", 0.3)[0]).toMatchObject({ status: "ready", progress: 1 });
		expect(progressed(broken, "b", 0.3)[0]).toMatchObject({ status: "error", progress: 0 });
	});

	it("takes a file off the list in any state, and leaves the others", () => {
		let list = started(started(empty, "a", { name: "a.png", size: 1 }), "b", { name: "b.png", size: 1 });
		list = finished(list, "a", stored("fi_0a1b2c3d", "a.png"));

		expect(removed(list, "a").map((item) => item.key)).toStrictEqual(["b"]);
		expect(removed(list, "b").map((item) => item.key)).toStrictEqual(["a"]);
		expect(removed(list, "missing")).toHaveLength(2);
	});
});

describe("which files are not even tried", () => {
	it("lets an ordinary file through", () => {
		expect(refusal({ name: "receipt.png", size: 2048 }, empty)).toBeUndefined();
		expect(refusal({ name: "limit.csv", size: MAX_UPLOAD_BYTES }, empty)).toBeUndefined();
	});

	it("names the size and the limit of a file that is too big", () => {
		expect(refusal({ name: "video.png", size: MAX_UPLOAD_BYTES + 1 }, empty)).toBe(
			"“video.png” is 20.0 MB; the most the assistant takes is 20.0 MB.",
		);
		expect(refusal({ name: "scan.pdf", size: 25 * 1024 * 1024 }, empty)).toMatch(/“scan\.pdf” is 25\.0 MB/);
	});

	it("refuses an empty file", () => {
		expect(refusal({ name: "blank.txt", size: 0 }, empty)).toBe("“blank.txt” is empty.");
	});

	it(`refuses the ${MAX_ATTACHMENTS + 1}th file of a message and says what to do`, () => {
		let list = empty;
		for (let index = 0; index < MAX_ATTACHMENTS; index++)
			list = started(list, `k${index}`, { name: `f${index}.png`, size: 1 });

		expect(refusal({ name: "one-more.png", size: 1 }, list)).toMatch(
			new RegExp(`carry ${MAX_ATTACHMENTS} files.*“one-more\\.png” to the next`),
		);
		// A file that was removed makes room again.
		expect(refusal({ name: "one-more.png", size: 1 }, removed(list, "k0"))).toBeUndefined();
	});
});
