import type { BotsResponse, BotView, TrustSettingsResponse } from "@assistant/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotListView } from "../src/components/bots-view.tsx";
import { TrustSettingsView } from "../src/components/trust-card.tsx";
import { draftProblem, EMPTY_DRAFT, requestOf, slugFromName, toggleTool } from "../src/lib/bots-form.ts";

const bot = (over: Partial<BotView> = {}): BotView => ({
	id: "bot:research",
	slug: "research",
	name: "Research",
	avatar: "🔎",
	soul: "You look things up.",
	tools: ["web", "memory"],
	approvedVia: "owner",
	createdAt: 1,
	...over,
});
const bots = (over: Partial<BotsResponse> = {}): BotsResponse => ({
	bots: [bot()],
	max: 8,
	presets: ["tasks-read", "documents", "web", "memory", "codemode"],
	maxSoulChars: 6000,
	maxNameChars: 40,
	...over,
});

const renderList = (data: BotsResponse | undefined, error?: string) =>
	renderToStaticMarkup(
		createElement(BotListView, {
			data,
			error,
			remove: (item: BotView) => createElement("button", { type: "button", "data-delete": item.slug }, "Delete"),
		}),
	);

describe("Bots page", () => {
	it("lists each bot with its chat link, id, tools and a delete control, and counts against the cap", () => {
		const markup = renderList(
			bots({ bots: [bot(), bot({ slug: "notes", id: "bot:notes", name: "Notes", tools: [], approvedVia: "open" })] }),
		);
		expect(markup).toContain("2 of 8 bots");
		expect(markup).toContain('href="/chat/bot:research"');
		expect(markup).toContain("<code>bot:research</code>");
		expect(markup).toContain("Tools: web, memory.");
		expect(markup).toContain("No tools.");
		expect(markup).toContain("without asking (trust level open)");
		expect(markup).toContain('data-delete="research"');
		expect(markup).toContain('data-delete="notes"');
	});

	it("says when there are none, while loading, and an error instead of an empty list", () => {
		expect(renderList(bots({ bots: [] }))).toContain("There are no bots yet.");
		expect(renderList(undefined)).toContain("Loading…");
		const failed = renderList(undefined, "Cannot reach the assistant server.");
		expect(failed).toContain("Cannot reach the assistant server.");
		expect(failed).not.toContain("Loading…");
	});
});

describe("the new-bot form", () => {
	it("suggests an id from the name", () => {
		expect(slugFromName("Research Bot!")).toBe("research-bot");
		expect(slugFromName("42 Café notes")).toBe("cafe-notes");
		expect(slugFromName("x".repeat(50))).toHaveLength(32);
	});

	it("says what is missing before it can be sent, and refuses at the cap", () => {
		const data = bots({ bots: [] });
		expect(draftProblem(EMPTY_DRAFT, data)).toBe("Give the bot a name.");
		const draft = { ...EMPTY_DRAFT, name: "Research", slug: "research", soul: "You look things up." };
		expect(draftProblem(draft, data)).toBeUndefined();
		expect(draftProblem({ ...draft, slug: "1abc" }, data)).toContain("lowercase letters");
		expect(draftProblem({ ...draft, soul: " " }, data)).toContain("what it does");
		expect(draftProblem({ ...draft, soul: "x".repeat(6001) }, data)).toContain("at most 6000");
		expect(draftProblem(draft, bots({ bots: Array.from({ length: 8 }, () => bot()) }))).toContain("already 8 bots");
	});

	it("sends trimmed fields, leaves out an empty avatar, and toggles tools without duplicates", () => {
		expect(requestOf({ name: " R ", slug: "r1", avatar: " ", soul: " s ", tools: ["web"] })).toStrictEqual({
			name: "R",
			slug: "r1",
			soul: "s",
			tools: ["web"],
		});
		expect(requestOf({ ...EMPTY_DRAFT, avatar: "🔎" }).avatar).toBe("🔎");
		expect(toggleTool(["web"], "web", true)).toStrictEqual(["web"]);
		expect(toggleTool(["web", "memory"], "web", false)).toStrictEqual(["memory"]);
	});
});

const trust = (over: Partial<TrustSettingsResponse> = {}): TrustSettingsResponse => ({
	pa: { level: "normal", defaultLevel: "normal", overridden: false },
	broker: "off",
	projects: [],
	...over,
});
const renderTrust = (data: TrustSettingsResponse | undefined, error?: string) =>
	renderToStaticMarkup(createElement(TrustSettingsView, { data, error, busy: false, onChange: () => {} }));

describe("Settings → Trust levels", () => {
	it("shows the PA's level with where it comes from, and that the broker is off", () => {
		const markup = renderTrust(trust());
		expect(markup).toContain("Assistant: creating and deleting bots");
		expect(markup).toContain('<option value="default" selected="">Default (normal)</option>');
		expect(markup).toContain("From ZIMPOEN_PA_TRUST (normal).");
		expect(markup).toContain("credential broker is off");
		expect(markup).toContain("the assistant cannot");
	});

	it("shows an owner's override and one select per project", () => {
		const markup = renderTrust(
			trust({
				pa: { level: "open", defaultLevel: "normal", overridden: true },
				broker: "on",
				projects: [{ id: "zimpoen", level: "strict", defaultLevel: "normal", overridden: true }],
			}),
		);
		expect(markup).toContain('<option value="open" selected="">open</option>');
		expect(markup).toContain("Open: never asks.");
		expect(markup).toContain("Set here; ZIMPOEN_PA_TRUST says normal.");
		expect(markup).toContain("Project zimpoen");
		expect(markup).toContain("Set here; the broker policy says normal.");
		expect(markup).not.toContain("broker is off");
	});

	it("shows loading and errors", () => {
		expect(renderTrust(undefined)).toContain("Loading…");
		expect(renderTrust(undefined, "Nope.")).toContain("Nope.");
	});
});
