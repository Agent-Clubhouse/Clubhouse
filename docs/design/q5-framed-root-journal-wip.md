# Q5 framed/root journal candidate — incomplete, unvalidated

This named WIP branch preserves initial private implementation following
e5001edd3 / independent boundary reviewd3a0efaf. It is NOT the complete reviewed
candidate, NOT a runnable feature, and NOT proposed for PR. Canonical #3758.
Prepared224e and C1 b11fa01a evidence remain separately frozen. No producer,
runtime, settings, app import, catalog/R1, migration, GC or live activation.

Current source adds `framed-journal.ts` and `legacy-codec.ts` and extends the
unwired landed `pages.ts` with an instance/root/epoch-bound whole-root barrier
prototype plus four focused test definitions. These tests have NOT executed;
no compiler or lint run has executed on this WIP, and previous-head receipts
do not transfer. No source or platform acceptance is claimed.

Implemented in source, not proved:

- One file-set backend queue, canonical real-path process opening registry,
  explicit close/reconciliation refusal, framed replay/partial-tail preservation,
  manifest/segment handling and typed no-effect validation versus ambiguous IO.
- Legacy checkpoint strategy separated from framing, keeping legacy byte shapes
  and unknown optional metadata; it still loads full arrays. New profile meaning
  is not inferred from an arbitrary optional legacy field named `profile`.
- Final append bookkeeping precedes one nonyielding state/metadata/hash/internal
  publication phase, including local staging for segment rollover. Additional
  length/prefix/frame checks are deliberate hardening, not prior execution proof.
- Own-current metadata temp cleanup and original error preservation prototype.
  Existing single-writer and lstat→unlink race/platform identity limitations apply.
- A six-root page barrier prototype freshly validates/syncs every referenced page,
  bypasses cache credit, flushes touched directories, rejects overlapping mutation
  epochs and records an opaque WeakMap-bound token. It has no GC protection or
  authoritative journal consumer yet. Added tests define orphan/cached traversal,
  clone/instance/epoch mismatch, sync/corruption refusal and overlap controls.

Required remaining work before the promised coherent review candidate:

1. Concrete fixed installation/full recipient/profile/prior-header identity in
   root manifest/records and root codec, with trusted creation versus read/replay.
   The present generic physical expectation only checks revision/digest; it is
   not IB1 closure. No arbitrary caller codec is an app configuration path.
2. All newly authoritative root/header references need proper descriptor/content/
   identity validation, file/prefix/directory barriers and exact provenance.
   Flat physical checkpoint page IO is still legacy-style (readFile before size
   check, existing hash reuse without new file sync). Do not give a new root
   checkpoint credit from that legacy path. Resolve with the root codec/barrier
   design and platform tests; no whole-memory or native durability claim.
3. Shared journal receipt owner/adapter, typed entry and loss claims, ACK-first
   ownership, actual committed outcomes, active-anchor bounds and release on
   settle/recover/retire, no current-UI references in historical ACK sinks.
4. Repeated-first50 committed recovery with PB1 no-progress typed refusal/poison.
   Opening this file backend alone does not recover attempts or permit sends.
5. Legacy read/byte bridge and prior fixture migration (duplicate-open now needs
   explicit close), sole-queue tests, held/failing final-bookkeeping zero-state
   AND zero-capability proof, PB2 validation/IO controls, PB3 aliases/failed-open,
   PB4 releases, PB5 premature-publication mutants. Source names/interfaces may
   change inside this one candidate; no exact API is considered accepted yet.
6. Barrier semantic mutants, exact source hashes/checks and independent pages
   review; normal hosted Windows/POSIX proof when an approved PR is appropriate.
   Existing Windows reuse proof does not cover this newly added traversal API.

Root obsolete-page GC remains deferred/unbounded and is not product acceptance.
IB3 #3770/user promise choice, authored literal-system classification and future
scan-adapter predicates/refusals remain separate gates. No all-history uniqueness,
exactly-once delivery or provider-processing receipt is asserted.
