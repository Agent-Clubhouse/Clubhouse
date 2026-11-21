# Independent QA: Q5 prepared sparse-root reader (read only)

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `a3b653e349bd89056a2b87ef5ba1308a7e43d0ef`, tree `b578b09ea69b00ec5fb01a1e90819f722551a521`. Its parent is `71bd4d632`, which is approved. It adds only `sparse-reader.ts`, its test, and a progress note.
- **Evidence:** `ce4257bfb86bca114fa071c8a920d50be09d2176`, which is in `q5-ledger-evidence`. The file is `prepared-reader-a3b653e34.md`.
- **Method:** source read plus hashing. I ran no tests.

## Evidence verification

- The manifest has **41 receipts**, and its diff against `00459beb6` removes nothing, so the earlier 38 are preserved.
- **3 new receipts.** For each, the raw and receipt sha256 values match, head and clean status are the same before and after, and the 24-hash maps are equal. I recomputed every hash against the head blobs, and all match.
  - Reader tests: 17 of 17 passed in 1 file. That is 1 cold-pagination test, 1 copy/floor test, 8 reference negatives, 6 coverage negatives and 1 schema, page and limit test.
  - Root tsc: exit 0.
  - Lint on 2 files: exit 0, with empty output.
- Credit is exactly those runs.

## Source verdict (`sparse-reader.ts`): APPROVE as read-only verification

### Terminal and pending coverage

- Terminal intervals and pending posts are merged in numeric order, through streaming 16-row batches.
- Every span must begin at the previous floor + 1, so the check rejects both gaps and overlaps. When an interval and a post share a sequence number, the interval is taken first, and the post then fails the overlap check.
- Terminal intervals must be canonical: two intervals that touch are rejected.
- The final floor must equal `scannedThrough`, and `acceptedCount + excludedSequenceCount` must equal the terminal count.
- Interval keys and values, and pending keys and `seq` values, must match, and keys must be canonical 16-digit strings.

### Integrity in both directions

- **pending ↔ `postIds`:** checked by `verifyPending` and by the `postIds` scan. Because `postIds` keys are unique, two pending rows with the same post ID cannot both pass.
- **Unowned pending ↔ `ready`:** `ready` must carry the matching `postId`, and every `ready` row must point to an unowned pending row with that `postId`.
- **Owned pending ↔ attempt posts:** the attempt must exist and list that sequence and post ID. Every post an attempt lists must be pending with that `attemptId`, which also bounds it within the scanned range.
- **attempts ↔ `active`:** a non-uncertain attempt must be `active === true`, an uncertain one must be absent, and every `active` row must point to a non-uncertain attempt.
- **Attempt rows:** key equals `attemptId`. The status and reason combination must be valid, posts number from 1 to 50 with unique sequences and IDs, and the coverage digest must match.

### Floor and bounds

- `legacyFloor` makes one `atOrBefore(baseline + 1)` call. Because intervals are canonical, the interval covering `baseline + 1`, if there is one, gives the maximal contiguous terminal prefix. Otherwise the floor is the baseline. That makes it truthful and bounded.
- `listReady` and `listAttempts` enforce a limit of 1 to 50 (`NOTICE_BATCH_LIMIT`). There are at most 50 point lookups per page, and paging is cursor-based within the root.
- `activeOnly` re-validates `active === true` and that the attempt isn't uncertain.

### Header

- The header is limited to 16 KiB with exact schema, writer and profile values. Recipient and frontier are validated, and only the six known root names are accepted. The header is cloned on input and output.
- The doc comment and progress note say the header is **unauthenticated, uncommitted input**, with no recipient, generation, nonce, grant or send authority.
- **Minor:** unknown top-level header fields are tolerated and cloned. They are bounded by the size cap, but an exact key set is recommended.

## Dependencies this verdict relies on, and exclusions

I read the parts of `pages.ts` (approved at its last change, `8142a812a`/`181046cde` in the foundation) that this reader relies on:

- **`load`:** every uncached read re-checks the content sha256 against the root digest, and checks the reference metadata (first, last, count, depth) against the claim.
- **`decode`:** byte bound, version, fanout, strictly increasing leaf keys, and `previous.last < child.first` across children. Together these give globally unique ordered keys.
- **`verify`:** recursive descendant count.
- **`get`, `list` and `atOrBefore`:** read through `load` and copy values.

Because the store is content-addressed, a page changed on disk after `verify` fails its digest on the next uncached load.

Also relied on, through their existing behaviour: `intervals.noticeSequence` (safe non-negative integer) and `state.noticeCoverageDigest` / `noticeRecipientKey`.

**Excluded** (not reviewed here):
- `pages.ts` `build`, `put` and `flush`, cache eviction and memory accounting. Fixed per-index caches are not proof of a combined transient, vector or whole-heap bound.
- The catalog, root activation, R1, writer GC, migration, runtime, UI and platform.

## Verdict

- **APPROVE `a3b653e34`** as a read-only reader that verifies prepared sparse roots: full coverage, integrity in both directions, a truthful floor and bounded paging.
- No authority of any kind.
- Optional: an exact header key set, and further negatives for an attempt-digest mismatch and a post ID duplicated across pending rows.
