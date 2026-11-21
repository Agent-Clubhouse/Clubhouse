# Q5 root journal and catalog: implementation sequence, not acceptance

Canonical issue #3758; durable-ledger user decision and accepted contract v2
ebb062602/R1 d0316e476 remain authoritative. Planning baseline is implementation
0826faa448f83738d3b4cd3b030c5c5eb665f49a. Existing code is unintegrated.
This note specifies the next private store boundary; it supplies no activation,
runtime generation, human authority, product approval or new access.

## Actual starting point and constraints

- `journal.ts` has a single serialized framed/hash-chained commit queue with
  sync-before-publication, poison-on-ambiguous-write and framed-tail recovery.
  Its sequenced-v1 codec/checkpoints still load all sparse arrays.
- The same journal owns exact live receipt capabilities, attempt-wide entry
  tracking and synchronous settlement/recovery entry holds. Approved71 and
  its executed placement/mark mutants must remain regression controls.
- `pages.ts` is an immutable page primitive; `sparse-reader.ts` can verify and
  page a prepared six-root header. No journal commits that header today.
  Targeted read review is separate from publication/flush/eviction acceptance.
- Installation marker admission proves only a ledger installation UUID;
  it proves no migration, recipient generation, baseline, nonce or send intent.
- The historical shared-runtime type is a recovery-owner contract proposal
  (`2def25a1`, annex-phone-controller-recovery-v2.md section5), not an accepted
  actual module/export. Runtime wiring cannot invent or replace that authority.

## One physical journal, explicit codecs

Extract the existing physical storage into one private typed backend, retaining
one owner/serialized queue per file set. Codec parameters cover record apply,
checkpoint encode/decode and identity/version validation. Do not copy the
tail-recovery/poison/manifest/rollover algorithm into a second catalog store.
The first extraction keeps legacy sequenced-v1 bytes and behavior identical;
it does not convert data, change installation markers or claim bounded legacy
memory. Existing receipt management must remain a single implementation, not
separate legacy/paged safety rules. Catalog metadata has no driver receipt API.

Legacy manifest/record schema1/minWriter1 and recipientKey stay byte compatible;
unknown optional supported legacy fields retain existing preservation behavior.
New root codecs must advertise minWriter2 and an explicit supported profile,
with strict required/top-level fields before any catalog integration. Older
writers reject this format, rather than interpreting new roots as empty arrays.
No best-effort downgrade, deletion or silent new baseline is permitted. Profile
and full owner identity are immutable for a file set. A root header's recipient
is compared to the authenticated catalog entry, not trusted because its pages
parse. New profile support does not retroactively authorize old file conversion.

Prepared pages may be computed before a queued commit. The commit must check
the expected root revision/owner identity again inside the sole queue; stale
preparation leaves inert orphan pages and returns a visible conflict, never
overwrites a newer root. Page preparation/flush must finish before the small
root record can append. Cache publication follows successful file and required
directory barriers. Ambiguous IO poisons this owner until reread; a retry of
preparation is not permission to retry a notice send.

## Root-backed sequenced state

One committed header references terminal, pending, ready, attempts, active and
postIds roots. A bounded scan adds at most50 pending posts and canonical
excluded spans. An intent changes only its at-most50 posts and one attempt.
Settlement updates only exact owned posts, neighbouring terminal ranges,
the matching ready/active/attempt rows and counters. The ready index admits
later work above old uncertain holes. No header/full sparse array rewrite or
post-per-confirmation terminal retention is introduced.

The full-array pure model remains a bounded test oracle, not the authoritative
large-state implementation. Differential controls cover scan exclusions,
cap50 frontier, exact identity/digest ownership, stale callbacks, accepted and
unsubmitted semantics, uncertainty, truthful legacy floor and reopened state.
Receipt entry/ACK/settlement holds remain shared above the codec boundary;
disk state alone never mints a live acknowledgement. Root-only metadata must
not bypass the already reviewed receipt or future exact-runtime fences.

Startup verification uses bounded streaming access. Recovery walks only the
active-attempt index in bounded transactions; intent/queued become uncertain,
with no fresh receipt or automatic send. Later notice flow is available only
after necessary owner recovery commits. Retired uncertainty remains queryable.
Combined transient batches, cached details and nested attempt post vectors
still need a concrete measured/inspected bound; the current cache-only tests
do not settle that product contract.

## Catalog, post-ID baseline and R1

A catalog uses the same physical backend, with immutable roots for current
member generations, retired generations, main-minted nonce records and operation
results. Keys derive from exact full local member identity, not a guessed host
string or mutable router policy. Store hash collisions must compare full saved
identity before acting. Receipt process ID, durable member generation and the
separate runtime session generation are distinct identities.

Post-ID mode requires a separate profile: exact IDs, no fabricated numeric
sequence or chronological ID ordering. A sorted baseline producer writes
immutable index pages, validates its bounded root and earns its file/directory
barriers. This includes reused orphan pages across process boundaries; the
prefix-directory barrier question is pending publication review. Baseline
preparation never changes the current generation or consumes a nonce.

A single activation record, entire frame at most64KiB, contains the expected
catalog/root revision, nonce consumption, operation result, old-generation
retirement and fresh generation/root references. All large data stays in synced
immutable pages. Before that record commits, old generation and nonce remain
unchanged. After it commits, the fresh generation is complete and the nonce
cannot authorize another operation, even if the reply was lost. Partial-tail
rules do not manufacture an activation result. Completed record with damaged
checksum follows the existing explicit fail-closed policy, not silent rollback.

Required actual fixture-process cuts: before/after baseline page sync, before
activation append, partial activation frame, after record sync/before cache or
reply. Use a baseline larger than64KiB; retain original bytes, reopened operation
status and nonce/generation state. Repeat recovery and prove orphans do not
activate or consume early. These controls remain unimplemented, not satisfied
by the existing streaming-baseline or installation-marker tests.

## Human operations and runtime dependencies

Trusted local main-window/top-frame/exact entry identity owns retry/adoption;
phone/Annex/MCP/webview/popout do not gain it. Main generates and persists the
one-use expiring operation nonce with full member/generation/expected-state
binding. Confirmed operation commits its result with nonce consumption. Lost
reply means lookup of that same operation, not a new retry. Cancel sends nothing.
Revoked ownership/subscription/grant must be rechecked after preparation and
at the final entry seam; scan-time exclusions are not revived by resubscription.

Local-human adoption retires the old generation without erasing its uncertainty
and establishes an explicit fresh baseline. No automatic identity adoption,
re-pair or chat clearing. Recovery preserves chat by default; explicit reset
belongs to the recovery owner, not this catalog.

Before runtime code: bind the real generation/lease/coordinator type and hunk
ownership with its owner. Preparation yields no send authority. The final
synchronous hook has no await/IO/driver access/retained driver references and
rechecks exact queue object, attempt, lease/session and ownership at entry.
Pre-entry refusal can prove unsubmitted; entered loss/discard is UNKNOWN.
A genuine late receipt can settle only its exact historical attempt and cannot
publish into a replacement chat or member. There is one lifecycle coordinator,
not a catalog-created alternative.

## Review and evidence sequence

1. Resolve index publication/reuse/flush dependency findings and bounded cache
   semantics before authoritative integration. Keep source-only planning apart
   from executed proof; no optional duplicate broad runs.
2. Extract physical backend preserving legacy bytes and single queue/capability
   ordering, then exact risk-targeted tests/types/lint and independent review.
3. Add root-backed incremental state and differential/large-hole/reopen proof,
   including scan exclusions and reviewed arbitration controls on changed paths.
4. Add catalog/post-ID baseline/adoption with actual R1 cuts and mixed-version
   refusal/rollback proof. Old binaries must visibly refuse required ledger state.
5. Coordinate real runtime interface/hunks, then local-human IPC/UI and actual
   delivery/revocation/queue/wake/exact-generation tests. No implicit chat reset.
6. Independent exact source/evidence review before PR and hosted checks. No
   activation, merge, release or native-platform acceptance is implied here.

Every admitted command uses desktop-test-gate (tests/lint4GiB,compiler6GiB,
maxWorkers2total,75 refusal at least60s spacing), with clean exact head/tree,
source hashes, argv, exit and original raw output. Immutable page garbage
collection must independently prove reachability after committed checkpoints;
never drop retired uncertainty merely to meet a size cap. Physical IO failure
is explicit; no exactly-once, enforceable provider delivery or power-loss claim.
