# Q5 private physical backend: concrete extraction boundary

Proposed implementation map following ownership contractc0dea82e. No executable
API or new writer is introduced here. Canonical #3758; producer identity follow-up
[#3770](https://github.com/Agent-Clubhouse/Clubhouse/issues/3770) remains separate
and source-derived/unreproduced. IB3 production-binding hold is unchanged. The
separate b11fa01a C1 test successor and19efe825 evidence are not copied here.

## Immutable inputs and the existing coupling

Accepted journal source71bd4d632e58161400d086fa2305ce45580cad60,
`src/main/services/group-project-notice-ledger/journal.ts`, SHA256
`e0be83586d17de93b1a4274c428bf19072ed618d4b48df84cccdf59ebfc26ec7`.
It is not landed, app-wired or an accepted paged backend. Approved prepared
state224e0797d and landed index main5bbabde2d are separate inputs. Their source
identities and proof scopes must stay separate in the next source bridge.

| Actual71bd source | Ownership after extraction |
| --- | --- |
| `journal.ts:8–16,48–66` size/hash/envelope/version checks | Private physical file/envelope layer, with closed supported codec selection. Legacy validation and JSON encoding preserved; new root version remains explicit. |
| `journal.ts:74–88,145–240` manifest/chain/load/tail/unchanged | Sole file-set backend; only this implementation decides frame boundaries, chain/revision, poison and retained-tail handling. |
| `journal.ts:242–300` synchronous holds + queued reducer + IO | Split at ownership, not copied: journal owns synchronous attempt claims; backend owns the only queue and invokes codec preparation inside it. Claims are installed before scheduling that queue. |
| `journal.ts:303–339,350–388` array checkpoint pages + manifest switch + GC | Legacy checkpoint codec retains its format/read behavior. Physical layer owns serialized manifest switch and file barriers. Root codec cannot reuse all-array reader or legacy reachability set as bounded root proof. |
| `journal.ts:89–143` process/capability/entry/ACK | One shared journal capability/settlement owner above codec choice. No receipt API on the file/page backend or metadata catalog. |

`NoticePageIndex.verify` is a read/cache traversal. `flush` drains observed dirty
directories. Neither is a sealed whole-root barrier for externally prepared or
reopened orphan trees. The forthcoming barrier API is a **change to the landed
pages module** and requires its own exact source review and platform proof;
prior Windows reuse acceptance does not authorize treating arbitrary roots as
durable. No shared runtime/type/driver/host/bulletin/settings hunk is reserved by
this note.

## Proposed private module split

- `framed-journal.ts`: file-set owner, queue, manifest/envelope framing, replay,
  poison, append/sync, segment rotation and atomic manifest publication. It has
  no runtime generation, receipt validation, UI publisher, nonce policy, board
  lookup or network access. One backend instance per fixed file set under the
  existing single-writer premise; opening a second instance is not a CAS claim.
- `legacy-codec.ts`: current array reducer/checkpoint encoding and validation,
  preserving legacy manifest/record/checkpoint bytes and supported unknown fields.
  Explicitly retains unbounded legacy cold state; extraction does not improve
  its heap by changing its name. Legacy page GC stays on its own file namespace.
- `root-codec.ts`: future strict versioned root envelope, exact recipient and
  expected-prior-root validation, async prepared-state transition, authenticated
  replay/open and checkpoint header. It cannot accept a structural accepted
  delta as live receipt authority. Initial private profile is fixed-recipient;
  it is not a catalog/generation activation or cross-file adoption transaction.
- `journal.ts`: main-only owner of exact handoff capabilities and the shared
  synchronous entry/ACK/loss/recovery registry. Selects only known compile-time
  codecs, then calls the one physical queue. No second `.work` chain in a wrapper.

These are internal modules, not a configurable persistence/plugin/scripting
engine. Paths are fixed by the main owner, never renderer/MCP supplied. Codec
implementations, publication hooks and operation functions are never serialized,
received through IPC or provided by drivers. The exact exported signatures are
an implementation deliverable; names here do not confer executable authority.

## Queue and publication protocol

The backend holds the only promise chain. Public journal operations clone bounded
input and install any synchronous attempt claim before calling it. Each queued
operation receives the latest committed view plus an internal commit facility;
it does not call another public queued operation or recursively enqueue while
holding that queue. Explicit checkpoint and automatic rollover execute through
the same facility. A failed predecessor does not skip the health/poison check.

For root transactions:

1. Check exact installation/profile/full recipient-generation, expected revision,
   prior record digest and prior header digest against authenticated committed
   state. A header, digest string or storage directory alone is not authority.
2. Prepare a candidate from that committed view, with no state/handle publication.
   If preparation was done outside the queue, repeat every expectation check
   inside it. Retain only inert orphan pages on stale expectation/refusal.
3. Validate every newly authoritative reference and obtain root-specific file and
   directory barriers. No naked `flush()` Boolean is sufficient. Any reused page
   carries the validated descriptor/content/identity semantics already required
   on each platform. If a read/barrier fails, refuse the candidate.
4. Recheck unchanged manifest/segment and the owner expectation after awaited
   preparation/barriers. Build the bounded frame using the sole current revision
   and digest. Root record plus its framing must fit64KiB; large state lives in
   protected immutable pages. No overlarge record truncation or multi-record
   pretend atomic operation.
5. Rotate/checkpoint inside that same queue if required. Append, file-sync and
   required directory barriers must succeed. Finish required current-file hash
   bookkeeping before exposing candidate authority. Publish backend metadata,
   committed state and synchronous capability-anchor invalidation in one
   non-yielding internal phase. A publication exception poisons the owner; no
   driver callback runs in that phase.
6. Return the actual committed operation result. Poison or ambiguous IO never
   becomes a successful intent/nonce/settlement, a new baseline or a send retry.
   A later reopen may discover a committed record despite a lost local result;
   exact operation lookup/reconciliation decides, not an automatic resend.

The existing71bd writes state/revision at289 before awaiting the current-file
hash at292. Completing bookkeeping before publication is an intentional ordering
hardening in extraction, not a claim of mechanically identical observation at
every await. Add a held/failing final-bookkeeping control: no new state or handle
is exposed while it is held; failure is poisoned and reopen reconciles committed
bytes. Preserve actual evidence, and do not describe this source observation as
an executed incident. This change needs exact review alongside the extraction.

## Legacy compatibility and failure preservation

Keep existing legacy record field order/framing, numeric bounds, chain checks,
manifest extras, unknown supported checkpoint fields and filename namespace.
Do not add a root-profile field to old records, regenerate prior process IDs,
reinterpret old active installation markers or automatically convert data. New
profile version/refusal is separate and cannot be silently read as empty legacy
arrays. Ledger-unaware historical builds still cannot be forced to check a
sidecar; accepted operator rollback limits remain explicit.

Checkpoint switching follows pages sync → atomic manifest commit → logical
publication → retired legacy-file GC. A GC failure does not undo an already
committed manifest. New root GC needs independent protected-root reachability
and bounded traversal; it cannot borrow legacy `readPages(..., Set)` as a
whole-memory proof. Initially withholding root GC is safe for an unwired research
backend, but accumulates obsolete page versions and **does not meet** normal
O(holes+active) retained-storage or product acceptance. That gap must remain
visible until reviewed compaction/GC closes it.

Provably partial last frame: preserve original bytes durably before trim, as
accepted. Complete checksum/invalid-length/interior/missing-segment damage:
preserve and fail closed; no automatic repair to keep notices moving. Own-current
temporary cleanup should follow accepted M1-L exact ownership and original-error
preservation; never remove prior-process/ambiguous residue. Introducing cleanup
is a separately tested improvement, not an assumption inherited from old
`atomicManifest`/`putPage` helpers. Process exits, simulated filesystem faults and
native hardware/platform coverage remain separately attributed.

## Shared attempt ownership and bounded recovery integration

The one journal receipt manager must be reused for legacy/root profiles. All
ACK/loss/ordinary settlement/recovery contenders register synchronously before
queueing. Claims cannot be reconstructed from on-disk accepted-shaped data.
Prepared state is async, so exact synchronous entry uses journal-owned capability
anchors minted only after durable intent and validated current-state rechecks.
Sibling handles reference the same irreversible attempt entry/claim record.
No full historical-attempt map is loaded for the entry hook.

ACK-first declines later loss; loss-first blocks new entry and returns its actual
coerced outcome, then separately genuine still-live ACK may settle only original
handoff-unknown history. Recovered uncertainty never mints ACK. Failed claimed
producer keeps visible failed ownership/reconciliation rather than removing its
fence in a generic `finally`. A completed proven-unsubmitted disposition may
release coverage; it does not authorize this runtime candidate to self-retry.
Frozen runtime signatures and createHandoff-after-intent caveat remain those in
the parent integration note. No backend ACK mapper is approved.

Recovery is an internal owner operation, not a separate queue or a call to a
public queued method from within itself. On open, keep storage admission closed
while authenticating and recovering the committed active set. Repeatedly select
the **first at most50** active IDs from the newly committed root, recover and
commit them, then select again. This avoids a stale continuation cursor skipping
keys as the active index shrinks. Do not iterate only the first batch or treat an
empty ready set as proof that recovery is complete. Failure refuses new sends;
successful recovery leaves old uncertainty out of automatic replay while later
ready work proceeds. This transient startup/storage fence is not a persistent
permission pause or a new policy setting.

## Exact next proof package

The next implementation should combine extraction, root commit/reopen and typed
ownership in one unwired review candidate. No full hosted matrix per internal
slice. The relevant private unit/process fixtures can run locally under the
existing authoritative gate once the source is frozen; no old receipt transfers.

- Legacy read bridge: frozen71-created manifest, records/checkpoints and supported
  extras load in the extracted implementation unchanged. Legacy new writes retain
  canonical field/framing bytes. Deterministic process IDs used only in a test
  harness must not become an app option or receipt source. No test “normalization”
  may hide missing/reordered state or dropped fields.
- Preserve existing71 journal failure/reopen/entry controls and their two research
  CJS fixtures; `require.extensions` recursively resolves new module imports.
  Mutation fixtures target semantic guards exactly once or fail setup; a failed
  compile/target match is not a killed safety mutant.
- Single-queue discrimination: overlap checkpoint, stale prepared root, two
  intents and ACK/loss/recover on same and unrelated attempts. Assert exact commit
  revisions/state and no second publication order, not only promise resolution.
- Root/barrier discrimination: cold prepared/orphan reused leaf and index pages,
  shared committed subtrees, failed sync, overlapping dirty-version flush, final
  bookkeeping held/failure, expected prior root/generation mismatch and append
  cuts. Missing barrier/check mutants must fail meaningful controls.
- Recovery:51+ active IDs require multiple committed batches; interrupted second
  batch and reopen are idempotent, preserve all uncertainty, admit new independent
  work after completion and never make old attempts ready/ACK-capable.
- Typed ownership: ACK-first/loss-first, duplicate/sibling/released/stale handles,
  held claims, genuine historical ACK, unexpected marker/loss-hook exception,
  failed claimed IO, post-intent coordinator creation refusal. Mutants removing
  synchronous ACK ownership or entered coercion fail exact behavioral assertions.

Retain clean source head/tree and per-file import/provenance hashes before/after
each actual admitted command, raw stdout/stderr, argv, exit and platform limits.
Targeted tests/lint min4GiB, project compiler min6GiB, maxWorkers2 total. Product
binding additionally needs IB3/C1 future-adapter proof, catalog authority partition,
R1 activation, human retry/adoption trust, migration/rollback, revocation, UI,
bounded combined memory/storage and real runtime interfaces; none is silently
promoted by this physical extraction plan.
