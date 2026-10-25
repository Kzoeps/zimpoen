# Handoff: M7 — Accountant agent

Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, `main` (M1–M4, M6 committed). Coordinator commits; you don't.
Read: `docs/PLAN.md` (§1, §2 esp. rule 7 arithmetic-in-code, §5.2, §7), `docs/design-notes.md`, `docs/progress-m6.md` (latest
patterns: domain module, facts provider, charts, deferred tools + tool_search, approvals), `docs/handoff-m2-2.md` §3.
Constraints: as in `docs/handoff-m2.md`.

## User intent
- Feed the month's expenses (typed in chat, bank/app CSV exports, receipt photos), mostly **BTN** (Ngultrum, Nu.), sometimes USD/INR.
  Ask "where did I spend the most", "where is my money going"; keep track of how much money I have (balances).
  "I lost $500 on my phone" → recorded and balances update.
- Bill splitting with friends: one person pays; give the bill (photo or text) and who had what → how much each owes; track who owes whom until settled.
- Monthly invoice: user has a template; every month copy, set new dates, invoice number, amount → PDF delivered as a downloadable file in chat.
  NEVER send it anywhere (rule 1).

## Scope
1. **ledger module** (accountant agent only): `ledger_account(id, name, kind cash|bank|wallet|card, currency, archived)`,
   `ledger_category(id, name, parent)` (seed sensible defaults: food, groceries, transport, rent, utilities, phone/internet, health,
   shopping, entertainment, travel, gifts, fees, other), `ledger_txn(id, account_id, occurred_on, amount_minor INTEGER signed,
   currency, category_id, merchant, note, source kind chat|csv|receipt, source_ref, source_call_id UNIQUE, import_hash UNIQUE NULL)`,
   `ledger_balance_snapshot(account_id, as_of, amount_minor)` for reconciliation, `ledger_fx(date, from, to, rate)` user-supplied rates only
   (no network). Money is integer minor units; BTN default; never floats in storage. Balances = latest snapshot + txns since (code).
2. Tools: `add_expense`/`add_income`/`add_transfer`, `set_balance` (snapshot), `list_txns(filters)`, `spending_summary(range, group_by
   category|merchant|account|week)` (code), `balances()`, `recategorize`, `propose_delete_txn` (approval), `import_csv(file_id, account,
   mapping?)` → preview step returning detected columns + sample + proposed mapping, then `confirm_import(import_id)` (dedupe by import_hash;
   idempotent), receipt flow: model reads image via existing file tools and calls add_expense with `source_ref=file_id` (store link).
   Install Durable **code mode** for the accountant (`@earendil-works/pi-durable/codemode`, `@earendil-works/pi-codemode` QuickJS sandbox) with
   query tools `callers:["tools"]` (`ledger_query` returning rows) so analysis scripts aggregate in code. If code mode proves impractical
   in 1.4.0, document why and rely on `spending_summary`; ask coordinator only if it blocks.
3. **splits module**: `splits_bill(id, title, occurred_on, payer, total_minor, currency, tax/service handling, source_ref)`,
   `splits_item(bill_id, description, amount_minor, shared_by[])`, `splits_share(bill_id, person, owed_minor)`, `splits_settlement`.
   Tools: `split_bill` (items + who had what + shared items + tax/service/tip proportional; equal split option; rounding: largest-remainder
   so shares sum exactly to total), `who_owes`, `record_settlement`. People names may link to `people_person` (shared) when matched.
4. **invoices module**: `invoice_profile` (client name/address, rate/amount default, currency, payment details, numbering pattern e.g.
   `INV-{YYYY}-{seq:03}`, next seq), `invoice_issued(number UNIQUE, period, issue_date, due_date, amount_minor, file path)`.
   Tool `generate_invoice(month?, amount?, overrides?)` → renders template → PDF in `<data>/workspace/invoices/` → returns file card with
   download link (`GET /api/files/:id` existing). Template: `<data>/templates/invoice.html` (Handlebars/Mustache-style, documented
   fields); ship a clean default template copied there on first start if absent. PDF rendering: choose a dependency that works offline on
   Linux without a browser download if possible (e.g. pdfkit / pdf-lib layout from template fields) OR headless Chromium already used
   by agent-browser if reliably present — prefer a pure-JS route; document. `docs/setup-invoice.md`: how to drop in the user's template.
5. Accountant prompt section (no clock): balances summary, this month's spend top 3 categories, unsettled splits count, next invoice number.
   Daily facts provider: expenses added today total. Accountant instructions: arithmetic only via tools, BTN formatting "Nu. 1,234.50".
6. Web: spending summary card (bar chart by category), balances card, txn list card, CSV import preview card with confirm button,
   split result card (table), invoice card with download. 390 px.
7. Fix test hygiene: `daily.test.ts` leaks `/tmp/assistant-ext-*-backup` dirs per run — clean up in afterEach.
8. Tests: money math (minor units, rounding, largest remainder), CSV import (encoding, separators, dedupe, idempotent confirm), splits exact sums,
   invoice numbering (no reuse, idempotent per call), PDF generated and non-empty, template field rendering escapes, balances math, approvals.
9. Docs: README, design-notes, PLAN deviations, `docs/setup-invoice.md`, `docs/progress-m7.md`; browser check screenshots `/tmp/assistant-shots/m7/`.

## Done when
Gates green, report, servers stopped, reply DONE-M7. Context hygiene ~55% → `docs/handoff-m7-2.md`, DONE-HANDOFF.
