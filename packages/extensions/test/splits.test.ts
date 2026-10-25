import type { SplitCard, ToolCard, WhoOwesCard } from "@assistant/shared";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { netEntries, renderSplitsSection, splitEqually, splitItems, splitsStore } from "../src/index.ts";
import { type Fixture, openFixture, say, textOf, toolCall } from "./support.ts";

const fixtures: Fixture[] = [];
async function open(options: Parameters<typeof openFixture>[0] = {}): Promise<Fixture> {
	const fixture = await openFixture({ accountant: { currency: "BTN" }, ...options });
	fixtures.push(fixture);
	return fixture;
}
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.close().catch(() => {});
		await fixture.dispose();
	}
});

const card = <T extends ToolCard>(result: ToolExecutionResult): T => result.details as unknown as T;
let calls = 0;
const nextId = (): string => `call-${++calls}`;
const split = (f: Fixture, args: Record<string, unknown>, id = nextId()) => f.callTool("split_bill", args, id);
const owes = async (f: Fixture, args: Record<string, unknown> = {}) =>
	card<WhoOwesCard>(await f.callTool("who_owes", args, nextId()));

/** A tiny seeded generator, so a failing random bill can be reproduced. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

describe("sharing a total equally", () => {
	it("gives the units that do not divide to the first people, and adds up exactly", () => {
		const result = splitEqually(["a", "b", "c"], 10_000);
		expect(result.shares.map((share) => share.owedMinor)).toEqual([3334, 3333, 3333]);
		expect(result.totalMinor).toBe(10_000);
	});

	it("refuses nobody, and a total that is not above zero", () => {
		expect(() => splitEqually([], 100)).toThrow(/at least one person/);
		expect(() => splitEqually(["a"], 0)).toThrow(/above zero/);
	});
});

describe("sharing items", () => {
	it("rounds once per person, so three equal items over three people do not favour the first", () => {
		const item = (description: string) => ({ description, amountMinor: 100, sharedBy: ["a", "b", "c"] });
		const three = splitItems(["a", "b", "c"], [item("x"), item("y"), item("z")], []);
		expect(three.shares.map((share) => share.owedMinor)).toEqual([100, 100, 100]);
		const one = splitItems(["a", "b", "c"], [item("x")], []);
		expect(one.shares.map((share) => share.owedMinor)).toEqual([34, 33, 33]);
	});

	it("shares an extra in proportion to what each person's items came to", () => {
		const result = splitItems(
			["a", "b"],
			[
				{ description: "momos", amountMinor: 90_000, sharedBy: ["a"] },
				{ description: "thukpa", amountMinor: 180_000, sharedBy: ["b"] },
			],
			[{ label: "Service charge", basisPoints: 1000 }],
		);
		expect(result.extras).toEqual([{ label: "Service charge", amountMinor: 27_000 }]);
		expect(result.shares).toEqual([
			{ key: "a", itemsMinor: 90_000, extrasMinor: 9_000, owedMinor: 99_000 },
			{ key: "b", itemsMinor: 180_000, extrasMinor: 18_000, owedMinor: 198_000 },
		]);
	});

	it("takes a percentage of the items alone, never of the other extras, and a discount is negative", () => {
		const result = splitItems(
			["a", "b"],
			[{ description: "dinner", amountMinor: 100_000, sharedBy: ["a", "b"] }],
			[
				{ label: "Service", basisPoints: 1000 },
				{ label: "GST", basisPoints: 500 },
				{ label: "Voucher", amountMinor: -5_000 },
			],
		);
		expect(result.extras.map((extra) => extra.amountMinor)).toEqual([10_000, 5_000, -5_000]);
		expect(result.totalMinor).toBe(110_000);
		expect(result.shares.map((share) => share.owedMinor)).toEqual([55_000, 55_000]);
	});

	it("refuses a bill that would not be above zero, an item nobody had, and a sharer who is not there", () => {
		const base = { description: "x", amountMinor: 1_000 };
		expect(() =>
			splitItems(["a"], [{ ...base, sharedBy: ["a"] }], [{ label: "Voucher", amountMinor: -1_000 }]),
		).toThrow(/not be above zero/);
		expect(() => splitItems(["a"], [{ ...base, sharedBy: [] }], [])).toThrow(/Nobody shares 'x'/);
		expect(() => splitItems(["a"], [{ ...base, sharedBy: ["zed"] }], [])).toThrow(/not one of the people/);
	});

	it("adds up to the total exactly over many random bills, with every share within one unit of its exact claim", () => {
		const next = random(20_261_025);
		const pick = (n: number): number => Math.floor(next() * n);
		for (let round = 0; round < 600; round++) {
			const keys = Array.from({ length: 1 + pick(6) }, (_, index) => `p${index}`);
			const items = Array.from({ length: 1 + pick(8) }, (_, index) => {
				const sharers = keys.filter(() => next() < 0.6);
				return {
					description: `item ${index}`,
					amountMinor: 1 + pick(200_000),
					sharedBy: sharers.length === 0 ? [keys[pick(keys.length)] as string] : sharers,
				};
			});
			const itemsTotal = items.reduce((sum, item) => sum + item.amountMinor, 0);
			const extras = [
				...(next() < 0.7 ? [{ label: "Service", basisPoints: 100 * (1 + pick(15)) }] : []),
				...(next() < 0.5 ? [{ label: "GST", basisPoints: 50 * (1 + pick(20)) }] : []),
				...(next() < 0.3
					? [{ label: "Discount", amountMinor: -pick(Math.max(1, Math.floor(itemsTotal / 4))) - 1 }]
					: []),
			];
			const result = splitItems(keys, items, extras);

			expect(result.shares.reduce((sum, share) => sum + share.owedMinor, 0)).toBe(result.totalMinor);
			expect(result.shares.reduce((sum, share) => sum + share.itemsMinor, 0)).toBe(itemsTotal);
			expect(result.shares.reduce((sum, share) => sum + share.extrasMinor, 0)).toBe(result.extrasMinor);
			for (const share of result.shares) expect(share.owedMinor).toBeGreaterThanOrEqual(0);

			// Each person's part of the items is the floor or the ceiling of what they had, to the exact fraction.
			const common = items.reduce((value, item) => {
				const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
				const n = BigInt(item.sharedBy.length);
				return (value / gcd(value, n)) * n;
			}, 1n);
			for (const share of result.shares) {
				let claim = 0n;
				for (const item of items) {
					if (item.sharedBy.includes(share.key))
						claim += BigInt(item.amountMinor) * (common / BigInt(item.sharedBy.length));
				}
				const difference = BigInt(share.itemsMinor) * common - claim;
				expect(difference < common && difference > -common).toBe(true);
			}
		}
	});
});

describe("netting what people owe", () => {
	it("cancels opposite debts, counts a settlement as a payment, and keeps currencies apart", () => {
		const net = netEntries([
			{ from: "me", to: "pema", amountMinor: 30_000, currency: "BTN" },
			{ from: "pema", to: "me", amountMinor: 10_000, currency: "BTN" },
			{ from: "tashi", to: "me", amountMinor: 5_000, currency: "BTN" },
			{ from: "tashi", to: "me", amountMinor: -5_000, currency: "BTN" },
			{ from: "tashi", to: "me", amountMinor: 700, currency: "USD" },
		]);
		expect(net).toEqual([
			{ debtor: "me", creditor: "pema", amountMinor: 20_000, currency: "BTN" },
			{ debtor: "tashi", creditor: "me", amountMinor: 700, currency: "USD" },
		]);
	});
});

describe("split_bill", () => {
	it("shares a total equally, with the owner first so the odd unit lands on them, and says who owes the payer", async () => {
		const f = await open();
		const result = await split(f, {
			title: "Dinner at Folk Heritage",
			payer: "Pema",
			people: ["me", "Pema", "Tashi"],
			total: 1000,
		});
		const split_ = card<SplitCard>(result);
		expect(split_).toMatchObject({
			type: "split",
			title: "Dinner at Folk Heritage",
			payer: "Pema",
			currency: "BTN",
			totalMinor: 100_000,
			equal: true,
			items: [],
		});
		expect(split_.dateText).toBe("Sun 25 Oct 2026");
		expect(split_.shares.map((share) => [share.person, share.owedMinor, share.paid])).toEqual([
			["You", 33_334, false],
			["Pema", 33_333, true],
			["Tashi", 33_333, false],
		]);
		const words = textOf(result);
		expect(words).toContain("total Nu. 1,000.00, paid by Pema, shared equally");
		expect(words).toContain("They add up to Nu. 1,000.00");
		expect(words).toContain("You owe Pema Nu. 333.34; Tashi owes Pema Nu. 333.33.");
		expect(words).toContain("Pema's own share, Nu. 333.33, is not a debt.");
		expect(words).toContain("Your share: Nu. 333.34. It is not added to your expenses");
		expect((await owes(f)).debts).toEqual([
			{ debtor: "You", creditor: "Pema", amountMinor: 33_334, currency: "BTN" },
			{ debtor: "Tashi", creditor: "Pema", amountMinor: 33_333, currency: "BTN" },
		]);
	});

	it("splits items, shares the service charge and the tax in proportion, and checks the total on the bill", async () => {
		const f = await open();
		const result = await split(f, {
			title: "Lunch",
			payer: "Pema",
			people: ["me", "Pema", "Tashi"],
			items: [
				{ description: "Momos", amount: 450, shared_by: ["me", "Pema"] },
				{ description: "Thukpa", amount: 300, shared_by: ["Tashi"] },
				{ description: "Ema datshi", amount: 250 },
				{ description: "Tea", amount: 90, shared_by: ["me"] },
			],
			extras: [
				{ label: "Service charge", percent: 10 },
				{ label: "GST", percent: 5 },
			],
			total: 1253.5,
		});
		const split_ = card<SplitCard>(result);
		expect(split_.totalMinor).toBe(125_350);
		expect(split_.extras).toEqual([
			{ label: "Service charge", amountMinor: 10_900 },
			{ label: "GST", amountMinor: 5_450 },
		]);
		expect(split_.items.map((item) => [item.description, item.amountMinor, item.sharedBy])).toEqual([
			["Momos", 45_000, ["You", "Pema"]],
			["Thukpa", 30_000, ["Tashi"]],
			["Ema datshi", 25_000, ["You", "Pema", "Tashi"]],
			["Tea", 9_000, ["You"]],
		]);
		expect(split_.shares.map((share) => [share.person, share.itemsMinor, share.extrasMinor, share.owedMinor])).toEqual([
			["You", 39_834, 5_975, 45_809],
			["Pema", 30_833, 4_625, 35_458],
			["Tashi", 38_333, 5_750, 44_083],
		]);
		expect(split_.shares.reduce((sum, share) => sum + share.owedMinor, 0)).toBe(split_.totalMinor);
		expect(textOf(result)).toContain("Items Nu. 1,090.00; Service charge Nu. 109.00; GST Nu. 54.50.");
	});

	it("names the difference when the total on the bill is not what the items add up to, and stores nothing", async () => {
		const f = await open();
		await expect(
			split(f, {
				title: "Lunch",
				payer: "me",
				people: ["me", "Pema"],
				items: [{ description: "Momos", amount: 450 }],
				extras: [{ label: "Service charge", percent: 10 }],
				total: 500,
			}),
		).rejects.toThrow(
			/items come to Nu\. 450\.00 and the extras to Nu\. 45\.00, Nu\. 495\.00 together, but total says Nu\. 500\.00 \(Nu\. 5\.00 more\)/,
		);
		expect(splitsStore.listBills(f.db, { limit: 10 }).total).toBe(0);
	});

	it("lets the payer be someone who did not eat, and says so", async () => {
		const f = await open();
		const result = await split(f, { title: "Taxi", payer: "Pema", people: ["me", "Tashi"], total: 600 });
		expect(card<SplitCard>(result).shares.map((share) => [share.person, share.owedMinor, share.paid])).toEqual([
			["You", 30_000, false],
			["Tashi", 30_000, false],
		]);
		expect(textOf(result)).toContain("Pema paid but is not among the people who shared it, so has no share.");
		expect((await owes(f)).debts.map((debt) => `${debt.debtor}>${debt.creditor}`)).toEqual(["You>Pema", "Tashi>Pema"]);
	});

	it("takes the owner under any of their names, so one person never appears twice", async () => {
		const f = await open({ accountant: { currency: "BTN", ownerName: "Dorje Tsering" } });
		const result = await split(f, {
			title: "Tea",
			payer: "Dorje Tsering",
			people: ["I", "Pema", "me", "Dorje Tsering"],
			total: 90,
		});
		expect(card<SplitCard>(result).shares.map((share) => share.person)).toEqual(["You", "Pema"]);
		expect(card<SplitCard>(result).payer).toBe("You");
		expect(textOf(await f.callTool("who_owes", {}, nextId()))).toContain("Pema owes you Nu. 45.00");
	});

	it("refuses what cannot be a bill, with what to send instead", async () => {
		const f = await open();
		const base = { title: "Dinner", payer: "me", people: ["me", "Pema"] };
		await expect(split(f, { ...base, people: ["me"] })).rejects.toThrow(/Only You shares this bill/);
		await expect(split(f, base)).rejects.toThrow(/Give either items .* or total/);
		await expect(split(f, { ...base, total: 100, extras: [{ label: "GST", percent: 5 }] })).rejects.toThrow(
			/extras need items/,
		);
		await expect(
			split(f, { ...base, items: [{ description: "Momos", amount: 100, shared_by: ["Karma"] }] }),
		).rejects.toThrow(/shared_by names Karma, who is not in people \(You, Pema\)/);
		await expect(split(f, { ...base, items: [{ description: "Momos", amount: 100.123 }] })).rejects.toThrow(
			/more decimals than BTN has/,
		);
		await expect(
			split(f, { ...base, items: [{ description: "Momos", amount: 100 }], extras: [{ label: "GST" }] }),
		).rejects.toThrow(/exactly one of amount .* or percent/);
		await expect(split(f, { ...base, total: 100, date: "2026-12-01" })).rejects.toThrow(/in the future/);
		await expect(split(f, { ...base, total: 100, receipt_file_id: "fi_00000000" })).rejects.toThrow(/No file/);
		expect(splitsStore.listBills(f.db, { limit: 10 }).total).toBe(0);
	});

	it("writes a call once: a replay answers the same words and adds no bill", async () => {
		const f = await open();
		const args = { title: "Dinner", payer: "Pema", people: ["me", "Pema", "Tashi"], total: 1000 };
		const first = await split(f, args, "same-call");
		f.clock.now += 3 * 24 * 60 * 60 * 1000; // a replay after a restart may be days later: it must not read "today" again
		const replay = await split(f, { ...args, total: 5 }, "same-call");
		expect(textOf(replay)).toBe(textOf(first));
		expect(replay.details).toEqual(first.details);
		expect(splitsStore.listBills(f.db, { limit: 10 }).total).toBe(1);
		const shares = f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM splits_share");
		expect(shares?.n).toBe(3);
	});

	it("warns that a name that begins like a known one may be a second person", async () => {
		const f = await open();
		await split(f, { title: "Dinner", payer: "me", people: ["me", "Pema Dorji"], total: 100 });
		const result = await split(f, { title: "Lunch", payer: "me", people: ["me", "Pema"], total: 100 });
		expect(textOf(result)).toContain("'Pema' is new here, and 'Pema Dorji' appears in earlier bills");
		expect((await owes(f)).debts).toHaveLength(2);
	});

	it("links a friend to the birthday list only when exactly one person there has that name", async () => {
		const f = await open();
		await f.callTool("add_person", { name: "Pema Choden", birthday: "10-27" }, "p1");
		await split(f, { title: "Dinner", payer: "me", people: ["me", "pema choden", "Tashi"], total: 300 });
		const rows = f.db.all<{ person_key: string; person_id: string | null }>(
			"SELECT person_key, person_id FROM splits_share ORDER BY rowid",
		);
		expect(rows.map((row) => [row.person_key, row.person_id !== null])).toEqual([
			["me", false],
			["pema choden", true],
			["tashi", false],
		]);
	});

	it("keeps a bill in another currency apart and links the photo of the bill", async () => {
		const f = await open();
		f.db.run(
			"INSERT INTO files_index (id, path, name, mime, kind, size, source, added_at, updated_at) VALUES ('fi_aaaa0001', '/x/bill.jpg', 'bill.jpg', 'image/jpeg', 'image', 10, 'upload', 1, 1)",
		);
		await split(f, {
			title: "Hotel",
			payer: "me",
			people: ["me", "Pema"],
			total: 80,
			currency: "usd",
			receipt_file_id: "fi_aaaa0001",
		});
		await split(f, { title: "Taxi", payer: "Pema", people: ["me", "Pema"], total: 100 });
		expect(splitsStore.listBills(f.db, { limit: 10 }).bills.find((bill) => bill.title === "Hotel")?.sourceRef).toBe(
			"fi_aaaa0001",
		);
		expect((await owes(f)).debts).toEqual([
			{ debtor: "You", creditor: "Pema", amountMinor: 5_000, currency: "BTN" },
			{ debtor: "Pema", creditor: "You", amountMinor: 4_000, currency: "USD" },
		]);
	});
});

describe("who_owes and record_settlement", () => {
	it("nets bills in both directions per pair of people", async () => {
		const f = await open();
		await split(f, { title: "Dinner", payer: "Pema", people: ["me", "Pema"], total: 800 }); // I owe 400
		await split(f, { title: "Lunch", payer: "me", people: ["me", "Pema"], total: 300 }); // Pema owes 150
		const result = await f.callTool("who_owes", {}, nextId());
		expect(textOf(result)).toContain("You owe Pema Nu. 250.00");
		expect(card<WhoOwesCard>(result).debts).toHaveLength(1);
	});

	it("says when nothing is owed, for everyone and for one person", async () => {
		const f = await open();
		expect(textOf(await f.callTool("who_owes", {}, nextId()))).toBe("Nothing is owed: no bill has been split yet.");
		await split(f, { title: "Dinner", payer: "me", people: ["me", "Pema"], total: 800 });
		await f.callTool("record_settlement", { from: "Pema", to: "me", amount: 400 }, nextId());
		expect(textOf(await f.callTool("who_owes", {}, nextId()))).toBe("Nothing is owed: every bill is settled.");
		expect(textOf(await f.callTool("who_owes", { person: "pema" }, nextId()))).toContain("Pema has nothing open");
	});

	it("filters by person, by a part of the name, and says who is known when the name is not", async () => {
		const f = await open();
		await split(f, { title: "Dinner", payer: "me", people: ["me", "Pema Dorji", "Tashi"], total: 900 });
		expect((await owes(f, { person: "Tashi" })).debts.map((debt) => debt.debtor)).toEqual(["Tashi"]);
		expect((await owes(f, { person: "dorji" })).debts.map((debt) => debt.debtor)).toEqual(["Pema Dorji"]);
		expect((await owes(f, { person: "me" })).debts).toHaveLength(2);
		await expect(f.callTool("who_owes", { person: "Karma" }, nextId())).rejects.toThrow(
			/No bill or payment mentions 'Karma'. People so far: Pema Dorji, Tashi/,
		);
	});

	it("records a part payment, a full one, and one that is more than was owed", async () => {
		const f = await open();
		await split(f, { title: "Dinner", payer: "me", people: ["me", "Pema"], total: 2000 }); // Pema owes 1,000
		const part = await f.callTool("record_settlement", { from: "Pema", to: "me", amount: 400 }, nextId());
		expect(textOf(part)).toContain("Recorded: Pema paid you Nu. 400.00 on Sun 25 Oct 2026");
		expect(textOf(part)).toContain("Pema owes you Nu. 600.00 still.");
		expect(textOf(part)).toContain("does not change the owner's accounts");

		const full = await f.callTool("record_settlement", { from: "Pema", to: "me", amount: 600 }, nextId());
		expect(textOf(full)).toContain("Pema and you are settled up.");

		const more = await f.callTool("record_settlement", { from: "Pema", to: "me", amount: 50 }, nextId());
		expect(textOf(more)).toContain("That is more than was owed. Now you owe Pema Nu. 50.00.");
		expect((await owes(f)).debts).toEqual([{ debtor: "You", creditor: "Pema", amountMinor: 5_000, currency: "BTN" }]);

		const reverse = await f.callTool("record_settlement", { from: "me", to: "Pema", amount: 50 }, nextId());
		expect(textOf(reverse)).toContain("You and Pema are settled up.");
		expect((await owes(f)).debts).toEqual([]);
	});

	it("records a payment once per call, and refuses the same person twice or an amount that is not above zero", async () => {
		const f = await open();
		await split(f, { title: "Dinner", payer: "me", people: ["me", "Pema"], total: 2000 });
		const first = await f.callTool("record_settlement", { from: "Pema", to: "me", amount: 400 }, "pay-1");
		const replay = await f.callTool("record_settlement", { from: "Pema", to: "me", amount: 999 }, "pay-1");
		expect(textOf(replay)).toBe(textOf(first));
		expect(splitsStore.listSettlements(f.db, { limit: 10 }).total).toBe(1);
		await expect(f.callTool("record_settlement", { from: "me", to: "I", amount: 5 }, nextId())).rejects.toThrow(
			/Both are You/,
		);
		await expect(f.callTool("record_settlement", { from: "Pema", to: "me", amount: 0 }, nextId())).rejects.toThrow(
			/above zero|must be/,
		);
	});

	describe("a name that is only part of a friend's", () => {
		it("records nothing, asks which person, and leaves the real debt open instead of reversing it", async () => {
			const f = await open();
			await split(f, { title: "Dinner", payer: "me", people: ["me", "Pema Dorji"], total: 1000 }); // Pema Dorji owes 500

			await expect(f.callTool("record_settlement", { from: "Pema", to: "me", amount: 500 }, "short")).rejects.toThrow(
				/Nothing was recorded: 'Pema' \(from\) could be 'Pema Dorji', who is already in the bills\..*call record_settlement again with the full name \('Pema Dorji'\).*new_person true/,
			);

			expect(splitsStore.listSettlements(f.db, { limit: 5 }).total).toBe(0);
			expect((await owes(f)).debts).toEqual([
				{ debtor: "Pema Dorji", creditor: "You", amountMinor: 50_000, currency: "BTN" },
			]);
			expect(splitsStore.knownPeople(f.db).has("pema")).toBe(false); // no second person was made

			const full = await f.callTool("record_settlement", { from: "Pema Dorji", to: "me", amount: 500 }, "full");
			expect(textOf(full)).toContain("Pema Dorji and you are settled up.");
			expect((await owes(f)).debts).toEqual([]);
		});

		it("asks the same for the one who was paid, for a surname, and when two friends share the word", async () => {
			const f = await open();
			await split(f, { title: "Dinner", payer: "me", people: ["me", "Pema Dorji", "Pema Lhamo"], total: 900 });

			await expect(f.callTool("record_settlement", { from: "me", to: "Pema", amount: 5 }, "to")).rejects.toThrow(
				/'Pema' \(to\) could be 'Pema Dorji' or 'Pema Lhamo', who are already in the bills/,
			);
			await expect(f.callTool("record_settlement", { from: "Lhamo", to: "me", amount: 5 }, "surname")).rejects.toThrow(
				/'Lhamo' \(from\) could be 'Pema Lhamo'/,
			);
			// A name with a word more than a known one is as doubtful as one with a word less.
			await expect(
				f.callTool("record_settlement", { from: "Pema Dorji Tshering", to: "me", amount: 5 }, "longer"),
			).rejects.toThrow(/could be 'Pema Dorji'/);
			expect(splitsStore.listSettlements(f.db, { limit: 5 }).total).toBe(0);
		});

		it("lets the owner say it is somebody else, and never asks about the owner, a whole name or a stranger", async () => {
			const f = await open();
			await split(f, { title: "Dinner", payer: "me", people: ["me", "Pema Dorji"], total: 1000 });

			const other = await f.callTool(
				"record_settlement",
				{ from: "Pema", to: "me", amount: 100, new_person: true },
				"other",
			);
			expect(textOf(other)).toContain("That is more than was owed. Now you owe Pema Nu. 100.00.");
			expect(splitsStore.knownPeople(f.db).get("pema")).toBe("Pema");

			// "Pema" is a whole-name match now, and a stranger has nothing in common with anyone.
			await f.callTool("record_settlement", { from: "Pema", to: "me", amount: 100 }, "again");
			await f.callTool("record_settlement", { from: "Karma", to: "me", amount: 10 }, "stranger");
			await f.callTool("record_settlement", { from: "I", to: "Karma", amount: 10 }, "owner");
			expect(splitsStore.listSettlements(f.db, { limit: 10 }).total).toBe(4);
		});

		it("keeps the warning on a bill, which may start a new person, and still asks nothing", async () => {
			const f = await open();
			await split(f, { title: "Dinner", payer: "me", people: ["me", "Pema Dorji"], total: 100 });
			const result = await split(f, { title: "Lunch", payer: "me", people: ["me", "Dorji"], total: 100 });
			expect(textOf(result)).toContain("'Dorji' is new here, and 'Pema Dorji' appears in earlier bills");
		});
	});

	it("keeps a payment between two friends apart from the owner's balances", async () => {
		const f = await open();
		await split(f, { title: "Trip", payer: "Pema", people: ["Pema", "Tashi"], total: 1000 }); // Tashi owes Pema 500
		await f.callTool("record_settlement", { from: "Tashi", to: "Pema", amount: 500 }, nextId());
		expect((await owes(f)).debts).toEqual([]);
	});
});

describe("finding and deleting a bill", () => {
	const lastResult = async (f: Fixture) =>
		(await f.entries())
			.flatMap((entry) => entry.model ?? [])
			.filter((message): message is ToolResultMessage => message.role === "toolResult")
			.at(-1);

	it("lists bills and payments with their ids, newest first", async () => {
		const f = await open();
		const first = card<SplitCard>(
			await split(f, { title: "Dinner", payer: "Pema", people: ["me", "Pema"], total: 800 }),
		);
		await f.callTool("record_settlement", { from: "me", to: "Pema", amount: 100 }, nextId());
		const listing = textOf(await f.callTool("list_splits", {}, nextId()));
		expect(listing).toContain(`${first.billId} · Sun 25 Oct 2026 · Dinner · Pema paid Nu. 800.00 · shared by 2`);
		expect(listing).toMatch(/s_[0-9a-f]{8} · Sun 25 Oct 2026 · You paid Pema Nu\. 100\.00/);
		expect(textOf(await f.callTool("list_splits", { person: "Pema", limit: 1 }, nextId()))).toContain("… and 1 more");
	});

	it("deletes nothing until the owner approves, and the hook blocks a call that skips the question", async () => {
		const f = await open();
		const bill = card<SplitCard>(
			await split(f, { title: "Dinner", payer: "Pema", people: ["me", "Pema"], total: 800 }),
		);

		f.faux.setResponses([toolCall("delete_split", { id: bill.billId }, "sneaky"), say("Blocked.")]);
		await f.say("just delete it");
		const blocked = await lastResult(f);
		expect(blocked?.isError).toBe(true);
		expect(JSON.stringify(blocked?.content)).toMatch(
			/Blocked: delete_split permanently changes data.*propose_delete_split/s,
		);
		expect(splitsStore.getBill(f.db, bill.billId)).toBeDefined();

		f.faux.setResponses([toolCall("propose_delete_split", { id: bill.billId }, "ask"), say("Please approve.")]);
		await f.say("delete the dinner");
		const approval = (await lastResult(f))?.details as unknown as Extract<ToolCard, { type: "approval" }>;
		expect(approval.summary).toBe(`Delete the bill 'Dinner' (${bill.billId}): Nu. 800.00 paid by Pema, shared by 2`);
		expect(splitsStore.getBill(f.db, bill.billId)).toBeDefined(); // waiting for the owner
		expect((await owes(f)).debts).toHaveLength(1);

		const state = await f.deps.approvals.decide(approval.actionId, "approve", "button");
		expect(state.status).toBe("executed");
		expect(splitsStore.getBill(f.db, bill.billId)).toBeUndefined();
		expect(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM splits_share")?.n).toBe(0);
		expect((await owes(f)).debts).toEqual([]);
	});

	it("deletes a payment when the owner approves, and says when an id is not one", async () => {
		const f = await open();
		await split(f, { title: "Dinner", payer: "me", people: ["me", "Pema"], total: 800 });
		const payment = await f.callTool("record_settlement", { from: "Pema", to: "me", amount: 400 }, nextId());
		const id = /s_[0-9a-f]{8}/.exec(textOf(payment))?.[0] ?? "";
		expect(splitsStore.getSettlement(f.db, id)).toBeDefined();
		f.faux.setResponses([toolCall("propose_delete_split", { id }, "ask-payment"), say("Please approve.")]);
		await f.say("that payment was a mistake");
		const approval = (await lastResult(f))?.details as unknown as Extract<ToolCard, { type: "approval" }>;
		expect(approval.summary).toBe(`Delete the payment Pema paid you Nu. 400.00 (${id})`);
		await f.deps.approvals.decide(approval.actionId, "approve", "button");
		expect((await owes(f)).debts).toEqual([{ debtor: "Pema", creditor: "You", amountMinor: 40_000, currency: "BTN" }]);
		await expect(f.callTool("propose_delete_split", { id: "b_00000000" }, nextId())).rejects.toThrow(
			/No bill or payment has the id 'b_00000000'/,
		);
	});
});

describe("the prompt section", () => {
	it("counts the open balances and names the first ones, with no clock in it", async () => {
		const f = await open();
		expect(renderSplitsSection(f.deps)).toBe("No bill has been split yet.");
		await split(f, { title: "Dinner", payer: "Pema", people: ["me", "Pema", "Tashi"], total: 900 });
		const before = renderSplitsSection(f.deps);
		expect(before).toBe(
			["Open balances between people: 2.", "- You owe Pema Nu. 300.00", "- Tashi owes Pema Nu. 300.00"].join("\n"),
		);
		f.clock.now += 40 * 24 * 60 * 60 * 1000;
		expect(renderSplitsSection(f.deps)).toBe(before);
		await f.callTool("record_settlement", { from: "me", to: "Pema", amount: 300 }, nextId());
		await f.callTool("record_settlement", { from: "Tashi", to: "Pema", amount: 300 }, nextId());
		expect(renderSplitsSection(f.deps)).toBe("No open balances: every bill is settled.");
	});

	it("lists five and counts the rest", async () => {
		const f = await open();
		const friends = ["Ani", "Bimal", "Chimi", "Dawa", "Ema", "Fiona", "Gyem"];
		await split(f, { title: "Party", payer: "me", people: ["me", ...friends], total: 800 });
		const lines = renderSplitsSection(f.deps).split("\n");
		expect(lines[0]).toBe("Open balances between people: 7.");
		expect(lines).toHaveLength(7);
		expect(lines.at(-1)).toBe("- and 2 more (who_owes lists them)");
	});
});
