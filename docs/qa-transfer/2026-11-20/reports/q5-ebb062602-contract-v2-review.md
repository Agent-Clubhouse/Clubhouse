# Independent QA re-review: Q5 durable notice ledger contract, revision 2

Reviewer: qa-details-local-composition. November 21, 2026.
- **Target:** `ebb0626026c02c4e04f4c17c770d4369a7da4527`, tree `b531ddb5…dc158` (`origin/auto-reset-policy-design/q5-durable-delivery-ledger`, remote verified).
- **Contract:** `docs/design/q5-durable-notice-ledger.md`, SHA256 `d9fcd3fa…84fcac`. It matches, and it is identical at the evidence source `f94421c47`.
- **Canonical issue:** #3758.

Method: I read the contract and the committed research receipts only and ran nothing. Docs are not credited as implementation.

## Verdict

**APPROVE revision 2: C1–C3 are resolved and all seven implementation controls are adopted.**
- **One required clarification (R1)** must be added before the post-ID baseline and adoption paths are implemented. It does not block starting the sequenced path.
- No exactly-once, provider, power-loss or SLA claims.

## C1: liveness and bounded IO, resolved

- **Interval coverage:** terminal coverage (accepted or excluded) is stored as merged closed seq intervals, even above holes. Exact `(seq, postId)` is kept only for sparse ready, active or uncertain rows. One hole plus 1M later posts is a hole plus one interval, so storage is O(holes + active attempts).
- **No count-cap pause:** the hot detail budget of 256 per recipient **spills older uncertain detail into immutable paged archive** with exact IDs, outcomes and retry links. New posts keep dispatching under ordinary limits, with no TTL, eviction or auto-retry.
- **Disk exhaustion** is honestly an operational failure, distinct from an imposed stop.
- **Bounded IO:** shards per recipient generation; journal segments of 256 KiB target and 512 KiB maximum; deltas of at most 64 KiB; checkpoint and index pages of at most 512 KiB; batches of at most 50 IDs. At most 4 uncheckpointed segments, with incremental compaction that may delay a commit but never requires resolving holes. There is no shared 16 MiB rewrite.
- **Durability:**
  - Records are length-delimited with a previous-record digest and a payload SHA256, and one record holds one logical transaction.
  - Each record is appended and file-synced before being published or handed off.
  - An incomplete tail is preserved and ignored, which authorized no handoff. Non-tail damage refuses only that shard, and healthy shards continue.
  - A checkpoint writes immutable hashed pages, syncs them and their directory, then atomically replaces the manifest. Orphan pages are inert.
- **Legacy cursor export:** sequenced mode only. It advances to the contiguous accepted-or-excluded floor, after the ledger commit, and is never authoritative. This adopts my suggestion and bounds accidental downgrade replay.

## C2: identity adoption, resolved

- A visible reason and count. No automatic adoption on reconnect, re-pair, rename or restart, and no pairing or trust change.
- **Prepare:** main mints and persists a one-use nonce valid for 5 minutes, bound to the installation UUID, recipient and old generation, expected root revision, exact new host and coverage mode, and the proposed baseline. The renderer cannot nominate a fingerprint, generation or baseline.
- **Commit:** a second main read must still match, or the request is refused.
- **One journal transaction** consumes the nonce, retires the old generation with its unresolved attempts intact, creates a fresh generation and baseline, and cancels held old work.
- **Fence:** runtime entry is fenced by generation, and late old receipts stay historical.
- **Cancel and repeat:** cancelling or closing writes nothing. A lost reply or double click reads the persisted result. No agent, phone, Go or timer route.

## C3: older boards, resolved

- `post-id-v1` mode is visible ("Older board: tracked by post ID…"), with no indefinite silent deferral.
- **First baseline:** a snapshot of current board IDs taken as exclusions. Activation is serialized against queued events.
- **Index:** content-free, hash-partitioned pages of at most 256 KiB. Full ID equality decides coverage, so a hash collision cannot drop a post. Tombstones are kept for deleted content.
- **Ordering:** never inferred from timestamps, ID text or arrival order.
- **Mode changes:** mixed boards use post-ID mode for the generation. A host upgrade does not auto-switch; explicit adoption is needed.
- **No stable ID:** a missing stable ID gives a visible "Board identity unavailable", and other recipients continue.
- The storage cost of O(distinct IDs) is stated honestly.

## Prior controls, all adopted

1. **Retry and adoption IPC trust:** the registered main window WebContents, a live BrowserWindow, `senderFrame === mainFrame`, and the exact app-entry URL. Popouts, children, navigated windows, plugin webviews and subframes, and remote, phone, Go and MCP callers are rejected. This is rechecked on preview, commit and lookup. The nonce is minted by main and never accepted from the renderer.
2. **Legacy floor export:** above.
3. **Synchronous pre-entry hook:** no await between the hook and `session.send`, no IO, no Promise return accepted, cached revisions only (stale cache refuses), and references cleared on every terminal outcome including unknown.
4. **Wake prechecks:** budget, last-session, permission and membership are checked before intent, so a refusal makes zero intents. A race refusal before entry is unsubmitted, and there is no refund on uncertain.
5. **Exclusions:** stay scan-time and are never revived by a later subscription change.
6. **IO envelope:** measured (`f94421c47` receipts, sealed before and after, identical, synthetic only):
   - 64 KiB append plus sync: median 4.190 ms, p95 4.640 ms;
   - 256 KiB checkpoint: median 9.731 ms;
   - 512 KiB checkpoint: median 10.444 ms.

   This is correctly labelled as not product, crash, compaction, power-loss or SLA proof. Product-bound measurement remains required after implementation.
7. **Mixed-version control:** present in the proof table.

## R1: required clarification, atomicity of a large baseline under the 64 KiB delta bound

- The contract says one record holds a complete logical transaction ("adoption plus new baseline"), deltas are at most 64 KiB, and post-ID baseline IDs live in index pages.
- A post-ID **initial baseline or adoption baseline** for a large board (thousands of IDs) cannot fit in one 64 KiB delta.
- **State the mechanism explicitly:** write the baseline index pages first as immutable, hashed and synced orphans, then commit **one small record** that references their page digests (and the new index root), together with nonce consumption and generation creation. Pages are not authoritative until that record commits, and a crash before it leaves inert orphans with no baseline change.
- **Add a control:** a baseline larger than 64 KiB, crashed between the page writes and the record, then crashed after the record. Confirm no partial baseline and no replay.
- The sequenced path (whose baseline is a single seq) is unaffected and can proceed.

## Observations

- Post-ID mode stores message IDs (`msg_<timestamp>_<random>`), which reveal posting times in local userData. That is content-free and acceptable, but note it in the privacy section.
- Post-ID index growth is unbounded for long-lived older-host groups. Consider showing ledger size in the local status.
- The phone recovery hold (shared-sink single winner and provider-entry UNKNOWN) is separately owned. Nothing here credits it.
