# Independent QA re-review: M1-a page envelope budget

Reviewer: qa-details-local-composition. November 21, 2026.
Head: `3ca9a5c74c8c3971b889c69d5dfaa2421aa266af` (`origin/details-local-composition/3733-m1a-page-envelope-budget`, remote verified). It adds docs only on top of the source `e3dd5eb9303600943378b1c5786de0da5879c8e7`, one commit on the frozen M1 `9a368410d`.
Method: I read source and committed artifacts only and ran nothing.

## Verdict

**APPROVE M1 together with M1-a** (`9a368410d` plus `e3dd5eb93`). This resolves the changes I requested in `dd2423ddb`. It is not a full-suite claim, and hosted CI on the PR remains the gate.

## Source

- **The envelope** (`remote-details-presentation.ts:32`): `selectedConnectionPageEnvelope(result, maxBytes = REMOTE_DETAILS_MAX_BYTES)`.
  - The budget is `min(maxBytes, MAX)` when the input is a safe positive integer, and MAX otherwise.
  - **Both** the text-truncation loop and the final `details_page_limit` throw now use that budget.
  - An invalid input falls back to MAX, but the only budgeted caller has already validated it, and MAX is still the ceiling.
- **Callers:**
  - `readRemoteAgentDetails` passes `budget`, which is validated after authorization. That budget is MAX for ordinary reads and `MAX - overhead` for the role read.
  - `remote-quick-details.ts:146` still calls it with the default MAX, so **ordinary pages are unchanged**.
- **Generic trim loop** (:312): it now excludes the page-only requested Connections card. If nothing else is trimmable, `details_limit` gives 500, which fails closed. This guard is redundant once the envelope fits the budget, which is acceptable as defence in depth.
- **Unchanged:** auth, the receipt fences and the outer role guard.

## Evidence (`evidence/3733-m1a-page-envelope-budget/`)

- **Seals and head:** all 11 match. `validated-head` is `e3dd5eb93`. The pre-status is empty and the store is unchanged.
- **Green:** 9 files, **1319 passed**, exit 0, including all importers of the shared helper. tsc exits 0. Lint has 0 errors and 248 warnings.
- **Red** (the frozen `9a368410d` source with the new tests): 2 failed.
  - The view case got **89 of 90 rows**, so a requested row was dropped.
  - The envelope case found the notice text `''`, so the notice was missing.
- **New tests:**
  - **View window test:** the budget is the natural size minus 1000 bytes. It checks that all requested rows are kept, `omitted` is unchanged, the "field text" truncation notice is present, the body is within budget, and `isRemoteAgentDetails` passes.
  - **Envelope test:** the caller's budget is fitted by truncation, and the default stays the cap.
  - **Wrapped bound:** with the M1 tests (the role passes the budget, and the wrapper fits inside MAX), the role response stays within MAX.
- **Mutations:**
  - `mut-envelope-ignores-budget`: **2 failed**, exit 1, restored byte-identical with a clean status.
  - `mut-loop-pops-page-rows`: ineffective (10 passed), recorded as redundant with **no credit**.
