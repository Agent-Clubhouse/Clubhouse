# Independent QA: Q5 ledger foundation, source audit only

Reviewer: qa-details-local-composition. November 21, 2026.
Target: `36e66d2bc938a8dc93bc95725e95ffbcc4aa88f3`, tree `3d1d5537…` (`origin/auto-reset-policy-design/q5-durable-delivery-ledger`, remote verified).
- Unintegrated WIP: `src/main/services/group-project-notice-ledger/{intervals,state,journal}.ts` and their tests. No app import and no sends. Main `780` (#3757) is merged in.

Method: I read the source only and ran nothing. **The artifact and evidence check is deferred** until the owner's portable source and evidence ref arrives. This is not feature acceptance.

## Verdict

**The foundation is sound in its core semantics.** There are 4 findings:
- 1 decision on contract semantics (F1);
- 1 liveness-versus-safety decision (F2);
- 2 defensive or naming items (F3, F4).

The known gaps acknowledged by the owner are not counted as findings: sparse rows stay in memory, and there is no marker, post-ID mode, adoption, retry IPC, UI, runtime, wake or platform proof.

## Sound

- **Intervals** (`intervals.ts`):
  - The validator is canonical and strict: sorted, non-adjacent, `lo ≤ hi`, safe non-negative integers. It never repairs.
  - Coverage uses binary search.
  - `coverNoticeInterval` merges correctly, including adjacency and spans across several ranges.
  - `contiguousNoticeFloor` starts from the baseline and stops at the first gap. It is used only for the legacy floor export.
- **Reducer** (`state.ts`):
  - It is pure, with no app lookups, runtime, nonce or authority.
  - **Scan:** rejects conflicting seq or ID pairs and seqs past `through`. Unlisted seqs in `(scanned, through]` become terminal, so uncertain or pending seqs are never covered.
  - **Intent:** requires ready pending posts that have no attempt and aren't covered. A matching key and digest is idempotent, and a mismatching digest throws.
  - **Uncertain coverage:** stays pending with its `attemptId`, so it is **never merged into a fresh intent**, while later posts proceed.
  - **Settlement:** `unsubmitted` releases its posts back to ready. An uncertain attempt can't become unsubmitted. A stale callback for an unknown attempt is a no-op. `recover` turns `intent` and `queued` into `uncertain`.
- **Checkpoint validation:** the terminal range lies within `(baseline, scanned]`. Pending is disjoint from terminal. **The terminal plus pending floor must equal `scannedThrough`**, so there can be no unrecorded gap. Attempt coverage and digest must match, and the counts must add up.
- **Journal** (`journal.ts`):
  - **Per recipient:** a manifest bound to the recipient key, with the version gate (`minWriterVersion`). A missing manifest next to existing data is treated as corrupt, with no rebaseline.
  - **Records:** length-prefixed and SHA256-framed, with a revision plus previous-digest chain. Each record is appended, file-synced and directory-synced **before** state publication. Any failure poisons the journal, with no cache publication, and needs a reload.
  - **External change detection:** the manifest hash and the current segment's length and hash are checked before every write.
  - **Open:** `recover` runs on open.
  - **Segments:** 256 KiB target. At most 4 uncheckpointed segments, after which a checkpoint runs inside the append path. Frames are at most 64 KiB, so a segment stays at or under about 320 KiB, within the 512 KiB cap.
  - **Checkpoint:** content-addressed immutable pages (≤512 KiB, temp file, sync, rename) and paged index nodes (1000 per level, depth at most 32, cycle-checked). The directory is synced before the manifest is replaced atomically. GC runs only after the manifest commits. Leftover old segments are ignored on load, and orphan pages are inert.
  - **Preserved:** unknown optional manifest fields, and incomplete-tail diagnostic copies, which GC doesn't match.

## Findings

**F1 (contract semantics): a late `accepted` can turn `uncertain` into accepted.**
- In `settle`, `accepted` is applied even when `attempt.status === 'uncertain'` (state.ts:137-148). The contract says conflicting late outcomes are "retained as a visible anomaly, never overwrite", and that uncertain coverage is not converted to success.
- Within one process, a real late ACK for the exact attempt may legitimately confirm it. The contract should decide that explicitly, along the lines of "a same-process exact-attempt ACK after `handoff_unknown` may confirm, and records an anomaly flag".
- A `recovered` attempt, uncertain after a restart, should **never** accept, because no legitimate callback can target it.
- Add a test for both cases.

**F2 (liveness against safety): torn tails are classified as corruption.**
- Tail recovery covers only a frame **shorter** than its length header (journal.ts:155-160).
- A crash before fsync can instead leave a **zero-filled extension**, which reads as length 0 and fails "Invalid notice frame length", or a full-length frame with garbage that fails the checksum. Both refuse the shard. The test at :102 asserts this behaviour deliberately.
- Failing closed avoids duplicates, because dropping a frame that was really committed could release handed-off posts. But a fairly ordinary crash then **stops that recipient** until manual reconciliation.
- Consider a conservative middle path for an invalid **final** frame of the **last** segment with nothing valid after it: preserve and trim it, and **mark every pending post that has no attempt as uncertain** under a synthetic recovered attempt. That causes no duplicates and keeps later posts flowing. Complete damage elsewhere stays fatal.
- Decide this explicitly in the contract, and add zero-fill and full-length-garbage tail controls.

**F3 (naming and truthfulness): `excludedCount` includes non-post sequence numbers.**
- Scan treats every unlisted seq as excluded, `excludedCount += gap` (:90-99). Board sequences also advance for non-post changes, and the contract says gaps are not posts.
- Rename it, for example to `terminalNonAcceptedSequences`, or document that it counts sequence numbers, not posts. It's aggregate only, so no per-post claim results.

**F4 (defensive): a scan can over-advance past unlisted eligible posts.**
- With the 50-post limit, a caller that truncates `eligible` but passes a far `through` would silently mark the omitted eligible posts as excluded.
- Have the reducer require that either `eligible.length < NOTICE_BATCH_LIMIT` or `through === max(eligible.seq)`. That makes the split-burst rule enforceable rather than trusted to the caller.

## Observations

- `unchanged()` plus the post-append `readCurrent()` mean two full reads and hashes of the current segment (≤ about 320 KiB) per commit. That's bounded, but include it in the product latency measurement.
- The "hole spill" today is page partitioning (256 attempts per page). The contract's hot-detail budget and archive addressing are not implemented, which is a known gap.
- `boundedId` permits DEL (0x7f). That's harmless here, but align it with the other identity validators.

## Pending

Artifact verification against the owner's portable proof (36 tests in 3 files, root tsc 0, scoped lint 0), bound to the exact head. That waits for the ref.
