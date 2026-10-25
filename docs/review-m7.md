# M7 review (read-only), advisory for the coordinator

Reviewed: `HEAD 2a0043d` (M6 commits) plus the working tree (27 modified, 20 new files or directories in `git status --short`; node_modules/.next/dist/data* excluded).
Read: the brief, `handoff-m7`, `handoff-m7-2`, `progress-m7`, PLAN §2 and §5, design-notes (Accountant), `review-m6`, every new or changed source file under `packages/extensions/src/{money,ledger,splits,invoices}`, `packages/shared/src/{money,accountant}.ts`, the server and web diffs, and the tests named below. Durable and pi-codemode behaviour was read in the installed 1.4.0 `dist`, not the checkout.
Evidence scripts: `/tmp/m7-review-scratch/<id>.ts`, run with `cd /tmp/m7-review-scratch && node <id>.ts` (Node 24 strips types; temp dirs, no network).

**Verdict: 0 blockers, 7 should-fix (S1-S7), 1 test should-fix (T1), 14 nits (N1-N14), 10 unverified risks (U1-U10).**
The money core holds: integer minor units end to end; exact largest-remainder sums (400 random bills against an independent BigInt oracle, 0 differences); replays by call id (16 write tools, clock moved 2 days, no row moves); an M6 data directory upgrades cleanly; file serving, template escaping and the approval hook hold. What is wrong is at the edges: code mode's time limit is not applied (S1), one CSV cell can freeze the whole server (S2), and the CSV, settlement and recategorize paths can silently corrupt the owner's numbers in ordinary situations (S3-S7). Act first on **S1, S2, S3**.

## Doc claims that do not hold

1. `docs/design-notes.md:561` and `apps/server/src/domain.ts:116`: the sandbox is "256 MiB, one minute". Only the memory limit is enforced (S1).
2. `README.md:33, 86-87` and `domain.ts:175` ("can only read the ledger", "reaches the ledger's tools and nothing else"): a script can call all **34** callable tools of the Accountant (`c05`): the writes (`add_expense`, `confirm_import`, `set_balance`, `split_bill`, `generate_invoice`, `set_invoice_profile`) and the file reads (`read_file`, `read_file_path`, `list_dir`, `search_files`) too. The approval hook applies to nested calls (verified, mutants MU23/MU36 killed); nothing else restricts them. Fix the sentence, or mark the write tools `callers: ["model"]` if scripts should only read.
3. `README.md:77`: `/tool set_balance {"account":"BoB","amount":98000}` fails validation (`r01`); the parameter is `balance`.
4. `apps/web/src/components/cards.tsx` (comment above `ImportConfirmButton`, ~line 127): confirming "goes through the same approval of the owner's own message". There is no approval step: the model decides to call `confirm_import` (U2).
5. `apps/server/test/m7.test.ts:350-351,358-359` and progress-m7 §5.9: "an `upload` row into the workspace and a `path` row are 404" is asserted, but those two rows are never inserted (T1).
6. Holds: "+165 tests, 54 files / 1116 tests"; "daily.test.ts no longer leaks" (no new `/tmp/assistant-*` after a full `pnpm test`); "600 random bills" (`splits.test.ts:99-145`).

---

## A. Confirmed defects (reproduced)

### S1 [should-fix] The code mode time limit is not applied: a script with no `timeout_ms` runs until the owner presses Stop, and starts again after a restart
- Where: `apps/server/src/domain.ts:116,176-177` (`CODEMODE_LIMITS`, `new CodemodeSandbox`); Durable `pi-durable/dist/codemode/codemode.js:296,312`; `pi-codemode/dist/runtime/execution.js:470`.
- Evidence (`c01`-`c04`, `c07`, `d02`): a sandbox built with `timeoutMs: 2000` (production: 60_000) and a script `while(true){}` through the faux model: still running after 9 s, 9.2 s of CPU on a worker thread. `conversation.abort` ends it and frees the thread. Closing the harness and reopening the same files: the loop runs again by itself (3.0 s CPU in the next 3 s). `// @options: {"timeout_ms": 86400000}` is accepted. Memory (64 MiB probe: "out of memory") and stack limits do work. A paging loop writes about 281 KB of Durable journal per `ledger_query` page of 1000 rows: 50 pages grew `durable.sqlite(+wal)` by 14 MB in 1.8 s, so an endless `while (next_offset ...)` bug fills the disk at several MB/s. `server.close()` with a running script returns in 47 ms.
- Mechanism: the Durable extension runs scripts with `sandbox.start()`, which takes `options.timeoutMs ?? Number.POSITIVE_INFINITY`; Durable passes `timeoutMs` only when the script's own `@options` line set one. The sandbox's configured `timeoutMs` is never read on this path, and the model picks the limit (up to 2^31-1 ms) or none.
- Fix: an extension beside `codemode` with `wraps: [wrapTool(codemodeTool, ...)]` (`pi-durable/dist/harness/define.d.ts:15`) that prepends `// @options: {"timeout_ms": 60000}` when absent and clamps a larger value. Proven on a 1.5 s stand-in (`c04`: no option, and a 24 h request, both end "timed out" at about 1.5 s; a fast script is unaffected). Add a test (`while(true){}` ends with "timed out"; a 24 h request is clamped) and correct the doc line.

### S2 [should-fix] A quadratic regex in CSV date parsing lets one cell freeze the whole server
- Where: `packages/extensions/src/ledger/csv.ts:183` (`TIME_SUFFIX`), used at `:202` (`parseDateCell`) and `:235` (`detectDateOrder`); callers `statement.ts:152` (`isDate` is tried on every column when no header is recognised) and `:377` (`normalizeRows`).
- Evidence: `p02`: one cell `x` + n spaces + `y`: 5k = 23 ms, 10k = 96, 20k = 354, 40k = 1437 (x4 per doubling; a run of `T` is the same). `p03`, whole server, uploaded CSV with one 40,000-space date cell: `import_csv` took 5.9 s and the process's event loop did not run for **5.75 s** (10 ms heartbeat). By the same curve a 1 MB cell is about 15 minutes and the 8 MB import limit hours. `import_csv` runs on the server's only thread, so HTTP, SSE and timers all stop. The importer's other regexes are linear (`parseAmountText` 0 ms at 40k).
- Mechanism: the regex is not anchored at the start (`[T\s]+` then digits), so on a long whitespace run every start position rescans the rest of the run. Untrusted content (a statement the owner is sent) reaches it.
- Fix: return `undefined` for a cell longer than about 40 characters before any regex, in both functions. Test: a 100k-space cell returns in under 50 ms.

### S3 [should-fix] A Dr/Cr indicator column is ignored, and a header like "Amount (Dr/Cr)" turns credits into expenses
- Where: `statement.ts:54-66` (`HEADER_ROLES`: `debit` matches the word `dr`, `credit` matches `cr`), `:147` (`pick("debit")`), `:366-400` (`normalizeRows`: `-Math.abs(out)`); there is no mapping field for an indicator column.
- Evidence (`a06`, `a07`), all with no problem reported in the preview:
  (a) `Date,Description,Amount,Dr/Cr,Balance` with `120000.00,CR` and `1250.50,DR`: every row is read as money **in** (SALARY +12,000,000; DRUK MART +125,050; TAXI +30,000). `mapping.invert: true` flips all of them (SALARY becomes -12,000,000), so no mapping fixes it.
  (b) `Amount (Dr/Cr)` with `120000.00 CR` / `1250.50 DR`: the header contains `dr`, the column becomes the debit column, and `-Math.abs` makes the salary an expense.
  (c) `Date,Details,Type,Amount` with Type `Credit`/`Debit`: Type is ignored; a Tea debit is read as +4,500 income.
  The same indicator inside the cell (`1250.50 DR`) works.
- Fix: recognise a column whose cells are all DR/CR/Debit/Credit/D/C and apply it to the amount column (also accept it as `mapping.direction`); do not give a column the debit or credit role when its own cells carry a sign or an indicator; make the preview say loudly when one direction is empty over 10 or more rows ("every row is money in: check the Dr/Cr column or mapping.invert"). Tests for the three shapes.

### S4 [should-fix] A wrong import cannot be undone except one entry at a time
- Where: `ledger/import-tools.ts:290` (`confirm_import`, up to 20,000 rows); `ledger/tools.ts:631` (`propose_delete_txn` takes one `txn_id`). The tool list (`c05`) has no `delete_import`.
- Evidence: read from code and the tool list. With S3 or S5 a wrong import (inverted signs, wrong account, duplicates) needs one approval per entry. Each row carries `source_ref = im_...`, so an undo is easy.
- Fix: `propose_delete_import(import_id)` with an approval action that deletes `source = 'csv' AND source_ref = ?` and puts the import back to `preview`; test through the hook.

### S5 [should-fix] A CSV row that repeats an entry typed in chat (or read from a receipt) is not noticed: spending and balances double count
- Where: `ledger/import-tools.ts:179` (`existingHashes` knows import hashes only); `ledger/tools.ts:102` (`similarTxn` guards chat adds only).
- Evidence (`a02` case 2, `a11`): lunch typed in chat (Druk Mart 450, 5 Oct), then a bank CSV with `DRUK MART 123456` 450 on 5 Oct. Preview: `rows 1, duplicates 0`, no warning. After confirm Druk Mart is in the ledger twice and the balance (stated 10,000 on 1 Oct) goes 9,550 to **9,100** (the bank holds 9,550); spending and the shares double count too.
- The owner's stated workflow (handoff-m7 "User intent") mixes typed entries, receipt photos and CSV exports, so this is the default outcome, not an edge.
- Fix: in `import_csv` count and list rows that match an existing non-csv entry on (account, day, amount), say their ids, and skip them unless the call says `include_matches: true`. Test.

### S6 [should-fix] `record_settlement` with a shorter spelling of a known friend creates a reverse debt and leaves the real one open
- Where: `splits/tools.ts:366-367` (names resolved by whole-name key); `lookalikes` runs only for `split_bill` (`:240`).
- Evidence (`b03`): a bill I paid, shared with `Pema Dorji`: "Pema Dorji owes you Nu. 500.00". `record_settlement {from:"Pema", to:"me", amount:500}` answers "That is more than was owed. Now you owe Pema Nu. 500.00." and `who_owes` lists **both** "Pema Dorji owes you Nu. 500.00" and "You owe Pema Nu. 500.00".
- Fix: resolve `from` and `to` against `knownPeople` as `findKnown` does (whole key, else a single partial match), or refuse with "did you mean 'Pema Dorji'?" using `lookalikes`. Test.

### S7 [should-fix] `recategorize` by merchant matches substrings, changes up to 500 entries without a preview, and keeps no undo
- Where: `ledger/store.ts:348` (`merchant_key LIKE '%word%'`); `ledger/tools.ts:548` (`recategorize`, no approval); the old categories are not stored.
- Evidence (`a12`): `recategorize {merchant:"tea", category:"entertainment"}` moved "Tea stall", "Steak House" and "Teaching fee" ("3 entries are now in entertainment"); `merchant:"pema"` also took "Pemagatshel Hospital". The answer is a count only.
- Fix: whole-word match for the bulk write (`(' ' || merchant_key || ' ') LIKE '% word %'`), name the merchants and counts in the answer, and keep the old categories in `ledger_call.subject` (or make the bulk form preview then confirm). The read-only filters (`list_txns`, `ledger_query`) share the substring rule; harmless there.

### T1 [should-fix, test] The tests of `GET /api/files/:id` for generated files are partly vacuous; the security guards behind them are unprotected
- Where: `apps/server/test/m7.test.ts:350-351` (rows `fi_aaaa0004` "path" and `fi_aaaa0005` "upload into the workspace"), asserted at `:358-359`.
- Evidence (`t01`): `registerFile` is `ON CONFLICT (path) DO NOTHING` and both rows reuse `ok.pdf`'s path, so neither row exists; the two 404s hold for any code. Mutants MU60 (a `path` row is served from the workspace), MU61 (either root accepted) and MU62 (no `realpath`: a symlink in the workspace escapes) all survive `m7.test.ts` (MU62 re-run by hand: 9 of 9 pass).
- The code itself is right (`d01`: symlink to outside 404, sibling `workspace2` 404, `Host: evil.example` 403, traversal ids 404), so this is a gap, not a bug.
- Fix: one file per row, assert `getFile(...)` is defined before the status, add a symlink case.

---

## B. Unverified risks (mechanism read from code or docs; not reproduced)

- **U1 Injection plus reach.** The Accountant reads untrusted CSV text and receipt images, has `read_file_path`/`list_dir` over the owner's allowed folders, and has free-text fields that end on a PDF the owner may send (`notes`, `reference`, `description`, address). A planted instruction could read a document and print it into an invoice. Needs a real model to judge; no tool sends anything (rule 1 holds).
- **U2 The confirm step is model-gated only.** `confirm_import` can follow `import_csv` in one turn; a typed "YES" while a delete approval waits in the same thread would approve the delete (the YES window closes only when the owner sends something else). The Confirm button sends a different message, so it closes the window.
- **U3 Browser behaviour not run** (no DOM library): the Confirm button (`composer.setText` replaces a draft, ★10), 390 px layouts, React keys. Read from code only.
- **U4 `pnpm build` and the bundle smoke were not re-run.** `apps/server/dist/main.js` (built 14:49) keeps `pdfkit`, `mustache` and `@earendil-works/pi-codemode` external (`main.js:6272, 6346, 13913-13914`), and no source file is newer than it.
- **U5 No real model has driven `ACCOUNTANT_RULES` or the tool descriptions** (progress-m7 §6 says so). The faux model only echoes `/tool` lines.
- **U6 Real bank formats unknown** (BoB, BNB, mBoB): Dr/Cr conventions (S3), date order, decimal style, `Reference` columns (N10).
- **U7 An issued invoice cannot be re-rendered.** `invoice_issued` keeps no snapshot of the address, payment details or notes, and `again` makes a new number (N11).
- **U8 Privacy:** the wrap-up facts give the PA the day's spending by category and income, and the PA keeps them in `pa_journal.auto_summary` (same shape as M6 U7). The README mentions what the Accountant's thread sends, not this.
- **U9 Dependencies:** `pdfkit 0.20.2`, `mustache 4.2.0`, `@earendil-works/pi-codemode 1.4.0` and the lock additions look conventional (pdfkit stack, `@noble/*`, no install scripts seen), but versions and provenance cannot be checked offline.
- **U10 `apps/web/.next/` and `apps/server/dist/` carry mtimes 14:49:23-26**, 25 s after my baseline (14:48:58): the worker's last build finishing, not mine. No tracked or untracked source changed (hashes identical).

---

## C. Nits (confirmed)

- **N1** `import-tools.ts:269`: the result shows the preview's out/in totals even when nothing was added: a second preview of one file confirmed second says "Imported 0 entries ... Nu. 170.00 out" (`a02` case 4).
- **N2** `reports.ts:118`, `statement.ts:366`: CSV rows dated after today are accepted and count in the balance now (a 31 Dec row took Nu. 9,000 off on 25 Oct, `a02` case 3); chat refuses future days. Reject or flag them, or compute balances up to today.
- **N3** `ledger/tools.ts:364-375`: a `set_balance` older than the latest stated balance says "This is the opening balance" while `balances` is unchanged (`a03`: 9,999.00 as of 1 Oct, balance stays 4,900.00). Say that it changed nothing.
- **N4** `tools.ts:102`, `common.ts:130`: one receipt file recorded twice (another merchant spelling) gives two entries and no warning (`a03`). Warn when `source_ref` already has an entry.
- **N5** `reports.ts:70-100`: `list_txns` "Over all N: out ..., in ..." counts both legs of a transfer (`a10`: 450 spent and 5,000 moved shows "out Nu. 5,450.00"; `spending_summary` says 450).
- **N6** `ledger/tools.ts:700`: `archive_account "savings"` archived "BoB savings" (first partial match in name order), not the account named "Savings" (`a13`). Prefer an exact key and refuse an ambiguous one, as `resolveAccount` does.
- **N7** `ledger/keys.ts:9`: `nameKey` drops every combining mark, so Devanagari and Tibetan names that differ only by vowel signs are one key ("किरण" = "करण", "པདྨ" = "པདྨི"). Latin accents are fine.
- **N8** `money.ts:124` with `detectDecimalSeparator`: a column of only whole European amounts ("1.200", "2.500") is read with point decimals, 1000x too small ("Nu. 3.70 out", `a01`, `a02` case 1).
- **N9** `money.ts:175`: letters are removed anywhere in a cell: "Ref123456" becomes Nu. 123,456.00, "1e5" Nu. 15.00, "0x1F" Nu. 1.00 (`a01`). Only matters when a text column is taken for the amount.
- **N10** `statement.ts:54-66`: "Reference", "Name" and "Notes" are description words and the first such column wins: `Date,Reference,Narration,Debit,Credit` uses the reference as the merchant (`a07`).
- **N11** `invoices/tools.ts:261`: "generate it again with again: true" gives the month a second number; a lost PDF cannot come back under its own number (U7).
- **N12** Docs: `setup-invoice.md` §4 does not warn that `{{{x}}}` on a field not ending `_html` prints the model's text as markup (an `<img>` or `<a>` in a client name); `docs/OPS.md` says nothing about backing up `templates/` and `workspace/invoices/`.
- **N13** `accountant-cards.tsx` (SplitView `key={extra.label}`): two extras with one label repeat a React key (read, not run).
- **N14** Uploads accept UTF-8 only (`judgeUpload` refuses UTF-16 and Windows-1252 with a clear message, `u01`), so the importer's other encodings are reachable only through `read_file_path`.

---

## Veto points (progress-m7 §5 and handoff-m7-2 §7)

Session 2: ★1 accept. ★2 accept (a payment in the wrong direction flips the balance and says "more than was owed"; S6 is the way it goes wrong). ★3 accept, and run the same lookalike check in `record_settlement` (S6). ★4 accept with a caution: an owner who forgets `me` in `people` makes their friends pay the owner's share; the warning is the last line of the answer. Consider an explicit `payer_has_no_share`, or putting the warning first. ★5, ★6, ★7 accept (verified: failed template uses no number, one call at a time). ★8 accept. ★9 accept (verified in `d01`; fix T1). ★10 accept for the no-new-route reasoning, but the confirm is model-gated (U2) and it replaces a draft. 11-12 accept.
Worker 1: ★1 accept (verified, `a01`, `money.test`). ★2 accept, wording N3. ★3 accept, N5. ★4 accept (oracle). ★5 accept. ★6 accept once S2-S5 are fixed. ★7 accept. **★8 (splits write no ledger entries): reconsider.** The owner's own payment to a friend ("I paid Pema 250 from mBoB") never reaches spending or the balance unless the owner asks for an `add_expense`, and "where is my money going" is a core use. An optional `account` and `category` on `record_settlement` (from the owner) that writes the entry in the same call, idempotent by call id, would make the easy path the right one.

---

## D. Checked and holding

- **Gates (me, serial):** `pnpm typecheck` 5 projects, 0 errors; `pnpm lint` 258 files clean; `pnpm test` **54 files / 1116 tests**, 31.7 s, no leaked `/tmp` dirs. Three concurrent runs of the 9 touched files: 250 tests each, stable.
- **Money:** `toMinor`, `percentOf`, `convertMinor` (also with a rate stored the other way, `a08`), `allocate` (ties, signs, zero weights); no float arithmetic in storage, sums or shares (grep: only display divisions); dates strict (`a09`: 2026-02-30, future days, 1999 refused); 19,990-row import 0.4 s preview, 1.3 s confirm (`p01`).
- **Splits:** 400 random bills (items, subsets, percent and amount extras, a discount, payer outside `people`) against an independent BigInt oracle: 0 differences; `who_owes` netting over 150 random settlements: 0 differences (`b01`).
- **Rule 8:** replay of 16 write tools two days later: no row count moves (`a04`); a code mode script cut by a restart after two writes resumes and writes once, with stable nested ids `script-R/cN` (`c06`).
- **Approvals:** `delete_txn` and `delete_split` are registered actions; the hook blocks them, also inside a script; a YES executes once (m7.test.ts, MU23/MU36 killed).
- **Capability boundary:** Accountant offered 20 tools plus 14 deferred; `ledger_query`/`ledger_accounts` are script-only; the PA, Health and Inbox agents have none of them (`c05`, m7.test.ts); `models: false` leaves no `models` global; `read_file` on a PDF says the assistant cannot read it (`d03`).
- **Invoices:** the number is bumped in the same transaction as the row, `UNIQUE(number)`; three calls at once take three numbers; a failed template uses none; hostile profile text (`<script>`, `{{...}}`, `<img src="../secrets/...">`, RTL and NUL characters, ₹, emoji) comes out as literal text in the PDF, with no `/URI`, `/JS` or `/OpenAction` (`i01`, read back with `pdftotext`/`pdfinfo`); template links and images cannot leave the templates folder (image guard has a test; the template-symlink guard has none, T4).
- **File serving (`d01`):** `Host` check 403; traversal and NUL ids 404; a symlink inside the workspace to an outside file 404; a sibling `workspace2` 404; headers `attachment`, `nosniff`, `Content-Security-Policy: sandbox`. The route sits after `requestGuard` and `authMiddleware` (`app.ts:115-121`). No new endpoint.
- **Migrations (`m01`, `m02`):** an M6 database gets exactly `files/002_generated_source`, `ledger/001-003`, `splits/001`, `invoices/001`; `files_index` rows and its indexes are kept; integrity and FK checks clean; a second run applies 0; the `'generated'` source is accepted and `'weird'` refused; M6 code against the M7 database is refused with a clear message. A whole M6 data directory started by the M7 server logs "updated instructions/extensions: accountant", keeps the thread, and writes the default template.
- **Sandbox:** memory and stack limits enforced (`c02`); Stop frees the worker; shutdown with a running script takes 47 ms.
- **Cost:** nested tables 8 deep 97 ms; a 5000-row table 311 ms (`i02`).
- **Not touched by M7** (git paths): reminders and timers, `reconcile`, push, VAPID, `sw.js`, approvals, `daily/` except a new facts provider, the retry endpoint, the auth/Host/CSRF rules. The only `http/` changes are the `workspaceDir` plumbing and the root choice in `GET /api/files/:id`. Conclusions of `review-m6` stand for those.

---

## E. Test quality

- **Strong:** real SQLite and Durable with a fake clock; a 600-bill property test with per-person bounds; whole-server tests; a PDF whose text is read back; replays on a later day; code mode through a real Harness.
- **Mutation check** (51 one-line mutants of `packages/extensions/src` and `http/uploads.ts`, in copies under `/tmp/m7-mut`; the 138 tests of money, ledger, ledger-csv, splits and invoices, plus `m7.test.ts` for the server ones): **37 killed, 14 survived.**
  - Real gaps: **MU60/61/62** (T1); **MU22** balances with a stored inverse rate (`a08` shows the code is right); **MU44** a symlinked `invoice.html`; **MU48** a profile with an empty client name; **MU07** `DR` and `CR` in one cell (T4).
  - Redundant or equivalent: MU15 and MU16 are two guards for one replay (both removed: killed by "writes once for a call Durable replays"); MU25 (inner guard behind the outer one); MU33 (a self debt is skipped by `netEntries`); MU40 (behind the in-process mutex and `UNIQUE(number)`); MU43 (a `<` needs a `>` to make a tag and `>` is still escaped).
  - Inconclusive: MU37 (my mutant changed the rounding only at an exact half).
- **T2** No test bounds a script's time (S1); **T3** none feeds a long cell to the CSV parser (S2); **T5** none covers an indicator column, a chat entry repeated in a CSV, a short spelling in `record_settlement`, or a substring merchant (S3, S5, S6, S7).
- **Weak by construction:** `f.callTool` skips Durable's schema validation and the hook (the validation path was checked through the faux model: `amount: null` clears the usual amount, `"450"` is coerced, `"Nu. 450"` is refused with the field named).

---

## F. What I did and did not do

- **Ran:** the three gates and three concurrent runs (logs `/tmp/review-m7-{typecheck,lint,test,conc-1,conc-2,conc-3}.log`); about 45 scratch scripts in `/tmp/m7-review-scratch/` (`a01-a13` ledger and CSV, `b01-b03` splits, `c01-c07` code mode, `d01-d03` whole server, `i01-i02` invoices, `m01-m02` upgrade from an M6 data directory built from `git archive HEAD`, `p01-p03` size and speed, `r01` README lines, `t01` vacuous test, `u01` upload encodings, `lib.ts`); the mutation harness `/tmp/m7-mut/run-mutants.py` with `/tmp/m7-mut/results.txt`.
- **The repo is untouched:** sha256 of all 305 tracked and untracked non-ignored files is identical before and after (`/tmp/review-m7-baseline.sha`, `/tmp/review-m7-after.sha`), and so are the `git status --short` and `git diff HEAD` hashes; HEAD `2a0043d`, no stash. The gates rewrote only ignored files: `apps/web/tsconfig.tsbuildinfo` (tsc), `node_modules/.vite` and `.vitest-cache` (vitest). No edits, installs, formatting, `pnpm build`, git mutation, network, logins or long-lived servers (probe servers were in-process on ephemeral ports, closed at once).
- **Not reviewed (marked as the coordinator asked):**
  - `apps/web/src/app/globals.css` (233 added lines): not read; no 390 px computation.
  - `invoices/default-template.ts`: not read (rendered through `i01`).
  - Test bodies: `accountant-cards.test.ts` (titles only); `ledger.test.ts`, `splits.test.ts`, `invoices.test.ts` (the parts quoted above, not every body).
  - Browser and UI events, `pnpm build` and the bundle smoke (U3, U4), a real model, real push, the Android share sheet.
  - Reminders, timers, `reconcile`, Web Push, VAPID, the service worker, the parked-task retry and the existing auth/Host/CSRF endpoints: not touched by M7 (git paths); I relied on `review-m6` and the green suite, and re-tested only the `GET /api/files/:id` guards.
  - Fixes of earlier reviews (m1-m4) beyond what the suite covers; dependency provenance (no network).
- **Left in `/tmp`** (yours to delete): `/tmp/m7-review-scratch/` (including `head/`, a `git archive` of HEAD wired to the repo's node_modules), `/tmp/m7-mut/`, the logs and sha files above. I removed the 22 `assistant-ext-*`, `assistant-test-*`, `assistant-inv-*` and `m7-upgrade-*` temp directories my own probes made (none existed before I started, and a full `pnpm test` leaves none).
