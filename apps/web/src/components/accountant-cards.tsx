import {
	type AccountantNoteCard,
	type BalancesCard,
	type DebtItem,
	formatMoney,
	formatSize,
	formatTenths,
	type ImportColumnRole,
	type ImportPreviewCard,
	type ImportResultCard,
	type InvoiceCard,
	type InvoiceItem,
	type InvoiceListCard,
	type SpendingCard,
	type SplitCard,
	type TxnCard,
	type TxnItem,
	type TxnListCard,
	type WhoOwesCard,
} from "@assistant/shared";
import type { ReactNode } from "react";
import { fileUrl } from "../lib/api.ts";
import { FileChip } from "./file-chip.tsx";

/**
 * The Accountant's cards: expenses, balances, spending bars, a CSV import to confirm, split bills, who owes whom and
 * invoices. Plain functions of their card, like the Health cards, so a card renders the same on the server, in the browser
 * and in a test (`renderToStaticMarkup`). Every amount is an integer of minor units that the tools computed; this file only
 * writes it with `formatMoney`. The one thing that needs the chat (confirming an import) comes in as `action`.
 */

const money = (minor: number, currency: string): string => formatMoney(minor, currency);

/** `Pema owes you Nu. 500.00`, `You owe Pema Nu. 500.00`: the same words the tools use. */
export function oweSentence(debt: DebtItem): string {
	const amount = money(debt.amountMinor, debt.currency);
	if (debt.debtor === "You") return `You owe ${debt.creditor} ${amount}`;
	if (debt.creditor === "You") return `${debt.debtor} owes you ${amount}`;
	return `${debt.debtor} owes ${debt.creditor} ${amount}`;
}

function Amount({ minor, currency, signed = false }: { minor: number; currency: string; signed?: boolean }) {
	const className = signed ? (minor < 0 ? "money money--out" : minor > 0 ? "money money--in" : "money") : "money";
	return (
		<span className={className}>
			{signed ? formatMoney(minor, currency, { sign: "always" }) : money(minor, currency)}
		</span>
	);
}

// ----- entries ------------------------------------------------------------------------------------------------------------------

const KIND_LABEL = { expense: "Expense recorded", income: "Income recorded", transfer: "Transfer recorded" } as const;
const KIND_ICON = { expense: "💸", income: "💰", transfer: "🔁" } as const;

function TxnRow({ txn }: { txn: TxnItem }) {
	return (
		<li className="txn">
			<div className="txn__main">
				<span className="txn__what">
					{txn.merchant !== undefined && txn.merchant !== ""
						? txn.merchant
						: txn.note !== undefined
							? txn.note
							: txn.kind}
				</span>
				<Amount minor={txn.amountMinor} currency={txn.currency} signed />
			</div>
			<p className="card__muted txn__meta">
				{txn.dateText} · {txn.account}
				{txn.category !== undefined ? <span className="badge">{txn.category}</span> : null}
			</p>
			{txn.receipt !== undefined ? <FileChip file={txn.receipt} /> : null}
		</li>
	);
}

export function TxnView({ card }: { card: TxnCard }) {
	const first = card.txns[0];
	const kind = first?.kind ?? "expense";
	return (
		<section className="card card--money" aria-label={KIND_LABEL[kind]}>
			<header className="card__head">
				<span aria-hidden="true">{KIND_ICON[kind]}</span> {KIND_LABEL[kind]}
			</header>
			<ul className="txns">
				{card.txns.map((txn) => (
					<TxnRow key={txn.id} txn={txn} />
				))}
			</ul>
			<p className="card__muted">{card.txns.map((txn) => txn.id).join(" · ")}</p>
			{card.similarTo !== undefined ? (
				<p className="card__note" role="status">
					An entry like this one was already there ({card.similarTo}).
				</p>
			) : null}
		</section>
	);
}

export function TxnListView({ card }: { card: TxnListCard }) {
	return (
		<section className="card card--money" aria-label={card.heading}>
			<header className="card__head">
				<span aria-hidden="true">🧾</span> {card.heading} <span className="card__muted">({card.total})</span>
			</header>
			{card.txns.length === 0 ? (
				<p className="card__muted">No entries.</p>
			) : (
				<ul className="txns">
					{card.txns.map((txn) => (
						<TxnRow key={txn.id} txn={txn} />
					))}
				</ul>
			)}
			{card.total > card.txns.length ? <p className="card__muted">…and {card.total - card.txns.length} more</p> : null}
			{card.sums.map((sum) => (
				<p key={sum.currency} className="card__muted txn__sum">
					All {card.total}: out {money(sum.outMinor, sum.currency)} · in {money(sum.inMinor, sum.currency)}
				</p>
			))}
		</section>
	);
}

// ----- balances and spending -------------------------------------------------------------------------------------------------

const ACCOUNT_ICON = { cash: "💵", bank: "🏦", wallet: "📱", card: "💳" } as const;

export function BalancesView({ card }: { card: BalancesCard }) {
	return (
		<section className="card card--money" aria-label="Balances">
			<header className="card__head">
				<span aria-hidden="true">🏦</span> Balances
			</header>
			{card.accounts.length === 0 ? (
				<p className="card__muted">No accounts yet.</p>
			) : (
				<ul className="accounts">
					{card.accounts.map((account) => (
						<li key={account.account} className="account">
							<div className="txn__main">
								<span className="txn__what">
									<span aria-hidden="true">{ACCOUNT_ICON[account.kind]}</span> {account.account}
								</span>
								<Amount minor={account.amountMinor} currency={account.currency} />
							</div>
							<p className="card__muted">
								{account.basis === "snapshot"
									? `as of ${account.asOfText ?? "the last balance you stated"}${account.entriesSince > 0 ? `, and ${account.entriesSince} ${account.entriesSince === 1 ? "entry" : "entries"} since` : ""}`
									: "from entries only: no balance stated yet"}
							</p>
						</li>
					))}
				</ul>
			)}
			{card.totals.length > 1 || card.converted !== undefined ? (
				<div className="totals">
					{card.totals.map((total) => (
						<p key={total.currency} className="txn__main">
							<span>Total {total.currency}</span>
							<Amount minor={total.amountMinor} currency={total.currency} />
						</p>
					))}
					{card.converted !== undefined ? (
						<p className="txn__main">
							<span>All in {card.converted.currency}</span>
							<Amount minor={card.converted.amountMinor} currency={card.converted.currency} />
						</p>
					) : null}
					{card.converted !== undefined && card.converted.missing.length > 0 ? (
						<p className="card__muted">No rate given for {card.converted.missing.join(", ")}: left out.</p>
					) : null}
				</div>
			) : null}
		</section>
	);
}

export function SpendingView({ card }: { card: SpendingCard }) {
	return (
		<section className="card card--money card--chart" aria-label={card.heading}>
			<header className="card__head">
				<span aria-hidden="true">📊</span> {card.heading} <span className="card__muted">· {card.rangeText}</span>
			</header>
			<p className="card__big">{money(card.totalMinor, card.currency)}</p>
			<p className="card__muted">
				{card.count} {card.count === 1 ? "entry" : "entries"}
				{card.incomeMinor > 0 ? ` · ${money(card.incomeMinor, card.currency)} came in over the same days` : ""}
			</p>
			{card.groups.length === 0 ? (
				<p className="card__muted">Nothing spent.</p>
			) : (
				<ul className="bars">
					{card.groups.map((group) => (
						<li key={group.label} className="bar">
							<div className="bar__row">
								<span className="bar__label">{group.label}</span>
								<span className="bar__value">
									<Amount minor={group.amountMinor} currency={card.currency} />
									<span className="card__muted"> · {formatTenths(group.tenths)}</span>
								</span>
							</div>
							<div className="bar__track" role="img" aria-label={`${group.label}: ${formatTenths(group.tenths)}`}>
								<div className="bar__fill" style={{ width: `${group.tenths / 10}%` }} />
							</div>
						</li>
					))}
				</ul>
			)}
			{card.others.map((other) => (
				<p key={other.currency} className="card__muted">
					Also {money(other.totalMinor, other.currency)} in {other.count} {other.count === 1 ? "entry" : "entries"} (not
					converted).
				</p>
			))}
		</section>
	);
}

// ----- importing a statement ----------------------------------------------------------------------------------------------------

const ROLE_LABEL: Record<ImportColumnRole, string> = {
	date: "date",
	description: "description",
	amount: "amount",
	debit: "money out",
	credit: "money in",
	direction: "in or out",
	balance: "balance",
	category: "category",
	currency: "currency",
	ignored: "ignored",
};

const DATE_ORDER_LABEL = { DMY: "day first", MDY: "month first", YMD: "year first" } as const;

/**
 * What a CSV holds and what importing it would do. Nothing is written until the owner confirms: `action` is the confirm
 * button (it sends a message in the chat), left out once the import has been confirmed (`answered`).
 */
export function ImportPreviewView({
	card,
	answered = false,
	action,
}: {
	card: ImportPreviewCard;
	answered?: boolean;
	action?: ReactNode;
}) {
	return (
		<section className="card card--money" aria-label="Import preview">
			<header className="card__head">
				<span aria-hidden="true">📥</span> Import preview <span className="card__muted">· {card.fileName}</span>
			</header>
			<p className="card__title">
				{card.rows} {card.rows === 1 ? "entry" : "entries"} into {card.account}
			</p>
			{(card.warnings ?? []).length > 0 ? (
				<ul className="points card__warning" aria-label="Warnings">
					{(card.warnings ?? []).map((warning, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: warnings are a short fixed list and two can read alike
						<li key={index}>{warning}</li>
					))}
				</ul>
			) : null}
			<p className="card__muted">
				{card.firstDate !== undefined ? `${card.firstDate} to ${card.lastDate ?? card.firstDate} · ` : ""}
				{card.encoding} · separator {card.delimiter === "\t" ? "tab" : `“${card.delimiter}”`} · dates{" "}
				{DATE_ORDER_LABEL[card.dateOrder]}
			</p>
			<p className="chips">
				{card.columns.map((column, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: the columns of one file are fixed, and two can share a header
					<span key={index} className={column.role === "ignored" ? "badge" : "badge badge--role"}>
						{column.header === "" ? "(blank)" : column.header} → {ROLE_LABEL[column.role]}
					</span>
				))}
			</p>
			<dl className="stats">
				<div className="stat">
					<dt className="stat__label">Money out</dt>
					<dd className="stat__value">
						{money(card.outMinor, card.currency)}
						<span className="stat__note">
							{card.outCount} {card.outCount === 1 ? "entry" : "entries"}
						</span>
					</dd>
				</div>
				<div className="stat">
					<dt className="stat__label">Money in</dt>
					<dd className="stat__value">
						{money(card.inMinor, card.currency)}
						<span className="stat__note">
							{card.inCount} {card.inCount === 1 ? "entry" : "entries"}
						</span>
					</dd>
				</div>
				{card.duplicates > 0 ? (
					<div className="stat">
						<dt className="stat__label">Already there</dt>
						<dd className="stat__value">{card.duplicates}</dd>
					</div>
				) : null}
				{(card.matchCount ?? 0) > 0 ? (
					<div className="stat">
						<dt className="stat__label">Look like entries you have</dt>
						<dd className="stat__value">{card.matchCount}</dd>
					</div>
				) : null}
				{card.skipped > 0 ? (
					<div className="stat">
						<dt className="stat__label">Unreadable rows</dt>
						<dd className="stat__value">{card.skipped}</dd>
					</div>
				) : null}
				{card.uncategorized > 0 ? (
					<div className="stat">
						<dt className="stat__label">Uncategorized</dt>
						<dd className="stat__value">{card.uncategorized}</dd>
					</div>
				) : null}
			</dl>
			{card.sample.length > 0 ? (
				<ul className="txns txns--sample" aria-label="First rows">
					{card.sample.map((row, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: sample rows have no id and the list is fixed
						<li key={index} className={row.duplicate ? "txn txn--duplicate" : "txn"}>
							<div className="txn__main">
								<span className="txn__what">{row.description}</span>
								<Amount minor={row.amountMinor} currency={card.currency} signed />
							</div>
							<p className="card__muted txn__meta">
								{row.dateText}
								{row.category !== undefined ? <span className="badge">{row.category}</span> : null}
								{row.duplicate ? <span className="badge">already there</span> : null}
								{row.match === true ? <span className="badge">looks like an entry you have</span> : null}
							</p>
						</li>
					))}
				</ul>
			) : null}
			{(card.matches ?? []).length > 0 ? (
				<section className="card__note" aria-label="Rows that look like entries already in the ledger">
					<p>
						<strong>
							{card.matchCount} {card.matchCount === 1 ? "row looks" : "rows look"} like{" "}
							{card.matchCount === 1 ? "an entry" : "entries"} you already have
						</strong>
						, so {card.matchCount === 1 ? "it is" : "they are"} left out. Tell me if one is a different purchase.
					</p>
					<ul className="txns">
						{(card.matches ?? []).map((match) => (
							<li key={match.line} className="txn txn--match">
								<div className="txn__main">
									<span className="txn__what">{match.description}</span>
									<Amount minor={match.amountMinor} currency={card.currency} signed />
								</div>
								<p className="card__muted txn__meta">
									line {match.line} · {match.dateText} · like{" "}
									{match.entry.merchant === "" ? "an entry" : match.entry.merchant} on {match.entry.dateText} (
									{match.entry.source === "receipt" ? "receipt" : "typed"}) · {match.entry.id}
								</p>
							</li>
						))}
					</ul>
					{(card.matchCount ?? 0) > (card.matches ?? []).length ? (
						<p className="card__muted">…and {(card.matchCount ?? 0) - (card.matches ?? []).length} more</p>
					) : null}
				</section>
			) : null}
			{card.problems.length > 0 ? (
				<ul className="points card__note" aria-label="Problems">
					{card.problems.map((problem, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: two rows of a file can fail for the same words
						<li key={index}>{problem}</li>
					))}
				</ul>
			) : null}
			{answered ? <p className="card__muted">Confirmed: see the result below.</p> : action}
		</section>
	);
}

export function ImportResultView({ card }: { card: ImportResultCard }) {
	return (
		<section className="card card--money" aria-label="Import result">
			<header className="card__head">
				<span aria-hidden="true">✅</span> {card.already ? "Already imported" : "Imported"}
			</header>
			<p className="card__title">
				{card.already ? "Nothing changed: " : ""}
				{card.inserted} {card.inserted === 1 ? "entry" : "entries"} in {card.account}
			</p>
			<p className="card__muted">
				Out {money(card.outMinor, card.currency)} · in {money(card.inMinor, card.currency)}
				{card.duplicates > 0 ? ` · ${card.duplicates} already there, not added again` : ""}
				{(card.skippedMatches ?? 0) > 0
					? ` · ${card.skippedMatches} left out: they look like entries you already have`
					: ""}
			</p>
		</section>
	);
}

// ----- splits ---------------------------------------------------------------------------------------------------------------------

export function SplitView({ card }: { card: SplitCard }) {
	return (
		<section className="card card--money" aria-label="Split bill">
			<header className="card__head">
				<span aria-hidden="true">🍽️</span> Bill split <span className="card__muted">· {card.dateText}</span>
			</header>
			<p className="card__title">{card.title}</p>
			<p className="card__muted">
				{money(card.totalMinor, card.currency)} paid by {card.payer}
				{card.equal ? " · shared equally" : ""}
			</p>
			<div className="table-wrap">
				<table className="split">
					<thead>
						<tr>
							<th scope="col">Person</th>
							{card.equal ? null : (
								<th scope="col" className="split__col">
									Items
								</th>
							)}
							{card.extras.length > 0 ? (
								<th scope="col" className="split__col">
									Extras
								</th>
							) : null}
							<th scope="col">Owes</th>
						</tr>
					</thead>
					<tbody>
						{card.shares.map((share) => (
							<tr key={share.person} className={share.paid ? "split__paid" : undefined}>
								<th scope="row">
									{share.person}
									{share.paid ? <span className="badge">paid</span> : null}
									{card.equal ? null : (
										// On a phone the Items and Extras columns are folded into this line.
										<span className="split__parts">
											items {money(share.itemsMinor, card.currency)}
											{card.extras.length > 0 ? ` + extras ${money(share.extrasMinor, card.currency)}` : ""}
										</span>
									)}
								</th>
								{card.equal ? null : <td className="split__col">{money(share.itemsMinor, card.currency)}</td>}
								{card.extras.length > 0 ? (
									<td className="split__col">{money(share.extrasMinor, card.currency)}</td>
								) : null}
								<td className="split__owed">{money(share.owedMinor, card.currency)}</td>
							</tr>
						))}
					</tbody>
					<tfoot>
						<tr>
							<th scope="row">Total</th>
							{card.equal ? null : <td className="split__col" />}
							{card.extras.length > 0 ? <td className="split__col" /> : null}
							<td className="split__owed">{money(card.totalMinor, card.currency)}</td>
						</tr>
					</tfoot>
				</table>
			</div>
			{card.items.length > 0 || card.extras.length > 0 ? (
				<details className="card__facts">
					<summary>The bill</summary>
					<ul className="facts">
						{card.items.map((item, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: two lines of a bill can read the same
							<li key={index}>
								{item.description}: {money(item.amountMinor, card.currency)}{" "}
								<span className="card__muted">({item.sharedBy.join(", ")})</span>
							</li>
						))}
						{card.extras.map((extra, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: two extras of a bill can carry the same label
							<li key={index}>
								{extra.label}: {money(extra.amountMinor, card.currency)}
							</li>
						))}
					</ul>
				</details>
			) : null}
			<p className="card__muted">{card.billId}</p>
		</section>
	);
}

export function WhoOwesView({ card }: { card: WhoOwesCard }) {
	return (
		<section className="card card--money" aria-label={card.heading}>
			<header className="card__head">
				<span aria-hidden="true">🤝</span> {card.heading}
			</header>
			{card.debts.length === 0 ? (
				<p className="card__title">Nothing is owed.</p>
			) : (
				<ul className="debts">
					{card.debts.map((debt) => (
						<li key={`${debt.debtor}>${debt.creditor}:${debt.currency}`} className="debt">
							{oweSentence(debt)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

// ----- invoices ---------------------------------------------------------------------------------------------------------------------

/** The download: the PDF as the files API serves it, as a link the browser saves. */
function InvoiceDownload({ invoice, label = "Download PDF" }: { invoice: InvoiceItem; label?: string }) {
	if (invoice.file === undefined) return <p className="card__muted">The PDF is no longer on the server.</p>;
	return (
		<a
			className="card__button card__button--primary invoice__download"
			href={fileUrl(invoice.file.id)}
			download={invoice.file.name}
		>
			{label} <span className="invoice__size">{formatSize(invoice.file.size)}</span>
		</a>
	);
}

const INVOICE_HEAD = {
	created: "Invoice ready",
	existing: "Invoice (made earlier)",
	preview: "Invoice preview",
} as const;

export function InvoiceView({ card }: { card: InvoiceCard }) {
	const { invoice } = card;
	const preview = card.event === "preview";
	return (
		<section
			className={preview ? "card card--money card--preview" : "card card--money"}
			aria-label={preview ? `Preview of invoice ${invoice.number}` : `Invoice ${invoice.number}`}
		>
			<header className="card__head">
				<span aria-hidden="true">🧾</span> {INVOICE_HEAD[card.event]}
				{preview ? <span className="badge badge--preview">PREVIEW</span> : null}
			</header>
			<p className="card__title">
				{invoice.number} · {invoice.periodText}
			</p>
			<p className="card__big">{money(invoice.amountMinor, invoice.currency)}</p>
			<p className="card__muted">
				To {invoice.clientName} · issued {invoice.issueText} · due {invoice.dueText}
			</p>
			<div className="card__actions">
				<InvoiceDownload invoice={invoice} label={preview ? "Download preview PDF" : "Download PDF"} />
			</div>
			<p className="card__muted">
				{preview
					? `Not an invoice: no number was taken, and ${invoice.number} is only what the next real one would be called.`
					: "Not sent anywhere: download it and send it yourself."}
			</p>
		</section>
	);
}

export function InvoiceListView({ card }: { card: InvoiceListCard }) {
	return (
		<section className="card card--money" aria-label={card.heading}>
			<header className="card__head">
				<span aria-hidden="true">🧾</span> {card.heading} <span className="card__muted">({card.total})</span>
			</header>
			<ul className="txns">
				{card.invoices.map((invoice) => (
					<li key={invoice.number} className="txn">
						<div className="txn__main">
							<span className="txn__what">
								{invoice.number} · {invoice.periodText}
							</span>
							<Amount minor={invoice.amountMinor} currency={invoice.currency} />
						</div>
						<p className="card__muted txn__meta">
							{invoice.clientName} · issued {invoice.issueText}
						</p>
						<InvoiceDownload invoice={invoice} />
					</li>
				))}
			</ul>
			{card.total > card.invoices.length ? (
				<p className="card__muted">…and {card.total - card.invoices.length} older</p>
			) : null}
		</section>
	);
}

// ----- notes ----------------------------------------------------------------------------------------------------------------------------

export function AccountantNoteView({ card }: { card: AccountantNoteCard }) {
	return (
		<section className="card card--money" aria-label={card.heading}>
			<header className="card__head">
				<span aria-hidden="true">🗒️</span> {card.heading}
			</header>
			<ul className="notes">
				{card.lines.map((line, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed once posted and can repeat
					<li key={index}>{line}</li>
				))}
			</ul>
		</section>
	);
}
