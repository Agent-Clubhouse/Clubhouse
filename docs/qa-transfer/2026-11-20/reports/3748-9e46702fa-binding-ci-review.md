# Independent QA: #3748 binding-count CI correction

Reviewer: qa-details-local-composition. November 21, 2026.
Head: `9e46702fa1c9d9d9f3203c6282a637fcf61efe42` (`origin/annex-wake-readiness/3748-binding-ci`, remote verified). It adds docs and evidence only on top of the test source `554cfab37dfd48575b4db819233171377d10e365`, which is a single test-only commit on the approved `ade92c009`.
Method: I read source and artifacts only and ran nothing.

## Verdict

**APPROVE.** This approval does not cover hosted CI on the updated PR.

## Source

- The only changed file is `AgentGrantsSettings.test.tsx`, in the "updates the connection count when the live bindings change (#3275)" case:
  - `render` + `findByTestId` becomes `await act(async () => render(...))` + `getByTestId`;
  - the store update and both count assertions are unchanged.
- `git diff ade92c009 554cfab37 -- src` excluding tests is empty. I checked this myself, and the owner's product-equality check over `src`, `scripts`, the lock and the vitest config also shows no change.
- **Causal chain**, from the mount-flush probe in the red and green logs:
  - The summary is mounted by the grants Promise (`AgentGrantsSettings.tsx:99`), outside `act`. Its store-subscription effect has not yet been flushed when the synchronous `act(setState)` runs.
  - Before the drain, the store holds 1 binding while the attached summary still reads "0 outgoing connections." Draining with `act` shows 1.
  - The current-head JUnit failure reproduces the same symptom at :90 (expected 1, received 0). The same case passes on main 69ef (`junit-case-excerpts.txt`).
- **Why the fix is sound:** awaiting `act` around `render` drains the Promise-driven mount and its effects before the assertion. `getByTestId` throws if the summary is missing, so the test cannot pass silently. The real app runs effects promptly, and the store subscription re-reads on subscribe, so there is no product defect. The evidence does not claim the hosted job took the same timing path.
- `beforeEach` resets `useMcpBindingStore` to empty, so there is no state leak between tests.

## Evidence

- **Seals:** all 19 `SHA256SUMS.txt` entries match their committed blobs (11 top-level, 8 under `validation/`).
- **`validation/manifest.json`:**
  - `validatedHead` and `endingHead` are both `554cfab37`, with `trackedContentUnchanged` true;
  - `sourceTree` `272f4581` equals `554cfab37:src`, and the lockfile matches;
  - every result exits 0.

| Check | Result |
| --- | --- |
| Renderer tests (AgentGrantsSettings, AgentHelpersSettings, mcpBindingStore) | 3 files, **39 passed** |
| Typecheck | empty output, exit 0 |
| Lint of the test file | empty output, exit 0 |
| `diff --check` | empty output, exit 0 |
| Product equality | empty output, exit 0 |

- **Probe:** red (`mount-flush-red`) fails 1 with exit 1. Green passes 1. Both patches are retained.
- **Hosted context:** the ade92 hosted run, the current and main unit ZIPs, and the job log are retained.

## Notes

- `validation/manifest.json` contains absolute host paths (node and workspace). This is a hygiene item for public copies.
