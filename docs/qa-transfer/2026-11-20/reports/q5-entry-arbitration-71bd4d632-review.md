# Independent QA: Q5 journal entry arbitration

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `71bd4d632e58161400d086fa2305ce45580cad60`, tree `95d0c8e07d3ca08d7b0626942b9a498118dd0d28`. The test-only baseline is `b8bd6c0e3`, whose parent is `6d208ecb2`.
- **Evidence:** `552259824f4436459f01661973670fdddacfb4b0`, contained in `origin/auto-reset-policy-design/q5-ledger-evidence`. The file is `docs/evidence/q5-foundation/entry-arbitration-71bd4d632.md`.
- **Method:** source read plus hashing. I ran no tests.

## Evidence verification

- The manifest has **36 receipts**. Its diff against `472a625d4` removes nothing, so the earlier 32 are preserved.
- **4 new receipts.** For each, the raw and receipt sha256 values match, the argv is exact, head and clean status are the same before and after, and the 22-hash maps are equal. I recomputed all hashes against each head's blobs, and every one matches.
  - **Baseline `b8bd6c0e3`** (`-t 'entry arbitration:'`): exit 1, 2 failed and 19 skipped. The two real assertion failures are:
    - "two handles cannot enter the same attempt twice": expected a throw;
    - "pending unsubmitted commit…": entered true **and** coverage released.

    These are genuine synthetic race reproductions at the journal level. They are not provider or runtime incidents.
  - **`71bd4d632`:** journal tests 24 of 24 passed. Root tsc exit 0. Lint on 2 files exit 0, with empty raw output.
- Credit is exactly those runs.

## Source review (`journal.ts`)

- **Duplicate handle across the whole attempt: CORRECT.**
  - `captureLiveHandoff` refuses once the attempt is in `enteredAttempts`.
  - `markHandoffEntered` refuses if the attempt is already entered, so a second handle captured earlier cannot enter.
  - `acknowledgeLiveHandoff` still requires `proof.entered`, so a losing handle can't acknowledge.
  - `enteredAttempts` is cleared only on an accepted settle (`:290`), after which the attempt leaves state.
- **Synchronous holds: CORRECT.**
  - `append()` increments `settlingAttempts[attemptId]` (for settle) or `pendingRecoveries` (for recover) **synchronously, before `enqueue`**. Any entry or capture after the call returns is refused until the queued delta settles.
  - It decrements in `.finally`, using counters, so overlapping settles are safe.
  - If the queued delta is rejected without effect, the hold lifts and the state is unchanged. If it is poisoned, `poisoned` refuses entry. If IO hangs, the hold stays and fails closed.
  - Accepted settles go through `acknowledgeLiveHandoff` and the enqueue path with a live proof. They don't take a hold.
- **Genuine already-entered late ACK: CORRECT.**
  - An entered handle followed by a queued uncertain settle plus an ACK resolves to `acceptedCount 1` and `lateAcknowledgementCount 1`, and stays terminal after reopen.
  - The ACK path is not blocked by holds, because entry was already proven.
- **Liveness for unrelated attempts: CORRECT.** Settle holds are per attempt, and the test enters attempt-2 while attempt-1 settles. Recovery holds all entry, which is intended.
- **Earlier G1 and reopen behaviour is preserved.**
  - `:262` still converts a later unsubmitted settle on an entered attempt to uncertain.
  - The existing G1 guarded-versus-mutant child controls are retained.
  - Holds are in memory per instance, so a reopen starts fresh, and persisted state drives refusal after it.

## Gap: the synchronous placement has no executed mutant (recommended before relying on the claim)

- The "holds entry synchronously before queued IO" tests (uncertain and recover) were added at `71bd`. They weren't in the baseline, so they have **no executed red**.
- My source reasoning: a mutant that takes the hold only when the queued callback starts would admit entry immediately after `append()` returns. These tests would then fail. The baseline "pending unsubmitted" test, which awaits `beforeAppend`, would **not** catch that mutant.
- **Recommend:** an executed mutant that moves the hold increment into the queued callback, which must fail the synchronous tests, plus a mutant that removes the `enteredAttempts` check in `markHandoffEntered`. The evidence document honestly says no new mutation mechanism is claimed.

## Verdict

- **APPROVE `71bd4d632` source** for journal-local entry arbitration.
- The race fixes are reproduced red at the baseline and green at the exact head.
- The synchronous-placement property is verified in source and asserted by tests, but not yet proven by mutation. I recommend the executed mutant above before the property is cited as proven.
- No runtime, interface, lifecycle or phone proof. This is not the shared runtime-generation coordinator.
- Lazy roots, R1, migration, UI and platform remain open.
