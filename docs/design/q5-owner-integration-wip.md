# Q5 shared journal owner continuation — unvalidated source

One private candidate on q5-framed-root-journal-wip, preserving9be48c501 and its
75pass/type/lint evidence. New owner/queue changes have NOT executed those checks
yet. Canonical #3758. No app, runtime, driver, settings, producer or UI wiring.

Actual main c43ffb37d20650c542e449a8a04a9fd84e65b655 was fetched/read, not merged
into this candidate. Companion q5-owner-p1-source-bridge.json binds the landed
P1 coordinator/types and intervening paths. Its entry/loss shapes match the
reviewed contract; actual P1 createHandoff can refuse after our durable intent,
and approved ACK mapping remains refused. This private owner exports matching
ledger-domain loss shapes; real type assignment/adapter is deferred to exact
main composition. No executable runtime hookup or generation allocator here.

New `journal.ts` contains one receipt/claim implementation shared by legacy and
root strategies, using the physical backend's ONLY queue. `appendFrom` builds
bounded transaction data against its latest committed view inside that queue;
`inspect` serializes detail lookup/capability minting. `commitFrom` returns an
exact changed/revision/digest/state result, so a claimed disposition cannot be
invented from a no-op or later snapshot. Internal callbacks cannot cross IPC or
retain driver/UI/current-member publishers.

Source semantics to prove, not accepted guarantees yet:

- Strong anchors proportional to active same-process attempts, plus pending
  claims; weak historical handles are bounded by their original receipt-source
  lifetime. Root lookups select one <=50-post attempt, not all historical rows.
- Synchronous marker validates original WeakMap proof/epoch/claim/health/admission
  before irreversible entry, no IO/scheduling; held/stale/blocked returns
  journal_owned. Blocked old candidates cannot revive when a benign claim ends.
- Loss, ordinary settlement and ACK install the same synchronous fence before
  queueing. ACK first declines loss; loss first can be followed by independently
  genuine historical ACK through the same queue. Epoch changes invalidate entry
  but preserve already-entered historical proof. Unsubmitted after entry coerces
  to uncertainty even if the callback handle was released.
- Pure no-effect validation can release a claim. Ambiguous failure keeps storage
  poisoned and failed ownership visible until close. A claimed loss requires an
  actual changed commit and returns the precise normalized disposition.
- Opening recovers repeatedly from the first<=50 active root IDs; unchanged/
  nonshrinking/repeated selections produce typed reconciliation poison instead
  of a loop. New entries are closed throughout. Legacy recovery still uses its
  old one-record/all-array semantics; it gains no bounded-memory claim.
- Ledger-owner retire closes admission and settles active anchors conservatively
  unknown, preserving historical-only ACK. It creates no runtime generation,
  durable membership adoption or chat reset. It does not drain future SDK/receipt
  sources; caller keeps the original bounded sink until response/expiry, then
  explicitly closes the physical owner. Close releases strong maps on failure
  too. Normal uncertain loss leaves admission open for unrelated later work.

Next required controls include both codec factories, sibling/released/forged
handles, ACK-first/loss-first and validation/IO ordering, held-bookkeeping zero
capability, >50 recovery/restart/no-progress fault, retirement and bounded-anchor
release, unrelated later work, post-intent runtime refusal reconciliation,
legacy byte bridge, and meaningful guard/publication/ownership mutants.
Domain shapes alone do not prove actual RuntimeAttemptHooks compatibility or an
approved ACK strength/source. No receipts/counts transfer from9be/P1. Root GC,
catalog/R1, IB3/C1 adapter, migration/UI/revocation, native proof and whole-memory
acceptance remain open. Main composition waits for the coherent boundary.
