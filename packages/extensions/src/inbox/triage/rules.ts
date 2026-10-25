import type { TriageCategory, TriageResult } from "@assistant/shared";
import { domainOf } from "../text.ts";
import type { Triage, TriageInput } from "../types.ts";

/**
 * The local classifier (`RulesTriage`): sender and domain lists, what Gmail itself says (its categories and labels), a
 * few words in the subject, and what the owner taught by marking mail (`learned`, from `inbox_rule`). It is what runs when
 * no Jev key is saved, and what stands in when Jev cannot be reached. Deterministic, no network, and it reads only the
 * first few hundred characters of a mail, so a hostile body cannot make it slow.
 */

/** What the rules look at of the text, so that a huge body cannot make a scan long. */
const SCAN_CHARS = 600;

/** Senders that are machines: the part before the @. */
const MACHINE_SENDERS: readonly string[] = [
	"no-reply",
	"noreply",
	"no_reply",
	"donotreply",
	"do-not-reply",
	"do_not_reply",
	"notification",
	"notifications",
	"notify",
	"alert",
	"alerts",
	"mailer-daemon",
	"postmaster",
	"bounce",
	"bounces",
	"automated",
	"system",
];

/** Domains that send money mail: banks (Bhutan's among them), card and payment services. */
const FINANCE_DOMAINS: readonly string[] = [
	"bob.bt",
	"bnb.bt",
	"tbank.bt",
	"dpnb.bt",
	"bdb.bt",
	"paypal.com",
	"stripe.com",
	"wise.com",
	"payoneer.com",
	"visa.com",
	"mastercard.com",
	"americanexpress.com",
	"westernunion.com",
];

const FINANCE_WORDS: readonly string[] = [
	"invoice",
	"receipt",
	"payment",
	"statement",
	"your bill",
	"transaction",
	"refund",
	"subscription renewal",
	"billing",
];

/** Words that make finance mail time-sensitive. */
const FINANCE_URGENT: readonly string[] = [
	"overdue",
	"past due",
	"final notice",
	"payment failed",
	"payment declined",
	"card declined",
	"unpaid",
	"disconnection",
];

const SECURITY_WORDS: readonly string[] = [
	"security alert",
	"new sign-in",
	"new login",
	"suspicious",
	"verify your",
	"password reset",
	"unusual activity",
	"account locked",
];

const PROMO_WORDS: readonly string[] = [
	"% off",
	"sale",
	"discount",
	"deal",
	"coupon",
	"limited time",
	"special offer",
	"free shipping",
	"black friday",
	"save up to",
];

/** A person asking for something: the subject or the first lines. */
const REPLY_WORDS: readonly string[] = [
	"can you",
	"could you",
	"would you",
	"please reply",
	"please confirm",
	"please let me know",
	"let me know",
	"rsvp",
	"your thoughts",
	"your response",
	"need your",
	"waiting for your",
	"action required",
	"urgent",
	"asap",
	"deadline",
	"by tomorrow",
	"by monday",
	"by tuesday",
	"by wednesday",
	"by thursday",
	"by friday",
	"by end of day",
	"?",
];

const FOLLOW_UP_WORDS: readonly string[] = [
	"following up",
	"follow up",
	"follow-up",
	"checking in",
	"any update",
	"just a reminder",
	"gentle reminder",
	"reminder:",
	"circling back",
	"touching base",
];

/** How much attention a category deserves unless something says more. */
export const DEFAULT_URGENCY: Record<TriageCategory, { urgency: number; needsHuman: boolean }> = {
	important: { urgency: 4, needsHuman: true },
	needs_reply: { urgency: 3, needsHuman: true },
	follow_up: { urgency: 3, needsHuman: true },
	finance: { urgency: 2, needsHuman: false },
	personal: { urgency: 2, needsHuman: true },
	newsletter: { urgency: 1, needsHuman: false },
	notification: { urgency: 1, needsHuman: false },
	promo: { urgency: 1, needsHuman: false },
	other: { urgency: 1, needsHuman: false },
};

const anyOf = (text: string, words: readonly string[]): string | undefined => words.find((word) => text.includes(word));

const result = (category: TriageCategory, reason: string, overrides: Partial<TriageResult> = {}): TriageResult => ({
	category,
	...DEFAULT_URGENCY[category],
	source: "rules",
	reason,
	...overrides,
});

/** The sender's category from what the owner taught: the exact address first, then the domain. */
export function learnedCategory(
	input: Pick<TriageInput, "fromAddress">,
	learned: readonly { kind: "sender" | "domain"; value: string; category: TriageCategory }[],
): TriageResult | undefined {
	const address = input.fromAddress.toLowerCase();
	if (address === "") return undefined;
	const sender = learned.find((rule) => rule.kind === "sender" && rule.value === address);
	const domain = domainOf(address);
	const rule = sender ?? (domain === "" ? undefined : learned.find((r) => r.kind === "domain" && r.value === domain));
	if (rule === undefined) return undefined;
	return {
		category: rule.category,
		...DEFAULT_URGENCY[rule.category],
		source: "owner",
		reason: rule.kind === "sender" ? "you marked mail from this sender" : "you marked mail from this domain",
	};
}

/** Classify by the built-in rules. Synchronous: {@link createRulesTriage} wraps it. */
export function classifyByRules(input: TriageInput): TriageResult {
	const address = input.fromAddress.toLowerCase();
	const local = address.split("@")[0] ?? "";
	const domain = domainOf(address);
	const subject = input.subject.toLowerCase().slice(0, 200);
	const body = `${input.snippet} ${input.text}`.toLowerCase().slice(0, SCAN_CHARS);
	const labels = new Set(input.labels);
	const machine = MACHINE_SENDERS.some(
		(name) => local === name || local.startsWith(`${name}+`) || local.startsWith(`${name}-`),
	);

	const security = anyOf(subject, SECURITY_WORDS);
	if (security !== undefined) return result("important", `security mail ("${security}")`, { urgency: 3 });

	const financeSender = FINANCE_DOMAINS.some((known) => domain === known || domain.endsWith(`.${known}`));
	const financeWord = anyOf(subject, FINANCE_WORDS);
	if (financeSender || financeWord !== undefined) {
		const urgent = anyOf(`${subject} ${body}`, FINANCE_URGENT);
		return urgent === undefined
			? result(
					"finance",
					financeSender ? `from a bank or payment service (${domain})` : `"${financeWord}" in the subject`,
				)
			: result("important", `money mail that says "${urgent}"`, { urgency: 4 });
	}

	if (labels.has("CATEGORY_PROMOTIONS")) return result("promo", "Gmail put it in Promotions");
	if (labels.has("CATEGORY_FORUMS")) return result("newsletter", "Gmail put it in Forums");
	if (labels.has("CATEGORY_SOCIAL")) return result("notification", "Gmail put it in Social");
	if (labels.has("CATEGORY_UPDATES") || machine) {
		return result("notification", machine ? "sent by an automatic address" : "Gmail put it in Updates");
	}

	if (input.bulk) {
		const promo = anyOf(`${subject} ${body}`, PROMO_WORDS);
		return promo === undefined
			? result("newsletter", "a mailing list (it can be unsubscribed from)")
			: result("promo", `a mailing list that says "${promo}"`);
	}

	// What is left was written by a person, to this owner.
	const followUp = anyOf(`${subject} ${body}`, FOLLOW_UP_WORDS);
	if (followUp !== undefined) return result("follow_up", `says "${followUp}"`);
	const asks =
		anyOf(subject, REPLY_WORDS) ??
		anyOf(
			body,
			REPLY_WORDS.filter((word) => word !== "?"),
		);
	if (asks !== undefined) {
		const urgent = asks === "urgent" || asks === "asap" || asks === "deadline" || asks === "action required";
		return result("needs_reply", `asks something ("${asks}")`, urgent ? { urgency: 4 } : {});
	}
	if (labels.has("STARRED")) return result("important", "you starred it", { urgency: 4 });
	if (labels.has("IMPORTANT")) return result("important", "Gmail marked it important", { urgency: 3 });
	if (/^(re|fwd?):/i.test(input.subject)) return result("needs_reply", "a reply in a conversation", { urgency: 2 });
	return result(input.fromName === "" && address === "" ? "other" : "personal", "written by a person");
}

/** The rules as a {@link Triage}. */
export function createRulesTriage(): Triage {
	return {
		mode: "rules",
		classify: async (input) => classifyByRules(input),
	};
}
