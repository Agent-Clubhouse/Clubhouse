# Q5 implementation progress

Canonical issue: #3758. Approved contract v2 `ebb062602`; R1 clarification
`d0316e476` independently confirmed by review `7027e0f8406a813dd3f38684a84a8791acbfebd4`.
Original frozen contracts and receipts remain unchanged in ancestry.
Main integration base now includes `78092f9b213d80698f758e709a23feac60374380`
via merge `5a643059408b9481a5602f345a3ad1309ea6baf9`.

Current slice: **unintegrated sequenced persistence foundation, WORK IN PROGRESS**.
It adds internal pure interval/state reducers and a bounded framed/hash-chained
journal, immutable paged checkpoints and synthetic child-process crash fixtures.
There is no app import, notification routing change or capability advertisement.
Initial validation is pending; no feature acceptance is claimed.

Frozen foundation36 and portable evidence02cc are preserved. Its actual36-test,
root typecheck and scoped lint pass is bounded foundation proof, with earlier922
lint failure retained. Independent source audit129082916 identified F1–F4.
The successor adds exact entered same-process receipt capabilities, refusal to
accept recovered uncertainty, visible late-ACK anomaly count, explicit complete
cap50 frontier enforcement, and truthful `excludedSequenceCount` naming. Invalid
complete/zero-filled tails remain refused with unchanged bytes; conservative
invalid-tail repair is deferred pending proof, with the liveness cost documented.
These changes and the F1/F2 contract clarifications await exact successor checks
and independent re-review; no integration acceptance is inferred.

Audit74cd7dec resolved F1–F4 at0d but requested G1: entry lived only on a handle,
so raw unsubmitted could still return entered posts to ready. The successor
tracks entered attempt IDs independently of handle lifetime and coerces such
settlements to uncertainty. New control releases the handle first and verifies
no ready/retry after disk reopen; an in-memory one-guard mutation must fail that
assertion and preserves its actual child exit/output in the test log. No feature
acceptance or lazy-index implementation is claimed by that correction.

Important remaining work before this can be a product:

- Installation marker, migration orchestration and generation-pointer ownership.
- Post-ID baseline indexes and atomic root activation/nonce/adoption paths,
  including >64KiB and partial-activation-record crash controls.
- Lazy archived uncertainty/status pagination: current reducer snapshots load
  sparse rows into memory; bounded persisted pages alone are not proof of the
  full hot-detail budget or incremental compaction performance.
- Actual per-bound product persistence/compaction tests and cross-platform
  directory-flush support/visible durability limits; research IO is not proof.
- Notification owner wiring, queued/immediate/wake receipts, synchronous final
  admission and the separately owned shared recovery-generation type.
- Strict local-human retry/adoption IPC/UI, uncertain-reply lookup, schema
  compatibility and content-safe status/size fixtures.
- Focused owner/gate/runtime/revocation tests, independent exact source/evidence
  review, then PR/hosted checks. No merge/activation/release authorization.

The store accepts only a main-owned directory/recipient, not renderer authority.
No generic rules, external probes, installs, new grants or live settings writes.
Tests use synthetic state and temporary directories only.
