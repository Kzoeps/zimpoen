import type { GoogleAccountSummary, GoogleSettingsResponse } from "@assistant/shared";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ACCOUNT_STATUS_LABEL, GoogleAccountsView, skippedText, syncLine } from "../src/components/google-accounts.tsx";

const account = (over: Partial<GoogleAccountSummary> = {}): GoogleAccountSummary => ({
	email: "work@x.example",
	status: "connected",
	messages: 120,
	lastSyncText: "Mon 26 Oct 2026, 14:03",
	...over,
});
const settings = (over: Partial<GoogleSettingsResponse> = {}): GoogleSettingsResponse => ({
	mode: "real",
	clientConfigured: true,
	triage: { mode: "rules" },
	syncMinutes: 10,
	accounts: [account()],
	...over,
});

const disconnect = (email: string): ReactNode =>
	createElement("button", { type: "button", "data-disconnect": email }, "Disconnect");
const render = (data: GoogleSettingsResponse | undefined, error?: string): string =>
	renderToStaticMarkup(
		createElement(GoogleAccountsView, {
			data,
			error,
			disconnect,
			refresh: createElement("button", { type: "button" }, "Check again"),
		}),
	);

describe("Settings → Google accounts", () => {
	it("lists each account with its address, state, last sync and how much mail is kept, and says the access is read-only", () => {
		const markup = render(
			settings({ accounts: [account(), account({ email: "me@y.example", messages: 1, lastSyncText: undefined })] }),
		);

		expect(markup).toContain("work@x.example");
		expect(markup).toContain(">Connected</span>");
		expect(markup).toContain("Last synced Mon 26 Oct 2026, 14:03 · 120 mails kept");
		expect(markup).toContain("Not synced yet · 1 mail kept");
		expect(markup).toContain("can only read: it cannot send, reply, label or delete");
		expect(markup).toContain("Each account is read every 10 minutes.");
	});

	it("says in plain words when Google refuses an account, with the command that fixes it", () => {
		const markup = render(
			settings({ accounts: [account({ status: "needs_reconnect", lastError: "Google refused the sign-in." })] }),
		);

		expect(markup).toContain(ACCOUNT_STATUS_LABEL.needs_reconnect);
		expect(markup).toContain("Google no longer accepts this sign-in, so no mail is being read.");
		expect(markup).toContain("<code>pnpm connect:google</code>");
		expect(markup).toContain("badge--google-needs_reconnect");
	});

	it("shows why the last sync of a working account failed, and that it is tried again", () => {
		const markup = render(settings({ accounts: [account({ lastError: "Google answered 503." })] }));

		expect(markup).toContain("The last sync failed: Google answered 503. It is tried again by itself.");
	});

	it("says which mail was left out because Gmail would not hand it over, and where to look for it", () => {
		const many = render(
			settings({ accounts: [account({ skipped: { count: 2, lastError: "Google answered 400: Invalid id value" } })] }),
		);
		expect(many).toContain(
			"2 mails could not be read after several tries, so they are not in search or digests. Look for them in Gmail. Last reason: Google answered 400: Invalid id value",
		);
		expect(skippedText({ count: 1, lastError: "x" })).toBe(
			"1 mail could not be read after several tries, so it is not in search or digests. Look for it in Gmail. Last reason: x",
		);
		expect(render(settings())).not.toContain("could not be read after several tries");
	});

	it("offers Disconnect for an account that is connected or needs reconnecting, and not for one already disconnected", () => {
		const markup = render(
			settings({
				accounts: [
					account({ email: "a@x.example" }),
					account({ email: "b@x.example", status: "needs_reconnect" }),
					account({ email: "c@x.example", status: "disconnected" }),
				],
			}),
		);

		expect(markup).toContain('data-disconnect="a@x.example"');
		expect(markup).toContain('data-disconnect="b@x.example"');
		expect(markup).not.toContain('data-disconnect="c@x.example"');
		expect(markup).toContain("No new mail is read. What was read stays.");
	});

	it("shows the Rules mode badge without a Jev key, and the Jev badge with one, and what Jev is sent", () => {
		const rules = render(settings());
		expect(rules).toContain('<span class="badge badge--triage badge--triage-rules">Rules mode</span>');
		expect(rules).toContain("sorted on this machine by sender, Gmail&#x27;s own labels and keywords");
		expect(rules).toContain("docs/setup-jev.md");

		const jev = render(settings({ triage: { mode: "jev" } }));
		expect(jev).toContain('<span class="badge badge--triage badge--triage-jev">Jev</span>');
		expect(jev).toContain("the first 1,500 characters of its text, and nothing else");
		expect(jev).not.toContain("Rules mode");
	});

	it("says when Jev is paused after failing several times in a row, until when, and that the rules sort meanwhile", () => {
		const markup = render(
			settings({
				triage: {
					mode: "jev",
					pausedUntil: 1,
					pausedUntilText: "Mon 26 Oct 2026, 14:35",
					lastError: "Jev is paused after 3 failures in a row.",
					lastErrorText: "Mon 26 Oct 2026, 14:20",
				},
			}),
		);

		expect(markup).toContain('<span class="badge badge--triage badge--triage-paused">Rules mode (Jev paused)</span>');
		expect(markup).toContain("it is not asked until Mon 26 Oct 2026, 14:35");
		expect(markup).toContain("mail is sorted on this machine by sender");
		// A Jev that is not paused keeps its own badge, whatever the text of an old error.
		expect(render(settings({ triage: { mode: "jev" } }))).not.toContain("Jev paused");
		// Rules mode has nothing to pause.
		expect(render(settings({ triage: { mode: "rules" } }))).not.toContain("Jev paused");
	});

	it("says why Jev fell back to the rules, and when", () => {
		const markup = render(
			settings({
				triage: { mode: "jev", lastError: "Jev did not accept the key.", lastErrorText: "Mon 26 Oct 2026, 13:00" },
			}),
		);

		expect(markup).toContain("Jev could not be used (Mon 26 Oct 2026, 13:00): Jev did not accept the key.");
		expect(markup).toContain("Until it works, mail is sorted by the local rules.");
	});

	it("tells the owner what to do when no account is connected, and when the client file is missing in real mode", () => {
		const none = render(settings({ accounts: [], clientConfigured: false }));

		expect(none).toContain("No account is connected yet.");
		expect(none).toContain("<code>pnpm connect:google</code>");
		expect(none).toContain("The Google client file is missing");
		expect(none).toContain("secrets/google-oauth.json");
		expect(render(settings({ accounts: [] }))).not.toContain("client file is missing");
	});

	it("says that the fake mode is a demo mailbox and not Google, and does not complain about a missing client file there", () => {
		const markup = render(settings({ mode: "fake", clientConfigured: false }));

		expect(markup).toContain("a scripted demo mailbox. Nothing is read from");
		expect(markup).not.toContain("client file is missing");
	});

	it("shows a loading note, and an error from the server, instead of an empty card", () => {
		expect(render(undefined)).toContain("Loading…");
		const failed = render(undefined, "Cannot reach the assistant server.");
		expect(failed).toContain("Cannot reach the assistant server.");
		expect(failed).not.toContain("Loading…");
	});

	it("counts mail in the right number", () => {
		expect(syncLine({ messages: 0 })).toBe("Not synced yet · 0 mails kept");
		expect(syncLine({ messages: 1, lastSyncText: "Mon" })).toBe("Last synced Mon · 1 mail kept");
	});
});
