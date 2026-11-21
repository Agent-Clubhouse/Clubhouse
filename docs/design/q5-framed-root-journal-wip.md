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
   Successor source replaces the initial76e1 flat legacy reads with bounded
   regular-file descriptor reads, initial-absence distinction, digest/identity
   checks and same-descriptor reused-file sync (write-capable on Windows). It
   also adds a mandatory fixed installation/profile check and strict manifest
   fields for the new profile. These changes are UNVALIDATED hardening, not
   inherited native proof or the missing root codec/full-root publication gate.
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


Initial source freeze76e1efbe09460c9fe796d8a72fa12a005a7006e7 remains preserved.
The immediate bounded-IO successor will receive targeted development barrier
checks, project typecheck and scoped lint against its own frozen head. Such
checks do not establish physical-backend behavior: it still has no journal
consumer/root codec/typed receipt manager or PB1–5 execution package. No whole
candidate or platform review is requested until that coherent scope is complete.


## Root-codec source continuation (initially unvalidated)

Source1ee4a1afd introduces the fixed root codec and six development controls.
It binds prior-header digest/full recipient and the physical new-profile
installation/version, uses the instance/root/epoch barrier before append, replays
strict bounded root headers and verifies the final committed tree once before
open returns. It does not recover attempts or expose a receipt/handoff API.
Pure sparse input refusals now use a separate no-effect validation class; unknown
IO/invariant errors remain poisoning candidates. Reader header validation is
factored into a shared strict metadata decoder, with explicit page-reference
shape checks. These are changed sources requiring fresh proof; old224 receipts
do not transfer. Root records protect local persistence under the single-writer
assumption, not a cryptographic signature or provider-processing receipt.

The initial barrier traverses/syncs ALL roots on each new commit; no authenticated
prior-ancestry optimization or measured throughput is claimed. Root GC and
obsolete-version retention remain open. Six tests define root/checkpoint reopen,
stale expectation, process duplicate open/close, held-bookkeeping zero new state,
no-effect validation versus ambiguous sync, and fixed identity/missing-page
refusal. Capability-zero, ACK/loss registry, active-anchor release, progress-guarded
recovery, byte bridge, mutants and platform acceptance still need the single
shared journal consumer and coherent final proof. No partial PR/review promotion.
