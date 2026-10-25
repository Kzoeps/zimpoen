# M7 progress log (worker → coordinator)

Scope: `docs/handoff-m7.md`. Worker 1 did the ledger (`docs/handoff-m7-2.md` has its state and designs); worker 2 (this report) did the
rest: splits, invoices, server wiring, web, the browser check, the bundle smoke and the docs. **M7 is complete.**
Branch `main`, nothing committed or pushed (the coordinator commits). No OpenAI, Google or TypeSafe call, no real push service, no
login, no `railway`; **every server I started is stopped, nothing listens on 3000–3099**, the throwaway data directories are removed.

## 1. State

| Scope item | State |
| --- | --- |
| 1 ledger module: accounts, categories, entries (integer minor units), snapshots, owner-given FX | done (worker 1) |
| 2 ledger tools, CSV import (preview → confirm), receipt link, code mode | done; **installed on the accountant** (`ledger_query`/`ledger_accounts` for scripts, `models: false`) |
| 3 splits: `split_bill`, `who_owes`, `record_settlement` (+ `list_splits`, `propose_delete_split`, deferred) | done, tested |
| 4 invoices: profile, numbering, template, PDF, `generate_invoice`, `docs/setup-invoice.md` | done, tested; PDF from the **built bundle** verified |
| 5 prompt sections (`ledger`, `splits`, `invoices`), wrap-up facts, accountant instructions | done (`ACCOUNTANT_RULES` in `apps/server/src/agents.ts`) |
| 6 web cards: spending bars, balances, entries, import preview with Confirm, split table, who owes, invoice download | done; 390 px checked in a browser |
| 7 `daily.test.ts` temp-dir leak | fixed (`backups` removed in `afterEach`; a run leaves no new `/tmp/assistant-ext-*`) |
| 8 tests | +165 (money 17, ledger-csv 21, ledger 42, splits 29, invoices 29, whole-server 9, web 18) |
| 9 docs, browser check | README, `design-notes.md`, `PLAN.md`, `docs/setup-invoice.md`, this file; screenshots in `/tmp/assistant-shots/m7/` |

## 2. Commands run and results (serial, after the last change)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | 5 packages, 0 errors |
| `pnpm lint` | clean (258 files) |
| `pnpm test` | **54 files, 1116 tests pass** (47 / 951 before M7) |
| `pnpm build` | web and server build; `dist/main.js` 668 kB |
| Bundle smoke: `ASSISTANT_DATA_DIR=/tmp/m7-smoke ASSISTANT_READ_PATHS=/usr/share/doc ASSISTANT_AUTH=off ASSISTANT_MODEL_MODE=faux ASSISTANT_PORT=3005 node apps/server/dist/main.js` | starts; applies all 24 migrations (`ledger/001–003`, `splits/001`, `invoices/001`, `files/002_generated_source`); logs that it wrote the default template; `/tool codemode` ran a script over `ledger_query` (`{"rows":2,"sum":-15075,"models":"undefined"}`); `/tool generate_invoice` made `INV-2026-001.pdf` from the built bundle (pdfkit, mustache and pi-codemode resolve as external packages); `GET /api/files/:id` served it (`application/pdf`, `attachment`, `nosniff`, CSP `sandbox`, starts `%PDF-`); clean SIGTERM; `/tmp/m7-smoke` removed |
| Browser check (dev servers 3000/3001, faux model, throwaway data dir, `agent-browser --args "--no-sandbox"`) | see §4 |

## 3. Changed files (this session; the whole M7 tree is in `git status`)

```text
packages/extensions/src/splits/    NEW compute (pure: splitItems, splitEqually, netEntries), migrations, store, people, reports, tools, index
packages/extensions/src/invoices/  NEW numbering, migrations, store, html (tolerant subset parser), pdf (pdfkit layout), template (Mustache fields, checks, seed),
                                   default-template, render (reads template and images), tools, index
packages/extensions/src/files/     migrations.ts (files/002 rebuilds files_index: source adds 'generated'), store.ts (source type)
packages/extensions/src/index.ts   exports of the two modules
packages/extensions/test/          NEW splits.test.ts, invoices.test.ts; support.ts (splits and invoices in the fixture); daily.test.ts (backup dirs removed)
apps/server/src/                   config.ts (paths.templates, DEFAULT_OWNER_NAME), domain.ts (modules, accountantExtensions, code mode sandbox, close()), agents.ts (ACCOUNTANT_RULES,
                                   buildAgents), server.ts (accountantDeps: invoices folder, template seed; domain.close at shutdown), http/uploads.ts + app.ts (generated files)
apps/server/test/                  NEW m7.test.ts (9 whole-server tests); config.test.ts (path tables, templates not a read path)
apps/web/src/components/           NEW accountant-cards.tsx, file-chip.tsx (FileChip moved out of cards.tsx to avoid an import cycle; cards.tsx re-exports it); cards.tsx (dispatch,
                                   ImportConfirmButton, generated files shown as a chip)
apps/web/src/                      lib/ui-messages.ts (import preview `answered`), app/globals.css (accountant styles)
apps/web/test/                     NEW accountant-cards.test.ts
docs/                              setup-invoice.md (new), README.md, PLAN.md, design-notes.md, progress-m7.md
```

New dependencies (worker 1): `@earendil-works/pi-codemode` 1.4.0, `pdfkit` 0.20.2, `mustache` 4.2.0 (exact pins in `apps/server` and `packages/extensions`),
dev: `@types/pdfkit`, `@types/mustache`. **No new environment variable.** New data directories: `<data>/templates/` (0700, the owner's template, not readable or
writable by agents) and `<data>/workspace/invoices/`.

## 4. What the browser check found (each fixed unless marked)

| # | Finding | |
| --- | --- |
| BC1 | At 390 px the split table's first column was squeezed to a few letters ("Pe/ma", "Tas/hi") and the Owes column was cut off by the card's scroll | Items and Extras columns now fold under the person's name on a phone (`split__col`, `split__parts`), so Person and Owes fit; the table scrolls inside its card only on the desktop layout when needed |
| BC2 | "1 entries" in the import preview's totals | pluralised |
| BC3 | Everything else held: no horizontal page scroll at 1100 or 390 px, no card wider than its box, bars as wide as their shares, dark mode through CSS variables | – |
| BC4 | Behaviour: the **Confirm import** button put "Confirm import im_…" in the chat as a message (the faux model only echoes, so `/tool confirm_import` then ran as the real model would); the preview lost its button ("Confirmed: see the result below."); a second confirm showed "Already imported" | – |

Screenshots (`/tmp/assistant-shots/m7/`): `desktop-*` at 1100 px, `phone-*` at 390 px (spending, balances, import preview, split, who owes, invoice, entry),
`desktop-8-import-result.png`, and `invoice-INV-2026-001-1.png` (the PDF the dev server made, rendered with `pdftoppm`; a development tool only).

## 5. Decisions of this session (★ = for the coordinator to veto; each is cheap to reverse). Worker 1's list is `docs/handoff-m7-2.md` §7

1. ★ **Added `list_splits`, `propose_delete_split` and `delete_split`** (deferred, approval as everywhere). The scope listed three split tools, but a bill entered
   under a wrong name or amount could otherwise never be corrected, and `who_owes` would stay wrong for ever. Deleting a bill or a payment asks first.
2. ★ **A payment larger than the debt flips the balance** (it counts as a loan): "Pema paid me 500" with 300 owed leaves "you owe Pema 200"; the result says
   "That is more than was owed". The balance is netted per pair of people and currency; nothing is converted.
3. ★ **A name that begins like a known one is flagged, not merged** ("Pema" after "Pema Dorji"): people are matched by their whole name, and the result tells the
   model to use one spelling.
4. ★ **A payer who is not among `people` is allowed and said so** in the result (their share is 0), because "I paid for lunch with Pema and Tashi" with the
   payer left out would otherwise split between two.
5. ★ **A template with a name that is not a field is an error** that lists every field, instead of Mustache printing nothing: a typo on an invoice is the worst
   failure. Partials are refused.
6. ★ **A failed template uses no number and leaves no file** (the PDF is rendered before the number is taken); the number is bumped in the same transaction as the
   invoice row, from the value that was read.
7. ★ **`generate_invoice` runs one call at a time inside the process** (a promise chain shared with `set_invoice_profile`): Durable may run two calls of a round at
   once, and there is one server per data directory.
8. ★ **`set_invoice_profile` answers a replay from the current profile**, not byte for byte as the first run did (the call is recorded with the change, so a replay
   cannot undo a later edit; `generate_invoice` and `split_bill` do answer a replay with the same words and card).
9. ★ **`GET /api/files/:id` serves `generated` rows from below the workspace only**, resolving the path again at every request, as it does for uploads; an `upload`
   row pointing into the workspace, and a `generated` row pointing elsewhere, are 404. `files/002` rebuilds the index table to allow the new source.
10. ★ **The Confirm button sends a chat message** (`composer.setText` then `send`), with no new route; it replaces a draft in the composer.
11. `DEFAULT_OWNER_NAME` is exported from `config.ts`, so the server passes an owner name to the accountant only when `ASSISTANT_OWNER_NAME` was set.
12. The owner words that mean "me" in a bill are `me`, `i`, `myself`, `owner`, `the owner`, `you`, `yourself` and the configured name (whole); a friend who shares
    the owner's first name is not guessed.

## 6. Could not verify

- A **real model** driving the accountant: its tool descriptions and `ACCOUNTANT_RULES` are a first draft. The dev model only runs `/tool …` lines.
- The **owner's real invoice**: the HTML subset is what an invoice needs, but the owner's layout (their PDF recreated as HTML) has not been tried.
- **Dzongkha or Devanagari text on a PDF**: the standard fonts draw Latin-1 and Windows-1252 punctuation only; the rest prints as `?`.
- The **Android share sheet** with a CSV, and a real bank's CSV: the parser is tested on the formats in the tests (UTF-8/16, Windows-1252, `,` `;` tab `|`, DR/CR,
  brackets, `1.234,50`), not on an export of BoB, BNB or mBoB.

## 7. Known gaps and risks

- **Test invoices use up numbers** (a number is used once, ever). To try a template, set the pattern to `TEST-{seq:03}` first; `docs/setup-invoice.md` says how. A
  `preview` option that renders without taking a number is the obvious next step.
- A table's **header row does not repeat on the next page**, and a table row taller than a page overflows it; neither matters for a one-line invoice.
- A CSV preview nobody confirms stays in `ledger_import` (up to 20,000 rows as JSON) until it is confirmed.
- **Splits do not touch the ledger** (decision ★ of worker 1): the owner's share is recorded with `add_expense` on request, and a friend's repayment reaches an account
  when the owner next states its balance. A model that does not say so leaves the owner thinking the account moved.
- `set_balance` after a day's entries: an entry **dated before** a stated balance is inside it (so "lunch yesterday" recorded after "I have 2,500" does not lower 2,500).
  That is the design (decision ★2 of worker 1) and the result says "difference" when the entries explained something else, but it can surprise.
- The 4 `/tmp/assistant-ext-*` directories and `/tmp/assistant-test-nC1Ggk` are older leaks (of `daily.test.ts` before this fix, and of another test); they are not
  from this work and I left them.
- Not done on purpose: the review (`docs/review-m7*.md`) is the coordinator's.

## 8. Suggested scoped commits (the coordinator commits)

`packages/extensions/src/index.ts` and `test/support.ts` carry all three modules, so the extensions are one commit unless hunks are split.

1. `deps: add pdfkit, mustache and pi-codemode for the accountant` — both `package.json`, `pnpm-lock.yaml`
2. `shared: add money formatting and the accountant's card types` — `packages/shared/src/*`
3. `extensions: add the ledger, splits and invoices modules` — `packages/extensions/src/{money,module,tool-support,index}.ts`, `src/{ledger,splits,invoices}/`,
   `src/files/{migrations,store}.ts`, `test/{money,ledger,ledger-csv,splits,invoices,support}*.ts`
4. `extensions: remove the backup directories daily.test.ts leaked` — `packages/extensions/test/daily.test.ts`
5. `server: attach the accountant's modules, code mode and invoice downloads` — `apps/server/src/*`, `apps/server/test/{config,m7}.test.ts`
6. `web: add the accountant's cards` — `apps/web/src/**`, `apps/web/test/accountant-cards.test.ts`
7. `docs: add the invoice setup guide, M7 notes and plan updates` — `README.md`, `docs/{PLAN,design-notes,setup-invoice,progress-m7,handoff-m7*}.md`

---

# M7 review fixes and finish — worker 3

Scope: `docs/handoff-m7-fixes.md` (the coordinator's adjudication of `docs/review-m7.md`). The previous fix worker wrote the code and tests of every
item (`docs/handoff-m7-fixes-2.md` has its state and decisions); this worker did the browser check at 390 and 1100 px, the one defect it found, the
break-and-restore pass, the docs, the final gates and the bundle smoke. Branch `main`, **nothing committed or pushed**. No OpenAI, Google or TypeSafe
call, no real push service, no login, no `railway`. **Every server I started is stopped (nothing listens on 3000–3099)**; the throwaway data
directories, `/tmp/m7-review-scratch/` and `/tmp/m7-fixes-scratch/` are removed.

## 1. Commands run and results (serial, on the final tree)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | 5 packages, 0 errors |
| `pnpm lint` | 260 files, clean |
| `pnpm test` | **55 files, 1185 tests pass** (54 / 1116 at the end of M7: +1 file, +69 tests; this worker changed two assertions and added one, no new test) |
| `pnpm build` | ok; `apps/server/dist/main.js` 707 kB, built after the last edit |
| Bundle smoke (`node apps/server/dist/main.js`, port 3005, faux model, auth off, throwaway data dir) | applied 25 migrations incl. `ledger/004_undo`; `import_csv` of a Dr/Cr file read the direction column and listed the typed lunch as a match; `confirm_import` left it out; `propose_undo_import` then a typed `YES` removed the import (balance back to Nu. 9,550.00); `preview_invoice` wrote `workspace/invoices/previews/preview-INV-2026-001-<8 hex>.pdf` (0600 in a 0700 folder) and **`invoice_issued` has 0 rows**; an endless `codemode` loop ended with "Script timed out: Execution timed out after 29998 ms" while `GET /api/agents` answered at once; SIGTERM closed it in about a second ("[shutdown] SIGTERM received, closing…"); data dir removed |
| Browser check (`pnpm dev`, ports 3000/3001, faux model, `agent-browser --args "--no-sandbox"`, throwaway data dir) | §3; screenshots `/tmp/assistant-shots/m7/fix-*.png` (26 files) |
| Break-and-restore, 9 mutants in 10 runs | §4: 8 killed at once; 1 survived until an assertion was added, then killed; the 5 mutated files were `sha256`-checked identical to their pre-run hashes afterwards |

## 2. Every item of the adjudication: state and what holds it

| Item | State | Held by |
| --- | --- | --- |
| **S1** code mode time limit | fixed | `packages/extensions/src/codemode.ts`: `// @options: {"timeout_ms": N}` written by a wrapper of the `codemode` tool (default 30 s, a request above 120 s cut to 120 s); a script a restart interrupted past its deadline ends "its deadline passed while it was interrupted". `test/codemode.test.ts` (11, incl. the restart past the deadline through two Harness opens), `m7.test.ts` "ends a script that never ends…". Bundle: ended at 29,998 ms |
| **S2** quadratic date regex | fixed | `csv.ts` `withoutTime` (linear) + `MAX_DATE_CELL = 64`; `ledger-csv.test.ts` (200,000-character cells < 250 ms each; the cap), `ledger.test.ts` (whole `import_csv`, < 1.5 s). Mutants §4 |
| **S3** Dr/Cr column ignored | fixed | role `direction`; `Amount (Dr/Cr)`; Debit/Credit-named columns with DR/CR cells; WARNING when ≥ 10 rows go one way. `ledger-csv.test.ts` "which way the money went" (8), `ledger.test.ts` (2). Browser: the chip, the WARNING block |
| **S4** undo a whole import | fixed | `propose_undo_import` + guarded `undo_import`, migration `ledger/004_undo`. `ledger.test.ts` "taking a whole import back" (3). Browser and bundle: Approve button and a typed YES, both |
| **S5** CSV row repeating a chat/receipt entry | fixed | ±2 days, same account and signed amount, left out by default, `include_matches` / `include_lines`. `ledger.test.ts` (6). Browser: matches block, "looks like an entry you have" |
| **S6** settlement with a partial name | fixed | `ambiguousPayer` / `partialMatches`, `new_person: true`; a bill only flags. `splits.test.ts` (4). Browser: the error text, `who_owes` unchanged |
| **S7** recategorize | fixed | exact merchant by default, `match: "words"`, > 20 needs `confirm`, batches + `undo_recategorize`. `ledger.test.ts` (7). Browser: the three note cards |
| **T1** vacuous file tests | fixed | `m7.test.ts`; MU60–62 killed (break-and-restore by the previous worker) |
| **preview_invoice** | done | `invoices.test.ts` (6), `accountant-cards.test.ts`, `m7.test.ts`. Browser: PREVIEW card; PDF rendered with `pdftoppm` (diagonal PREVIEW on the preview, none on the real invoice, which got INV-2026-001 because the preview took no number). `pdftotext` does not list the diagonal word (poppler skips text at an angle); the render shows it |
| **Veto points** (progress-m7 §5) | all accepted; S6 applied | – |
| **N1 N2 N3 N4 N5 N6 N7 N8 N9 N10 N12 N13** | fixed | one test each, named in `docs/handoff-m7-fixes-2.md` §2 |
| **N11 / U7** invoice cannot be made again under its own number | **deferred** | needs a snapshot of the facts on `invoice_issued` (migration), a re-render tool and tests: well over 15 minutes. Mitigation: `docs/OPS.md` "What to back up", PLAN §9 |
| **N14** uploads accept UTF-8 only | **deferred** | M4's upload policy, with a clear message; taking a Windows-1252/UTF-16 `.csv` as kind `csv` is a cross-module policy decision for the coordinator |
| **Doc claims 1–5** | fixed | README, design-notes, `domain.ts`, `cards.tsx` comment |
| **Test gaps** T2 T3 T5 MU22 MU44 MU48 MU07 | added | MU22 and MU60–62 break-tested by the previous worker; the S-items in §4 by this one |
| **U2** confirm is model-gated | documented | comment in `cards.tsx`, design-notes |
| **U3 / ★10** Confirm button replaces the owner's draft | **found in the browser, fixed** | §3, BF1 |
| **U4** build and bundle smoke | done | §1 |
| **U8** wrap-up facts privacy | documented | README "What the model provider sees" |
| **U1 U5 U6 U9** | open, cannot be done offline | §5 |
| **Worker 1 ★8** (splits write no ledger entries) | not done, for the coordinator | not in the adjudication; PLAN §9 |

## 3. What the browser check found (390 px, 1100 px, dark and light)

Driven through the HTTP API with the faux model (`/tool …` lines) and the real UI for the clicks: accounts, expenses, income and a transfer; `bank1.csv`
(Dr/Cr, one row repeating the typed lunch) → `import_csv` → Confirm button → `confirm_import` → `propose_undo_import` → **Approve** (second round: a typed
**YES** in the composer); `bank2.csv` (12 deposits); a code mode loop writing 25 coffees → `recategorize` preview → `confirm` → `undo_recategorize`;
`split_bill` with "Pema Dorji" → `record_settlement` from "Pema"; `set_invoice_profile` → `preview_invoice` → `generate_invoice`; `list_txns`; a CSV
with a 135-character header and a 120-character unbroken description.

| # | Finding | |
| --- | --- | --- |
| BF1 | **The Confirm import button destroyed what the owner was typing** (U3/★10, reproduced: the draft "my half-written draft…" was replaced by `Confirm import im_…`, sent, and the composer was left empty). Reading assistant-ui showed that `composer.send()` also takes the files picked for the message, so a picked file would have gone along with the confirmation too | Fixed at the root: the button sends through the thread store (`store.getState().send`, as `sendFiles` already does), never through the composer. Browser after: draft kept, a file picked in the composer kept, the sent message carries neither; the button is disabled while the request is in flight. **No unit test: the web tests have no DOM library, and a static render cannot click** (decision ★14) |
| BF2 | The chip `Dr/Cr → Dr/Cr` (the file's header, then the role "Dr/Cr") read oddly | The role word is now "in or out" (`Dr/Cr → in or out`); `accountant-cards.test.ts` pins it |
| BF3 | Everything else held: `document.documentElement.scrollWidth === 390` and 1100 at every step; 31 cards, no card wider than the viewport, none scrolling inside itself, no child wider than its card (a script, run after each group); long unbroken text from a CSV wraps inside the preview, the chips and the matches block; the WARNING block is legible in dark and light (`#c0362c` border, warm background); the PREVIEW badge, red left border, "Download preview PDF 2 KB" label and disclaimer; the approval card (pending → "Approved") and its notice (also "You replied YES. Removed…"); the three recategorize note cards; the earlier cards (spending bars, balances, entries, split table, who owes, invoice) | – |

Not checked in a browser: React's duplicate-key warning (N13; a static render cannot show it, the test checks that both rows draw), the Android share
sheet, a real model. The settlement error appears in the thread as the faux model's echo (`<harness>` tags and all); a real model paraphrases it.
The review had not read `globals.css` (accountant section): nothing in it was wrong at 390 or 1100 px when computed, and it was not read line by line.

## 4. Break-and-restore (one rule broken at a time; the targeted tests run; the file restored and `sha256`-checked)

| Mutant | Tests run | Result |
| --- | --- | --- |
| S2 `withoutTime` returns `text.replace(/[T\s]+\d{1,2}:\d{2}.*$/i, "")` (the quadratic shape of the review) | `ledger-csv.test.ts` "hostile cell" | killed |
| S2b `MAX_DATE_CELL = 64` → `100000` | `ledger-csv`, `ledger` | **survived**: the cap sat behind a linear parser and the test titled "does not take a cell longer than any date with a time" had no assertion that needed it. Added `parseDateCell("25/10/2026" + 80 spaces + "14:03")` → `undefined` (only the length says no) |
| S2b′ the same mutant, after that assertion | `ledger-csv.test.ts` | killed |
| S3 `directionOf` does not know `dr` | `ledger-csv`, `ledger` | killed (3 tests) |
| S4a `undoImport` deletes nothing | `ledger.test.ts` "whole import" | killed (2) |
| S4b `undoImport` deletes every `csv` entry, not one import's | same | killed (1) |
| S5 `MATCH_SLACK_DAYS` 2 → 0 | `ledger.test.ts` "repeats an entry" | killed |
| S6 `partialMatches` always `[]` | `splits.test.ts` | killed (4) |
| S7a `CONFIRM_ABOVE` 20 → 1000 | `ledger.test.ts` "many entries" | killed (2) |
| S7b `merchantExact` as a substring (`LIKE %x%`) | same | killed |

S1 was not mutated (its loops would hang the run): its tests were written against a real endless script and a real restart, and the bundle ended one.

## 5. Decisions of this worker (★ = for the coordinator to veto) and the open list

Earlier decisions ★1–★12 are in `docs/handoff-m7-fixes-2.md` §5 (30 s default and 120 s maximum by wrapping the tool; scripts may call every Accountant
tool, writes under the approval hook; repeats ±2 days against chat and receipt entries only; future-dated rows left out; an undone import stays `imported`
with `undone_at`; `recategorize` defaults to the merchant's whole key; `sumsOf` ignores transfers; a partial-name settlement is a tool error with
`new_person: true` the way out; `preview_invoice` is an everyday tool; stricter `parseAmountText` and all-three-digit European groups read as thousands;
`nameKey` keeps Devanagari/Tibetan vowel signs). All accepted by the adjudication unless it says otherwise. New:

14. ★ **The Confirm button sends through the thread store, not the composer**, which is **not the save-and-restore workaround the adjudication suggested**
    (read `composer.getState().text` before, `setText` it back after `send()`). I checked that workaround against assistant-ui 0.15.31: it would have worked
    for the text (`send()` empties the draft synchronously for the thread composer, and a failed send is merged ahead of whatever was written since), but
    `send()` also takes the picked files, which would have ridden along with "Confirm import". Same size, no workaround. Reverse: put `composer.setText` + `send()` back.
15. ★ The role of a Dr/Cr column is shown as "in or out" (one word in `accountant-cards.tsx`, one assertion).

Still open, cannot be done offline or are not mine: **U1** (prompt injection from a CSV or receipt together with the read tools, needs a real model), **U5** (no real model
has run the revised `ACCOUNTANT_RULES`: whether it shows the matches, uses `include_lines`, asks for the full name after a refused settlement, and loads
`propose_undo_import` with `tool_search`), **U6** (real BoB/BNB/mBoB formats: Dr/Cr conventions, date order, European amounts), **U9** (dependency provenance), **N11/U7**, **N14**,
worker 1 ★8 and the review's caution on ★4 (payer left out of `people`). Also: a CSV preview nobody confirms keeps up to 20,000 rows as JSON; preview PDFs are never deleted by the
assistant (`OPS.md` says so); the Confirm button's click is verified in a browser only.

## 6. Files changed by the fixes (on top of the M7 tree in `git status`; this worker's own edits are marked *)

```text
NEW   packages/extensions/src/codemode.ts, packages/extensions/test/codemode.test.ts
packages/extensions/src/   index.ts, money.ts, ledger/{csv,statement,import-tools,store,tools,reports,keys,migrations,index}.ts, splits/{people,tools}.ts, invoices/{pdf,render,tools}.ts
packages/extensions/test/  ledger, ledger-csv*, splits, invoices, money
packages/shared/src/       accountant.ts, index.ts
apps/server/src/           domain.ts, server.ts, agents.ts           apps/server/test/  m7.test.ts, domain-support.ts
apps/web/src/              components/accountant-cards.tsx*, components/cards.tsx*, lib/card-text.ts, app/globals.css
apps/web/test/             accountant-cards.test.ts*
docs/ + README.md          README*, design-notes, PLAN, setup-invoice, OPS, progress-m7*, handoff-m7-fixes*.md
```
(*) this worker. New migration: `ledger/004_undo`. No new dependency, no new environment variable.

## 7. Commit hints (the coordinator commits; the split of §8 above still holds)

- `codemode.ts` and `codemode.test.ts` go with commit 3 (extensions); `shared/src/accountant.ts` with commit 2; `cards.tsx` and `accountant-cards.tsx` with commit 6 (web);
  `ledger/004_undo` is part of the ledger module in commit 3.
- Suggested addition if the fixes are committed apart from M7: `extensions: bound code mode, harden CSV import and add undo for imports and recategorize`,
  `splits: refuse a settlement whose name is part of a friend's`, `invoices: add preview_invoice with a PREVIEW watermark`, `web: send the import confirmation
  through the thread, not the composer`, `docs: record the M7 review fixes`.
