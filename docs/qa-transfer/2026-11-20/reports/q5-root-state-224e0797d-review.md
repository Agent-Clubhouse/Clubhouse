# Independent QA: Q5 prepared sparse root state, source review

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `224e0797daf1b6e696b46ddd82bea5d79894ae4c`, tree `08fdfe831ea135d013b48e5b203885e8d2b01124`, which matches `origin/auto-reset-policy-design/q5-root-backend-state`. The base is `5bbabde2d`.
- **Package:** `370086a3e4737add482e816614fcdb836a24a998`, tree `8352bd2b40d4e10fedbb52a45aadbc25526a0a54`. All 14 manifest entries match.
- **Method:** source read plus hashing. I ran nothing.

## Evidence (hashing only)

All receipts are at exact `224e0797d`, with 23 source hashes equal before and after. I recomputed them against the head blobs, with 0 mismatches.

- **tests:** exit 0, **4 files and 50 tests**. This is the gate-admitted run I independently confirmed live, with `START` at 19:21:35Z and `END rc=0`.
- **types:** root `tsc --noEmit`, exit 0.
- **lint:** the eight TypeScript files, exit 0.

The earlier exit-75 runs stay NOT RUN.

## Scope (10 added paths; the 5 landed index files are unchanged from `5bb`)

- **Imported, unchanged, with a provenance bridge to research `cacbb88f4`:**
  - `intervals.ts` and its test, and `state.ts` and its test, are blob-equal to the versions in `0826` and `a3b6`;
  - `sparse-reader.test.ts` is blob-equal to the version I approved in `0826`.
- **`sparse-reader.ts`, one change from my approved `0826` version:** an **exact top-level header key set** and an **exact recipient key set** (`groupId`, `host`, `agentId`, `generation`). That closes my earlier recommendation.
- **New:** `sparse-state.ts` and its test, plus two design documents.

## `sparse-state.ts` source verdict: APPROVE as a prepared-only reducer

- **Owning its input:** `prepare` calls `structuredClone(input)` and copies the header **before the first await**. Page writes are copy-on-write orphans. The prior `PreparedNoticeState` object and its roots are never changed. A no-op returns `this`, and a change returns a **new** object. A failure halfway through leaves only unreferenced orphan pages.
- **Scan:**
  - exact keys, at most 50 posts, sorted;
  - a capped batch can't move the frontier past its last post;
  - duplicate sequences or IDs, or a post beyond `through`, are refused;
  - conflicts with existing pending or `postIds` are refused;
  - gaps are covered as terminal **intervals** (`excludedSequenceCount += gap`), and new posts become pending, ready and `postIds`;
  - the frontier advances to `through`, and a stale `through` is a no-op.
- **`cover`:** merges with an adjoining predecessor or successor interval, which keeps the interval set canonical, as the reader requires (no touching intervals). Accepted single positions merge too. Because pending posts are never terminal, there is no double counting.
- **Intent:**
  - exact keys, posts numbering 1 to 50 with unique sequences and IDs;
  - every post must be pending, unowned and in `ready` with the matching `postId`;
  - it sets `attemptId`, removes the post from `ready`, records an `intent` attempt with its digest and `handoffProcess`, and sets `active` to true;
  - the same attempt with the same digest is a no-op, and a different digest is a conflict.
- **Queued:** an `uncertain` attempt is a no-op. A `messageId` conflict is refused, and the same queued message is a no-op.
- **Settle:**
  - **`uncertain`** sets reason `handoff_unknown` and removes it from active. The posts **stay owned**, so nothing is replayed automatically.
  - **`unsubmitted` on an uncertain attempt** is refused ("Uncertainty cannot become proven unsubmitted").
  - **`accepted`** requires an exact `same-process-exact-handoff` proof whose `handoffProcess` and `coverageDigest` match, and is refused for a `recovered` attempt. A late ACK on `handoff_unknown` increments `lateAcknowledgementCount`.
  - Accepted posts leave pending and `postIds` and are **covered**, and `acceptedCount` increases by the number of posts. An unsubmitted settle returns the posts to ready.
  - Ownership is verified for every post, and the attempt and its active entry are deleted.
- **Recover:** the attempt IDs are listed explicitly, at most 50, without duplicates. Each one is marked `uncertain` with reason `recovered` and removed from active. Enumeration is paged through `listActive`.
- **Reads:** `listReady` and `listActive` are limited to 1 to 50 and verify ready references. There is no global snapshot and no automatic handoff.
- **`openPrepared`** delegates to the strict reader for full streaming verification.
- **Authority:** none. There's no committed revision, receipt, send, publication or genuine-ACK capability. The class documentation assigns binding, root barriers, append and sync, and publication to the future journal owner.

## Integration blockers (for the future journal consumer, P5; not defects in this prepared reducer)

1. **IB-1:** there's no expected-revision or recipient binding, and `prepare` isn't serialized. The single journal queue must serialize, bind the expected prior root and recipient generation, earn **every** authoritative root-page barrier (the reuse-plus-flush rules from the index), append and sync, and only then expose a result.
2. **IB-2, ACK-first fence (Q5's caveat):** the `accepted` settle and a concurrent loss claim must go through one queue with a synchronous settlement fence. Q5's own analysis says the `71bd` ACK path lacks that fence.
3. **IB-3, `postId` uniqueness scope:** conflicts are checked only against **pending** `postIds`. Accepted or excluded posts are removed from `postIds`, so a later scan presenting an already-accepted `postId` under a **new** sequence number passes. If the board guarantees one sequence number per post, that's fine. Q5 should state that assumption, or keep a bounded accepted-ID guard. Check that `state.ts` (the full reducer) behaves the same way.
4. **IB-4, the loss-claim and recovery protocol:** the journal-side recovery walk and loss-claim producer aren't implemented here.

## Verdict

- **APPROVE `224e0797d`** as a prepared-only incremental sparse-root reducer, with the stricter reader and the imported oracle and reader closure.
- **Exact-head execution evidence:** 50 tests, tsc 0 and lint 0, with no test repeat.
- The fixtures accurately reflect **257 seeded uncertain** attempts followed by incremental and cold verification. The million-sequence spans are exclusions plus one acceptance, **not a million deliveries.**
- **No credit for:** total heap, performance, catalog, R1, runtime, loss claim, ACK-first, publication or a PR. IB-1 to IB-4 apply to integration.
