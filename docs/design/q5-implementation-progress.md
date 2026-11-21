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

Independent successor: immutable bounded page index (`pages.ts`) with lazy
point lookup/pagination and separate LRU limits (4 detail leaves, at most64
entries each;16 reference-only index pages). Root references confer no activation
authority: callers must flush pages then commit a root through the journal.
Old roots remain immutable through updates/deletes; byte and entry limits both
split leaves. This is a primitive only, not yet wired into the sequenced reducer
or R1 adoption, and does not by itself close the full sparse-state memory gap.
Terminal acknowledged attempts also release the journal's volatile entry-ID
tracking; uncertain entered IDs remain tracked independently of handles.

Successor index work adds sorted streaming baseline preparation, bounded
multi-level root references, predecessor lookup and full streaming verification.
Preparation produces only immutable orphan pages/root references. It neither
activates a generation nor consumes a nonce. The planned >64KiB activation
record/partial-tail/process-crash controls remain separate and unimplemented;
producer-failure/orphan tests are not credited as those R1 controls.

Marker/durability successor adds a fixed local installation UUID marker and
matching directory envelope, bounded stable reads, single-flight main creation,
future/corrupt/missing/mismatched metadata refusal without rewriting originals.
Its factory does not migrate legacy receipts or create any member generation,
baseline or nonce. Real synthetic process-exit controls cover marker-only,
directory-without-envelope, and fully synced-envelope boundaries. An incomplete
bootstrap refuses explicitly; it does not silently manufacture a fresh ledger.

Directory flush observations are explicit: observed directory sync, file sync
only for narrow known Windows directory results, or not observed. Actual IO,
disk-full and access errors propagate; no power-loss/native-Windows proof is
implied by synthetic policy controls. Journal/pages use this private flusher,
without changing settings-store/replaceFile/renameOver or legacy budget writers.
Native platform verification and safe explicit incomplete-bootstrap repair are
still pending. None of these modules is imported by app startup or delivery.

M1 successor to approved814 marker boundary: two-phase min-writer2 bootstrap
resumes only absent/empty/matching-envelope pristine state with the same UUID;
no possible supported generation/record can exist before active marker admission.
Active missing data and ambiguous nonempty bootstrap refuse unchanged. Legacy
min-writer1 is always active, never bootstrap; older814 refuses new version2.
Five actual child-exit stages plus repeated envelope→active interruption and
ambiguity/version controls are planned proof. This is installation recovery
only, not a member generation, legacy migration or R1 activation record.

M1 algorithm/compatibility review16cf4fe approved f58 with required M1-L temp
cleanup. The successor cleans only its just-exclusive-created metadata temp in
finally, retains the first failure as private non-enumerable cause, and leaves
actual process-crash/failed-cleanup residue fail-closed without arbitrary cleanup.
New fault controls target all three metadata purposes plus actual rename failure,
temp-opened child exit, phase/version/UUID/dir/symlink negatives. These checks
and exact successor QA are required before claiming M1 closure.

M1-L is independently approved at6d208ecb2 (review9bccb144). Only the
tempOpened cut actually exits a child process; beforeWrite/beforeRename are
in-process injections. Crash residue still refuses pending inspected repair.

Journal admission successor: source inspection and a preserved test-only
baseline b8bd6c0e3 reproduce two additional races (two handles entering one
attempt, and entry during a pending unsubmitted commit releasing coverage).
This successor holds entry synchronously when settlement/recovery is requested,
before queued IO can yield, and refuses a second handle after attempt entry.
Attempt-local holds do not prevent unrelated entry; recovery holds all entry.
Genuine already-entered ACKs retain their separate provenance path. These are
journal-local controls, not the shared runtime-generation coordinator. Exact
successor validation and independent review remain required; no provider or
runtime execution incident was observed by these synthetic tests.

Prepared-root reader successor is separate from the old full-array journal:
its sequenced-sparse-v1 header contains only metadata and six immutable roots
(terminal, pending, ready, attempts, active, postIds). Opening verifies every
page and streams coverage/cross-index ownership without collecting all rows.
Reads return at most50 attempts/posts with root-local lexical cursors; status
pagination does not imply post-ID chronological order. This is prepared state,
not authenticated committed state or a migration path. No root is activated,
nonce consumed, recovery/send permitted, or provider session touched.
The page cache retains its fixed limits, but combined transient rows, attempt
post vectors and total process heap are not yet a proven product hot-detail
budget. Authoritative incremental updates, journal codec/activation, index GC,
R1 post-ID mode and integrated performance remain separate work.

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
