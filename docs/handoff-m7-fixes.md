# Handoff: M7 review fixes
Fresh worker. Repo `/home/kzoeps/Projects/personal/assistant`, `main`, M7 uncommitted (coordinator commits).
Read: `docs/handoff-m7.md` (scope; constraints from `docs/handoff-m2.md`), `docs/handoff-m7-2.md`, `docs/progress-m7.md`, `docs/review-m7.md`
(scratch in `/tmp/m7-review-scratch/`).

## Coordinator adjudication
- Fix S1–S7 and T1 per the review. Specifics:
  - S1: enforce a default code-mode timeout (e.g. 30 s) and a max; a restarted script past its deadline ends with an error.
  - S2: replace the regex with a linear parser; add a pathological-input test with a time bound.
  - S4: imports are undoable as a unit: `propose_undo_import(import_id)` (approval) removes that import's rows.
  - S5: on import, flag probable duplicates of existing chat/receipt entries (same account, amount, date ±2 days) in the preview;
    default skip those rows, user can include.
  - S6: settlements/splits with a name that only partially matches a known person must NOT create a new person/debt; return an
    ambiguity result asking which person (overrides veto #3 for settlements; for new bills flagging is fine).
  - S7: recategorize by merchant: exact (case-insensitive) match by default, preview count + sample, require confirm for > 20 rows, store
    previous categories so `undo_recategorize(batch_id)` works.
- Invoice preview: `preview_invoice` renders the PDF watermarked "PREVIEW" without taking a number (file under workspace/invoices/previews/).
- Veto points progress-m7 §5: all ACCEPTED except as modified by S6 above.
- Nits N1–N14, U-items: fix where < ~15 min; else defer with reason. Cover the unreviewed bits yourself lightly: 390 px browser check of the
  accountant cards + bundle smoke (screenshots `/tmp/assistant-shots/m7/`).
- Delete `/tmp/m7-review-scratch/` at the end.
## Done when
Gates green; report (item → fixed/deferred + test); servers stopped; reply DONE-FIXES. ~55% → handoff-m7-fixes-2.md, DONE-HANDOFF.
