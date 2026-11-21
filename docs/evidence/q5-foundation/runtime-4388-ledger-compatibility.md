# Ledger consumer review of frozen runtime binding4388

Verdict: authority/hunk split is compatible; entry/loss ownership and receipt
mapping require the corrections below before consumer binding. This is read-only
source/contract assessment, not executable API, tests, shared-source edit or
implementation approval. Parent has relayed the findings to host owner and QA.

## Exact inputs

- Runtime contract4388d20855664230441648c5923351e32af92df0,
  `docs/design/q5-runtime-coordinator-binding.md`, SHA256
  `82b321ab4780ed6fa3146e4529cc512784a5aaa8410659680f904d3ea75c4ae6`.
- Inspected actual main5bbabde2d9f6dcb4db248d0976681fc331f5611e.
- Accepted journal71bd4d632e58161400d086fa2305ce45580cad60,
  `src/main/services/group-project-notice-ledger/journal.ts`, SHA256
  `e0be83586d17de93b1a4274c428bf19072ed618d4b48df84cccdf59ebfc26ec7`.
- Accepted contractd0316e4769c22f1cc67fd808ef7a019e47d0b246,
  `docs/design/q5-durable-notice-ledger.md`, following approved v2ebb062602.
- Source-only root-state WIP224e0797daf1b6e696b46ddd82bea5d79894ae4c
  remains unvalidated and supplies no journal/runtime authority.

## Agreed authority and hunk division

Host is the sole editor/authority for runtime coordinator, shared runtime types,
chat queue/entry/settlement plumbing, lifecycle, drivers and native transports.
Q5 owns ledger/root/index state and future delivery/wake/scoped-admission consumer
adapters after exact review. Q5 does not allocate runtime generations or create
another coordinator. PTY manager native witnesses are not a second logical
delivery-generation allocator. Shared files remain untouched by this review.

Transport tickets are ledger-free, synchronous Boolean checks bound to exact
original resources. Early chat-adapter marking followed by driver preparation
is an explicit conservative entry delta: post-mark refusal/loss stays UNKNOWN.
Checks at delayed native writes/SDK yield prevent additional Clubhouse-owned
effects where observed; they do not promise SDK-internal withdrawal/drain.
No second automatic Codex leg is permitted after early entry. Wake must cover
the earliest actual mission-bearing argv/spawn or pending-command exposure.

## I3: existing API and required typed successor

At71bd journal.ts124–130, all explicit refusal throws occur in the combined
guard127–128 BEFORE `proof.entered = true`129 and the entered-attempt set write130.
The guards include pending settlement/recovery holds, already-entered sibling
handles, consumed/stale proof, uncertain/missing attempt, identity and storage
health. The void method exposes no typed held result. An unexpected exception
is not the same as an explicit pre-mutation refusal: it may be ambiguous and
must remain UNKNOWN. No catch-all false, exception-string matching or private
field peeking can bridge that API.

Q5 proposes a successor primitive, not an API present at71bd:

```ts
tryMarkHandoffEntered(handle): 'entered' | 'journal_owned'
```

This one synchronous atomic operation validates the opaque original capability,
attempt/process/coverage and journal arbitration. Exactly one valid unheld
candidate can irreversibly mark and return entered. Refused/held/stale/terminal/
already-entered/uncertain/unhealthy cases return journal_owned without scheduling
a second settlement. That result means this invocation did not newly enter; it
does NOT say the whole attempt never entered. Journal ownership includes required
reconciliation, not a claim that every refusal has a currently queued operation.
Unknown exceptions escape and remain UNKNOWN. If the old void method is retained,
it wraps the same primitive; do not duplicate entry guards/capability state.

The runtime's rejected result can describe only its own exact pre-marker guard
refusal. The sole loss invoker then needs a separate Q5-owned synchronous loss
claim outside the entry hook. It must atomically validate the same capability,
decline an existing journal owner, or register the existing settlement fence
before yielding/queuing one producer. A declined journal_owned claim appends
nothing. The claimed producer uses the ONE journal queue; an entered attempt's
unsubmitted request is still coerced to uncertainty. Completion exposes the
actual committed disposition to Q5; a candidate's local nonentry is not durable
whole-attempt unsubmitted proof. The current append API is not this typed claim.
No IO or work scheduling occurs inside the entry-marker hook.

When entry reports journal_owned, the coordinator retires this candidate's
transport/pre-entry hooks and records local nonentry without calling
lost('unsubmitted'). Hold release does not automatically retry, recapture or
resurrect the dispatch. The existing producer governs the attempt: proven
unsubmitted may release coverage; uncertainty/recovery does not. Ambiguous IO
poisons the owner. A producer failure before writing is surfaced; the journal
owner must reconcile the original attempt conservatively to uncertainty or a
visible reconciliation hold, rather than silently reviving a ready dispatch.

Exact controls needed for that successor include held settle/recover, failure
before and after write, duplicate handles and loss requests, consumed/stale/
released handles, unexpected marker exceptions, no entry after hold release,
and genuine late ACK versus uncertainty ordering. Prior71 tests/mutants are
regression evidence, not proof of the new API. Resource refusal currently prevents
execution; no compiler/test pass is claimed here.

## Historical capability lifetime

Runtime retirement clears pre-entry/owner/current-UI references, not the genuine
historical ACK capability while its exact original bounded source is outstanding.
Calling releaseLiveHandoff at retirement would make71bd134–136 reject that ACK.
The attempt-only sink releases it on source response/termination/timeout. It
cannot capture replacement runtime/driver/member publishers. Reopen does not
mint a new capability. A late ACK may settle original history without current
member/UI publication. Storage failure is visible and never credited as a commit.

## I4: no new ACK source approved by this review

All backend post-entry outcomes default UNKNOWN in the initial frozen binding.
An exact successful runtime-validated Codex turn/start or turn/steer response is
an eligible handoff/app-server-protocol receipt in principle under d03168–72;
it is not proof of remote provider/model processing. Current source has not
earned that credit: codex-app-server-client.ts195–200 casts an unknown result,
requestRaw225–229 resolves the raw response, and driver519–541 returns a mode
after resolution. Static generated response types are not runtime validation.

Before any ACK source can invoke the dedicated journal acknowledgment path,
bind the exact original request/client/native child/thread/expected turn; validate
the response shape and native result semantics; prove mismatch/error/timeout/
ignored-late-response refusal and immutable historical publication separation.
Obtain independent exact source/evidence review. No current mode string, plain
promise resolution, echoed content or spawn result is an ACK capability. No
automatic second transport leg after an early marker, even on typed refusal.

There is also a contract-definition distinction to preserve: d03168–72 defines
accepted as acknowledged runtime/driver HANDOFF and explicitly permits successful
PTY input handoff labelled as weaker. Runtime4388 section5's provider-only rule
is a narrower deferred-support subset, not the existing accepted definition.
Do not silently redefine the accepted policy or advertise all-backend readiness.
The71bd state/NoticeDelta schema has no durable receipt-strength field or local
receipt delta. A safe initial adapter maps weaker local_handoff to uncertainty,
never calls ACK for it, and admits that no separate weaker fact is durably stored.
Truthful durable strength recording requires its own bounded content-free schema
and review; this contract does not grant or implement it.

This assessment creates no accepted executable coordinator binding, live routing,
wake, permission change, restart, migration, catalog/R1 activation or release.
