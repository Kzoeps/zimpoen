/**
 * The CTO's way to the owner's coding lead (herdr-lead, PLAN upgrade §6–7). Everything the CTO does on the board goes
 * through this narrow interface: the server implements it with fixed argv to `hc-board` and `hc` (no shell), tests with
 * {@link createFakeCodingLead}.
 */
export type CardRequest = {
	/** The tool call id: stored on the card, so creating twice with the same key returns the same card. */
	key: string;
	repo: string;
	goal: string;
	doneWhen: string;
	outOfScope: string;
};

/** What `hc-board show <id>` says about a card, read back for `board_status`. */
export type CodingCard = {
	id: string;
	status: string;
	title?: string;
	note?: string;
	pr?: string;
	/** Path of the worker's report file on the lead's machine. */
	report?: string;
};

export interface CodingLead {
	/** Open a card for the lead. Idempotent by `key`. Returns the card's id. */
	createCard(request: CardRequest): Promise<{ cardId: string }>;
	/** Tell the lead a card is waiting (`hc send lead …` with fixed text naming the card). */
	notifyLead(cardId: string): Promise<void>;
	/** The card as the board has it now; undefined when the board has no such card. */
	readCard(cardId: string): Promise<CodingCard | undefined>;
}

/** A card id as the board makes them: no leading dash, nothing a shell or an option parser could read as more. */
export const CARD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The only text the lead is ever sent: fixed words and a validated card id. */
export const leadMessage = (cardId: string): string =>
	`New coding card ${cardId} from zimpoen's CTO. Read it with: hc-board show ${cardId}`;

/**
 * Parse `hc-board show` output: a first line `<id> [<status>] <title>`, then `  <field>: <value>` lines. Undefined
 * when the first line is not a card.
 */
export function parseCardShow(output: string): CodingCard | undefined {
	const lines = output.split("\n");
	const head = /^(\S+) \[([a-z]+)\] ?(.*)$/.exec(lines[0]?.trim() ?? "");
	if (head === null) return undefined;
	const card: CodingCard = { id: head[1] ?? "", status: head[2] ?? "" };
	if (head[3]) card.title = head[3];
	for (const line of lines.slice(1)) {
		const field = /^ {2}(note|pr|report): (.*)$/.exec(line);
		if (field === null) continue;
		const [, name, value] = field;
		if (name === "note" || name === "pr" || name === "report") card[name] = value ?? "";
	}
	return card;
}

export type FakeCodingLead = CodingLead & {
	cards: Map<string, CardRequest & CodingCard>;
	notified: string[];
	/** Make the next call of a method throw once. */
	failNext: Set<"createCard" | "notifyLead" | "readCard">;
};

/** An in-memory board for tests: idempotent by key, like the real one must be. */
export function createFakeCodingLead(): FakeCodingLead {
	const cards = new Map<string, CardRequest & CodingCard>();
	const notified: string[] = [];
	const failNext = new Set<"createCard" | "notifyLead" | "readCard">();
	const maybeFail = (method: "createCard" | "notifyLead" | "readCard") => {
		if (failNext.delete(method)) throw new Error(`${method} failed (fake)`);
	};
	return {
		cards,
		notified,
		failNext,
		async createCard(request) {
			maybeFail("createCard");
			const existing = [...cards.values()].find((card) => card.key === request.key);
			if (existing !== undefined) return { cardId: existing.id };
			const id = `card-${cards.size + 1}`;
			cards.set(id, { ...request, id, status: "planned", title: request.goal.slice(0, 60) });
			return { cardId: id };
		},
		async notifyLead(cardId) {
			maybeFail("notifyLead");
			notified.push(cardId);
		},
		async readCard(cardId) {
			maybeFail("readCard");
			return cards.get(cardId);
		},
	};
}
