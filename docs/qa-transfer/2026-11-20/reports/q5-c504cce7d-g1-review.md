# Independent QA: Q5 foundation G1 correction

Reviewer: qa-details-local-composition. November 21, 2026.
- **Source:** `c504cce7db87c5e71e73b60cfc9efb898f7be9ad`, tree `88d80f04…`. One commit on `0d0fd511f`.
- **Evidence:** `e945f97f5c522581ee22ced5033ad9cd8f19512c` (`origin/auto-reset-policy-design/q5-ledger-evidence`, remote verified).

Method: I read source and artifacts only and ran nothing. Foundation only.

## Verdict

**G1 RESOLVED. APPROVE the foundation at `c504cce7d`, with findings F1–F4 and G1 all closed.** This approval does not cover runtime entry integration, the lazy index, the phone generation, the marker, post-ID mode, the UI, the platform or product latency.

## Source

- **Entered set:** `journal.ts` adds `enteredAttempts: Set<attemptId>`, filled by `markHandoffEntered`. It **survives `releaseLiveHandoff`**, so dropping the handle can't erase the fact that entry happened.
- **Coercion:** in `enqueue`, a `settle unsubmitted` for an entered attempt is coerced to `uncertain` before the reducer runs. The reducer records the reason `handoff_unknown`, and **the coerced `uncertain` delta is what gets journaled**, so replay yields uncertain.
- **After restart:** the set is not persisted, and doesn't need to be. On reopen, `recover` makes every intent and queued attempt uncertain, so an entered attempt can't come back as ready across processes.
- **Minor:** entries are never removed from the set on terminal settlement. That's a small amount of in-memory growth per attempt in a long-lived process; consider removing an entry once the attempt is settled, accepted or uncertain.

## Evidence (`docs/evidence/q5-foundation/`)

- The evidence commit differs from `c504cce7d` only under the evidence directory.
- The manifest has 13 receipts. The earlier 9 still verify, and there are 4 new ones.
- The new `c504cce7d-{tests,types,lint,mutation}` receipts: each receipt and raw-output SHA256 matches the manifest. The head is `c504cce7d` before and after, status is clean, `sealEqual` is true, and **all 15 source SHA256s equal the blobs at `c504cce7d`**.
- **Results:** tests **42 passed** across 3 files, exit 0. Types exit 0. Lint exit 0.
- **Mutation** (`test/research/q5-entered-mutation.cjs`): this is an in-memory, single-guard substitution, and the source is never written.
  - The `guarded` child exits 0: "Entered coverage remained uncertain; no resubmission permitted".
  - The `remove-entered-guard` child exits **2**: "SAFETY ASSERTION FAILED: entered coverage became ready".
  - The runner exits 0 because the failure is expected.
  - The control is: capture, enter, release, then unsubmitted. It checks that the posts are not ready and the attempt is uncertain.
