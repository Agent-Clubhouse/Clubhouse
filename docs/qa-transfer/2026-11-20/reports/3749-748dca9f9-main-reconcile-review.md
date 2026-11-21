# Independent QA: PR #3749 main reconciliation

Reviewer: qa-details-local-composition. November 21, 2026.
Head: `748dca9f9a2fdcd233e49326ee6cb68ad0975fed` (`origin/details-local-composition/3733-main-reconcile`, remote verified). It adds docs only on top of the validated merge `ed13e30604dedc24733af0a42daceea2b058316c`, whose parents are the approved `81cd9b4ef` and current main `6130b2966` (`origin/main` matches).
Method: I read source and artifacts only and ran nothing.

## Verdict

**APPROVE.** This clears the ordinary #3749 update to `748dca9f9`. Hosted CI on the updated PR remains the gate, including Windows proof for the `b9be7` fixtures and observing the unexplained restart.test dynamic-import timeout.

## Merge correctness

- **Compared with an automatic `merge-tree`,** the recorded merge changes only the two predicted conflict files.
- **`agent-config.ts`:** the merge deletes 0 lines relative to either parent, so it is a pure union of #3733's display-cache tokens and #3750's `readDurableRegistrationLease`.
- **`annex-client.test.ts`:**
  - The only lines that differ from either parent are each side's own existing edits: 6130's widened sockets type, and the stack's parametrised disconnect test and role-transport block.
  - The merge adds a new composition control: "power-resume revalidation withdraws the receipt and fences an in-flight agent/canvas/role read until the new socket attests".
- **`annex-client.ts`** is identical to the automatic merge. It has **5** `connectionAttempt` references (#3748), the clock-only wake retry, and **2** `invalidateSnapshotAdmission(sat, receipt)` calls (#3733 O1). Both fences are retained.

## Control

For each of the agent, canvas and role reads, the control checks that resume withdraws the receipt, both in the store and in the public broadcast:
- a late snapshot frame from the old socket cannot re-attest;
- the in-flight read resolves `offline`;
- the new socket's snapshot mints a fresh receipt at a higher generation.

## Evidence (`evidence/3733-main-reconcile-6130/`)

- **Seals and head:** all 14 seals match. `validated-head.txt` is `ed13e3060`. Pre- and post-status are empty, and the tip is docs-only against `ed13e3060`.
- **Full suite with a fresh default-depth TMPDIR** (entries-before is 0): 1464 files passed and 13 skipped. **35591 passed, 114 skipped, 0 failed.** `vitest exit=0`.
- **Lint and typecheck:** lint has 0 errors and 793 warnings, exit 0. tsc exits 0.
- **Effective mutation:** resume revalidates only already-disconnected satellites, the pre-#3748 behaviour. **All 3 controls fail** with exit 1, and the source is restored byte-identical with a clean post-status.
- **Ineffective mutation:** removing only the setState clear leaves the controls passing (3 passed, 284 skipped), because disconnect also withdraws. It is kept with no credit, as stated.
- **README correction:** the hand-typed merge SHA was corrected in `748dca9f9`, with a note.
