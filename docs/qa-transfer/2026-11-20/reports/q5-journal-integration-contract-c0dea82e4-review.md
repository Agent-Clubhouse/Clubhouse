# Independent QA: Q5 journal integration contract and source identity (docs only)

Reviewer: qa-details-local-composition, November 21, 2026.

- **Target:** `c0dea82e4965fcc664b33f880d19194e1e39adf5`, tree `07dde240a107eaea59aff01b368f2e1b054b390c`, which matches `origin/auto-reset-policy-design/q5-journal-integration-contract`. Its parent is `224e0797d`, which is unchanged.
- **Change:** docs only, adding `q5-journal-integration-contract.md` and `-source.json`.
- **Method:** read only. I spot-checked producer source on `5bbabde2d`:
  - `group-project-host.ts:168–173` has `APPLIED_MAX = 2000`, a 7-day TTL and a 24-hour outbox expiry;
  - `:1052–1079` reuses the earlier post only when `getMessageById` finds it on the current board, and otherwise calls `reserve()` for a new sequence;
  - `group-project-bulletin.ts:750+` has `ensureProjectChannels(projectId, seq?)`, where bootstrap passes one shared `seq`.

## Verdict

- **APPROVE as the ownership and ordering contract for private journal work.**
- **IB3 is correctly OPEN**, and production binding is correctly blocked.
- There is one concrete contradiction with the approved `224e` reducer that must be resolved before any scan adapter exists (C-1).
- There is one user-owned decision (D-1).
- I **recommend** a separately deduplicated issue for the producer defect (F-1).

## IB1, IB2 and IB4: consistent and sound

- **IB1:**
  - one owner and one serialized queue for each physical file set, with no second publishing path;
  - an exact committed expectation of installation, profile, full recipient, revision, prior digest and prior root digest, rechecked after preparation;
  - **every newly referenced page** earns file and directory barriers before the append, while existing ancestry gets credit only with authenticated provenance;
  - one bounded framed append plus sync before **any** exposure, with ambiguous IO poisoning the owner;
  - the single-writer premise stated explicitly.

  This matches my `224e` IB-1. **Dependency:** the "sealed barrier result" bound to the header digest, index epoch and protected reference set is a **new API on the landed `pages.ts`** (#3768). It needs its own source review, and must not be emulated with `flush()` versions.
- **IB2:**
  - every contender (ACK, loss, settle, recover, retire) takes one synchronous ownership registry before any await;
  - the frozen `8a0` hooks are restated exactly;
  - ACK first means a later loss declines, and an ACK IO failure is a visible reconciliation, not a loss fallback;
  - loss first means a later genuine ACK may settle only `handoff_unknown`, never `recovered`;
  - an existing intent with `RuntimePreIntentRefusal` is reconciled by Q5's own claim.

  This matches `b05c927a1`, the Q5 caveat and my P1 note.
- **IB4:** on open, the full committed active-index walk runs in batches of at most 50 through the same queue, and no send or capability issues until it completes. It's idempotent, with no recovered ACK, TTL deletion or refund.
- **The batch plan is coherent.** It keeps the new root profile unreachable from production delivery until IB3 and the caller gates close.

## C-1 (concrete contradiction, required before a scan adapter): several posts can share one sequence

- The contract's own source finding is that channel and inbox bootstrap can create **several posts under one group change sequence**.
- The approved `224e` `PreparedNoticeState` keys `pending` and `ready` by `noticeSequenceKey(seq)`, and **refuses a scan with duplicate sequences** ("Conflicting notice scan"). The reader likewise binds one pending post per sequence.
- So if more than one bootstrap post sharing a sequence is ever delivery-eligible, the scan adapter can't represent it. The only possible results are a refused scan, which **blocks progress**, or a silently dropped post.
- **Required**, as the contract itself demands, "prove scan eligibility excludes any legitimate multiple-post…": either
  - (a) prove from source that bootstrap and system posts are never notice-eligible, and filter them before the reducer with a test, or
  - (b) change the coverage key to `(seq, postId)` in a reviewed successor to the reducer and reader, with the interval semantics revisited.

  Don't let the scan adapter discover this at runtime.

## D-1 (user-owned decision): how IB3 is closed

- **Option 1** (exact pair only) **weakens the accepted v2 promise** that confirmed or uncertain IDs are skipped. The contract correctly says that needs **explicit user approval**.
- **Option 4** (sender incarnation plus monotonic ordinal plus a refusal floor) is an **Annex network producer and protocol change**. It has mixed-version, legacy and false-refusal consequences.
- Choosing between them is a product and scope decision. The orchestrator should put it to the user as one batched question, rather than have QA or Q5 pick.
- Options 2 and 3 are correctly rejected as closures. A bounded cache is diagnostic only, and all-history tombstones contradict sequenced storage.

## F-1 (recommend filing): the producer defect exists independently of Q5

- The source-derived sequence is: applied result evicted by count (2,000), original board post trimmed or deleted, then an outbox retry with the same deterministic ID, which gets a new sequence.
- That's a **board-level** defect even with no notices involved. A **deleted or trimmed post can reappear** through a retry, which is user-visible.
- The bounded `gh` searches recorded in the JSON found no exact duplicate. #3334 (agent calls) and #3363 (feature, closed) are different.
- **Recommend:** one LOW or MEDIUM issue, under the proposed title or a sharper one ("Network group posts: a deleted/trimmed post can be recreated at a new sequence by an outbox retry after applied-result eviction").
  - Label it source-derived and not reproduced.
  - Relate it to #3363 and #3758.
  - Require a bounded replay or old-operation contract with crash and mixed-version controls.
  - Make no producer edits under Q5.
- Filing is the orchestrator's call under the existing investigate-and-file practice. I haven't filed anything.

## Not authorized

No producer, protocol, access, runtime or code changes. Physical backend planning stays independent, and no test credit applies.
