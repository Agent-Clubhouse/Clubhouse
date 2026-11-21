# Q5 journal integration: ownership and source identity gates

Canonical tracking: [#3758](https://github.com/Agent-Clubhouse/Clubhouse/issues/3758).
This is a proposed integration contract, not a change to the accepted delivery
contract, an implementation acceptance, or permission to edit producer/runtime
files. Prepared-state source224e0797daf1b6e696b46ddd82bea5d79894ae4c and evidence
370086a3e4737add482e816614fcdb836a24a998 remain frozen. QA93ec4ed7 approves
that prepared-only package: 50 tests, project types and scoped lint. It does not
establish committed authority, live receipt provenance or source uniqueness.

This note supersedes implementation ordering in planning-only fba51f167 for the
next private journal batch. Existing v2 ebb062602/R1 d0316e476 delivery semantics
remain controlling. No code, settings, producer, runtime or app imports change.
The companion `q5-journal-integration-source.json` binds inspected file hashes
and bounded `gh` issue searches. Current main readback was
5bbabde2d9f6dcb4db248d0976681fc331f5611e; producer files in224e match that main.

## IB3: actual producer guarantee and the unresolved identity boundary

The existing ledger coverage key is the full recipient tuple
`(groupId, fixed host identity/local sentinel, local agentId, member generation)`
plus exact `(seq, postId)`. This gives repeated observation of that same pair one
coverage state. It does **not** alone prove that a previously terminal post ID
appearing at a new sequence is a new post or safe to send again. Accepted v2 also
says reconnect/restart skips confirmed/active/uncertain IDs. These promises must
be reconciled before production binding; this note does not narrow the latter.

Source observations at5bb (line numbers refer to that immutable source):

| Source | What is actually established |
| --- | --- |
| `group-project-host.ts:358–371,404–416` | A host reserves/persists an increasing group change sequence before applying a change. A change can include no post or several bootstrap posts. This is not an all-history post-ID index. |
| `group-project-host.ts:1052–1079` | A supplied message ID reuses the prior post/sequence only while `getMessageById` can find it on the current board. Otherwise a new sequence is reserved. |
| `group-project-host.ts:168–173,1934–1963` | Applied remote results are saved, then retained at most2,000 entries and seven days across callers. Outbox expiry is24h; its retry window does not prevent count eviction of a result within24h. |
| `group-project-host.ts:1481–1535,1639–1674,2004–2024` | A transport retry reuses the queued operation ID. That ID and sender machine deterministically recreate the same message ID. Uncached operations proceed to normal application. Sender `queuedAt` contributes to the ID; it is not a trusted monotonic admission counter. |
| `group-project-bulletin.ts:271–308,550–565` | A supplied ID is accepted; per-topic/global retention and explicit deletion can remove the original post. A retained board is not lifetime ID history. |
| `group-project-bulletin.ts:493–519`; `group-project-network.ts:170–202` | Replica application overwrites a retained ID from incoming host data. Parsing checks optional integer sequence shape, not historical ID↔sequence stability. |
| `group-project-bulletin.ts:750–768,806–826` | Channel/inbox bootstrap can create posts with optional supplied sequence. These helpers supply no lifetime ID uniqueness proof and can share one group change sequence. Their actual delivery eligibility must be proved by the eventual scan adapter; do not assert a universal one-post-per-sequence source invariant. |
| `state.ts:89–101,161–169`; `sparse-state.ts:78–106,156–166` | Both reducers reject conflicting IDs only among pending entries. Acceptance removes pending IDs (the paged reducer deletes `postIds`). Both therefore admit an accepted ID later presented at a new sequence. Oracle parity does not close this producer gap. |

Source-derived counterexample, **not an executed incident**: a remote post is
applied and its reply is lost. Enough unrelated operations evict its applied
result, and retention or deletion removes its original board post. A still-live
outbox retry finds neither record, recreates the same deterministic ID, and
reserves a new host sequence. If the earlier notice was accepted, pending-only
ID checking permits it again. Seven-day TTL does not rescue a2,000-entry count
eviction. No claim is made about actual traffic volume, provider receipt or user
impact. Crash/rollback/regressed sequence and malformed replica cases remain
separate identity hazards; group host identity is not an invented epoch number.

### Source-bound options and recommendation for review

1. **Keep only exact pair coverage.** State publicly that an upstream recreation
   with the same ID/new sequence may notify again. Memory remains tied to holes,
   but this weakens the accepted confirmed-ID replay promise. **Not selected or
   authorized**; it cannot silently close IB3.
2. **Keep a bounded recent ID/result cache without an old-operation floor.**
   It catches conflicts within its explicit retained horizon only. This may be
   useful as a diagnostic but cannot close IB3 at arbitrary eviction boundaries.
   Never call TTL/count retention lifetime deduplication or treat a cache miss
   as proof of a new operation.
3. **Retain every historical ID in sequenced generations.** Exact ID membership
   could reject recreations, but disk grows with all posts and contradicts normal
   sequenced O(holes+active) storage. A hash/Bloom filter adds either tombstones
   or false exclusions; neither is an unannounced substitute. **Not proposed for
   implementation.** Accepted legacy post-ID mode already explicitly discloses
   O(distinct IDs) storage; do not silently move sequenced groups into that mode.
4. **Strengthen the producer protocol with bounded old-operation refusal.**
   Recommended direction for a separate scoped producer contract review, while
   private journal work continues. This needs a durable, authenticated sender
   incarnation and monotonic operation ordinal, plus bounded receiver result
   retention and a durable refusal floor. Cached IDs return their actual result.
   An uncached ordinal at/below the saved floor refuses visibly instead of
   recreating a post. Fresh ordinals are admitted only under a defined ordering
   rule; out-of-order unknown requests may be refused, never silently dropped.

Option4 is a direction, **not an approved protocol or completed fix**. Requirements
before selecting it include:

- Full source identity binds group, fixed authenticated host, authenticated
  sender/incarnation and ordinal; caller-supplied ID/string shape is not authority.
  Never infer ordinal from timestamps, message-ID text, local arrival order or
  receiver clock. Counter allocation/operation persistence precedes send.
- Persist the floor before forgetting any operation whose replay would recreate
  a mutation. The mutation/result crash gap needs durable producer intent or
  equivalent proof; a crash after posting but before saving its result must not
  give the same ordinal a fresh mutation. Do not claim atomicity across today's
  independent board/applied/host-state files.
- State bounds for enrolled identities and sparse out-of-order operations. A
  floor per unbounded historical sender merely moves the tombstone problem.
  Removed/retired sender incarnations must remain unauthorized without implicit
  re-enrollment; how authorized re-enrollment establishes a new incarnation is
  an explicit identity/adoption contract, not an access or live re-pair request.
- A floor eviction may refuse genuinely never-applied older work. UI/result text
  must distinguish known refusal from unknown prior application: absent a saved
  result, it cannot say “never posted” or automatically create a new ID. Preserve
  visible uncertain outcome and explicit user recovery rather than false success.
- Define legacy/mixed-client behavior and upgrade baseline honestly. Existing
  arbitrary UUID operations have no trusted monotonic ordinal. An upgrade cannot
  recover forgotten IDs or retroactively certify old history. No silent new
  baseline/adoption or default-off pause is authorized. Compatible supported
  legacy flow versus visible unsupported-source handling needs reviewed policy;
  it must not defer notices forever without status or reinterpret unknown as new.
- Bind immutable post birth identity separately from later change events; prevent
  held-ID sequence replacement on replicas or report visible source conflict.
  Prove scan eligibility excludes any legitimate multiple-post/nonpost change
  ambiguity or represent it explicitly. A current-board conflict check is useful
  but cannot establish forgotten historical identity on its own.

No producer changes are in this batch. IB3 remains **open** pending an accepted
source contract or explicit user-approved promise change. Ordinary unfinished
private backend work can continue; production binding cannot inherit a false
source invariant.

### Bounded issue dedupe and possible follow-up

Read-only `gh` searches (all states, limit15 each): `bulletin duplicate`,
`outbox replay`, `"applied" "2000"`, `"group" "idempotency"`. Exact argv,
results and issue readbacks are in the companion JSON. No exact matching open
producer-retention issue was identified by these bounded searches; this is not
an exhaustive search claim. #3363 is the closed network-group-project feature;
#3334 concerns agent calls and a different receiver/outbox, despite a related
bounded-dedupe failure class. #3758 remains canonical Q5. No new issue was filed.

If scope review requests a separate issue, proposed title: **Network group posts:
bounded applied-result eviction can recreate a retained operation at a new
sequence after its board post is removed**. The body should cite the immutable
source above, give the conditional replay sequence, label it source-derived/not
reproduced, relate #3363/#3758, and require an explicit bounded replay/old-op
contract with crash/mixed-version controls. Do not reuse #3334 as this bug's ID
or claim an observed duplicate/provider incident. Publication is separate from
editing any host/bulletin/network hunk.

## IB1: one journal authority, expected state and durable exposure

Extract the accepted71bd physical framing/poison/tail algorithm once; retain
legacy bytes and fail-closed complete-frame corruption behavior. One owner and
one serialized transaction queue exist per physical file set. No second catalog
commit queue may publish a root that bypasses this queue. New root profile must
advertise an explicit supported version/minWriter floor; no implicit conversion
or copying a prepared header into a legacy checkpoint.

Proposed root transaction expectation is `{installation, profile, fullRecipient,
revision, priorDigest, priorRootDigest}`. All values are exact committed owner
state, not mutable display/router identities. Clone request data before yielding.
The sole queue verifies that expectation, full recipient/member generation,
health and unchanged files; stale preparation is an inert orphan/conflict.
After preparation awaits, recheck owner expectations and permission/revocation
inputs at their actual authority boundary. Preparation cannot reserve a send.

Every page newly referenced by the candidate authoritative root must be
validated and earn file plus required directory barriers before append. Existing
committed ancestry may supply credit only with authenticated same-owner/root
provenance. Arbitrary prepared/orphan roots earn no credit merely by being
readable or hash-named. The landed index's `flush` of dirty pages is not a full
root traversal/adoption barrier API. A future sealed barrier result binds the
exact header digest, index instance/epoch and protected reference set; validation
must not accept an arbitrary caller-constructed token or a stale flush version.
No GC can race and delete a referenced page between barriers and commit.

Append and sync one bounded framed root record, then publish revision/root and
operation outcome. Before sync, no intent handle, generation, consumed nonce or
accepted result is exposed. Ambiguous append/sync poisons owner and refuses new
sends; reopening reconstructs committed authority under reviewed tail rules.
File hashes alone do not prove filesystem CAS/multiprocess safety. Existing
single-writer premise remains explicit; no native power-loss claim.

## IB2: synchronous ownership for entry, ACK and loss

Accepted71bd provides live capability/entered-attempt protection and synchronous
settle/recover holds, but ACK queues without taking that same synchronous hold.
It cannot be wrapped unchanged to satisfy ACK-first claims. Proposed successor
must make **every** settlement contender participate in one synchronous
ownership registry before any await or queue scheduling: genuine ACK, claimed
loss, ordinary settlement, recovery and retirement. One physical queue then
serializes their truthful committed outcomes.

Frozen runtime8a0 hooks stay exactly:

```ts
markEntered(): 'entered' | 'journal_owned';
onLoss(outcome: RuntimeLoss):
  | { kind: 'journal_owned' }
  | { kind: 'claimed'; committed: Promise<{
      committedOutcome: 'unsubmitted' | 'uncertain'
    }> };
```

These are proposed Q5 APIs, not exports of71bd. No private-field reads,
string-matched exceptions or driver-held journal references. Runtime owner owns
the sole lifecycle generation; journal process identity is receipt provenance.

- `markEntered` is synchronous/no IO. Exact live capability, generation/attempt,
  digest, health, irreversible entered state and settlement ownership are checked
  before any mutation. `journal_owned` includes another settlement/recovery
  already owning the attempt, invalid/released/stale capability or already
  entered attempt: this candidate does not enter and coordinator does not invoke
  loss/retry/recapture. Unexpected exceptions are UNKNOWN under frozen runtime
  contract, not proven non-entry. Programmer failures are not retry signals.
- `onLoss` installs ownership synchronously. If ACK/settlement/recovery already
  owns this attempt, return `journal_owned` with no second append. Otherwise claim
  once and enqueue settlement. If entry occurred (even through a released sibling
  handle), requested unsubmitted becomes uncertain. Return the **actual committed
  disposition**, never invent unsubmitted from a missing attempt/no-op result.
- ACK-first: ACK owns before enqueue; later loss declines. ACK IO failure is a
  visible failed owner/storage reconciliation, not permission for loss fallback
  or a new send. Loss-first: entry fence closes synchronously, loss commits;
  independently genuine still-live ACK can later settle exact historical
  handoff-unknown under the same queue. It cannot confirm recovered uncertainty.
- A hold/claim failure does not silently reopen entry. Poison/failed-promise
  ownership remains visible until exact reconciliation. A legitimate pre-entry
  settled-unsubmitted result can become ready only through durable state and
  fresh capability admission; no runtime retry after a held signal.
- `createHandoff` is after durable intent. Its typed `RuntimePreIntentRefusal`
  can mean persisted intent/no runtime hook. Q5 reconciles that exact intent with
  its own loss claim; never erase, recapture or automatically resubmit merely
  from that exception name. No hook means coordinator did not settle it.

The root state lookup is async. Final synchronous entry must use bounded
journal-owned capability anchors minted only after durable intent and exact
rechecks; no disk reads or full uncertain-history RAM index in the entry hook.
All sibling handles share attempt entry/ownership. Durable uncertainty plus
capability invalidation may absorb old entered bookkeeping; dropping a handle
alone cannot release its posts. Anchor/capability lifetime and bound need proof,
not the current index cache bound.

All backend post-entry outcomes remain UNKNOWN for the initial binding. No
Codex RPC-response, local adapter completion, PTY spawn/echo or ticket Boolean
is an approved ACK mapper. Persisted receipt-strength/version support is another
reviewed schema gate. Historical ACK API compatibility is not provider evidence.

## IB4: committed recovery walk and returned ownership

On open, verify authenticated manifest/root/recipient first. Walk the committed
active index in batches at most50 using the same serialized queue; commit intent
and queued attempts as recovered uncertain. If the walk fails or the owner is
poisoned, no new send/capability may issue. Repeat recovery is idempotent. Merely
opening/verifying PreparedNoticeState is not recovery, and selecting50 IDs once
does not prove the complete active set has been recovered.

After necessary recovery commits, later ready work can proceed independently
of old uncertain holes. No recovered ACK, implicit retry, uncertainty TTL/cap
deletion, refund after possible adapter entry, chat clearing or new member
adoption. Late historical live ACK cannot publish into replacement chat/member.
All new queue/runtime consumers remain separate source/hunk review gates.

## Coherent implementation and proof batch

1. Private physical backend extraction retaining legacy framing/behavior, then
   root codec + full-reference barrier authority + committed recovery walk.
   Continue independent of unresolved producer edits; keep any new root profile
   unreachable from production delivery until IB3 and caller gates close.
2. Shared journal entry/ACK/loss ownership registry and typed consumer adapter.
   Exact accepted runtime signatures; no coordinator duplication or shared edits
   before owner hunk agreement. Catalog atomic nonce/retirement/adoption design
   must choose one authority partition; separate journals cannot claim one-record
   cross-file atomicity. Do not silently commit a speculative partition here.
3. One reviewed candidate batches these dependent boundaries with targeted
   deterministic controls: stale prior root/full-generation mismatch; page/reuse
   barrier failure and pre/post sync cuts; no exposure before sync; partial final
   frame versus complete corruption; replay/reopen; >50 active recovery; sibling
   handles; entry versus awaited ACK/loss/recover; ACK-first and loss-first with
   actual outcomes; failed claim hold; post-intent createHandoff refusal; old
   generation ACK isolation; later unrelated-attempt liveness. Behavioral mutants
   must kill missing synchronous ownership, stale-root recheck, entry guard and
   all-root barrier when those invariants are cited as proved.
4. IB3 producer reproduction should separately cover result eviction within24h,
   board trim and deletion, original reply loss, process reload and replica
   conflicting-ID sequence. A proposed floor protocol additionally needs clock
   skew independence, out-of-order refusal, counter reset/old incarnation,
   retained-result loss, crash between posting/result/floor persistence and
   mixed-version upgrade controls. No tests of this case have executed yet.
5. R1 >64KiB baseline + small atomic activation/nonce/retirement, local-human
   retry/adoption, revocation/permission, migration/rollback, UI and real runtime
   binding remain coherent subsequent work. No heap/performance claim until
   combined state/capabilities/cache/transients are bounded and observed. No
   standalone tiny PR or full CI matrix merely for this planning note.

Changed-source targeted checks use the actual desktop-test-gate4GiB tests/lint,
6GiB compiler, maxWorkers2 total, exact clean head/tree/source hashes and raw
receipts. Do not rerun approved224e for a docs-only contract. Independent exact
contract/source/evidence review precedes integration/PR; normal hosted platform
checks retain their prior explicit filesystem and native-coverage limits.
