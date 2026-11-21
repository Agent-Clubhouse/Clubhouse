# Independent QA: Q5 entry arbitration mutation evidence

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `71bd4d632` (tree `95d0c8e07`), unchanged.
- **Fixture:** `47cf671ef5d4a7442a21fdf8b9b8a5c272eced6e`, which is in `origin/auto-reset-policy-design/q5-entry-mutation-controls`. It adds only `test/research/q5-entry-arbitration-mutation.cjs` over `71bd`, with sha256 `893441bb…706e`.
- **Evidence:** `00459beb67108470cca146375a4f9a8f23c0a007`, which is in `q5-ledger-evidence`. The file is `entry-mutations-71bd4d632.md`.
- **Method:** source read plus hashing. I executed nothing.

## Verification

- The manifest has **38 receipts**. The diff against `552259824` removes nothing, so the earlier 36 are preserved.
- Both new receipts have matching raw and receipt sha256 values. Head `71bd4d632` and a clean status are the same before and after, and the 22-hash source maps are equal.
- **The fixture ran from outside the repository.** The two copies the evidence retains are:
  - `corrected-q5-entry-arbitration-mutation.cjs`, sha256 `893441bb…`. It is byte-equal to the committed fixture at `47cf671ef`;
  - `a645c67e8-…cjs`, sha256 `2c72d477…`. It is byte-equal to `a645c67e8`'s fixture.
- I recomputed `originalJournalSha256` `e0be8358…` and it equals the `71bd` `journal.ts` blob.
- **Attempt 1** (the `a645c67e8` fixture), exit 1:
  - guarded run 0;
  - the queued-only-hold run threw `Mutation target missing or ambiguous`, exit 1, so it produced no proof;
  - the remove-check run 2.

  This is retained honestly as a fixture-targeting failure. My reading is that the first fixture's target string was also matched by the checkpoint callback.
- **Attempt 2** (the corrected fixture), runner exit 0:
  - **guarded:** exit 0. The compiled sha equals the original, so there is no mutation. All three PASS.
  - **queued-only-hold:** exit 2. Duplicate PASS, then **"FAILED: uncertain admitted immediate entry"** and **"FAILED: recover admitted immediate entry"**.
  - **remove-attempt-entry-check:** exit 2. **"FAILED: duplicate handle entered"**, while uncertain and recover PASS.
  - Each mutant's compiled sha differs. Fixture and source sha are identical before and after (`unchanged: true`), and the source on disk was never written.

## Semantic discriminator: valid

- **queued-only-hold** deletes the two synchronous increments in `append()`. It re-adds equivalent increments as the **first statements of the queued callback** in `enqueue`, keeping the existing `.finally` decrement, so the counters stay balanced.
  - The probe calls `markHandoffEntered` with **no await** after `append()` returns, before the queued callback can run.
  - The mutant admits entry; the real code refuses it.
  - So the difference is exactly *request-time versus queue-time* placement. This is the property the baseline `beforeAppend` test couldn't distinguish.
- **remove-attempt-entry-check** deletes exactly one ` || this.enteredAttempts.has(proof.attemptId)`. `replaceOnce` enforces that the target is unique, and it is the `markHandoffEntered` check; capture uses `attemptId`.
  - A second handle captured before entry then enters, so that check is necessary on its own.
- **Runner:** it requires the exact exit codes **and** the specific failure messages, so a mutant that failed for an unrelated reason would not count.
- **In-memory only:** `transpileModule` runs through a `require.extensions` hook. It doesn't import the app or drivers, and its temp directories are removed.

## Verdict

**The proof gap is CLOSED** for (a) synchronous placement of the settle and recovery hold, and (b) the attempt-wide entered-set check in `markHandoffEntered`. Both are proven by executed, discriminating, in-memory mutants at the unchanged `71bd4d632`, with the source on disk byte-unchanged.

This covers the journal only: no runtime, interface, lifecycle or phone proof. The other Q5 gates remain open.
