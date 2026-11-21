# Q5 runtime coordinator binding: source-bound proposal

Status: **corrected frozen design successor to `4388d2085`, requiring exact
independent interface/hunk review before any P1 implementation**.
This document proposes one runtime coordinator. It does not implement or authorize a
runtime binding, a restart, a wake, provider expenditure, grants, or phone policy.

## 1. Frozen inputs and authority

| Input | Exact identity and qualification |
| --- | --- |
| Inspected main | `5bbabde2d9f6dcb4db248d0976681fc331f5611e`, tree `7b1a379cabf025b78a517d6232e49fedbd682def`; explicitly re-resolved through `gh` before this freeze |
| Landed Q5 foundation | Main's five-file immutable index/durability change only; no journal integration or runtime binding inferred |
| Accepted journal | `71bd4d632e58161400d086fa2305ce45580cad60:src/main/services/group-project-notice-ledger/journal.ts`, SHA256 `e0be83586d17de93b1a4274c428bf19072ed618d4b48df84cccdf59ebfc26ec7` |
| Accepted installation file | `6d208ecb262d99857b0f31b4bd93d4e6509b2947:src/main/services/group-project-notice-ledger/installation.ts`, SHA256 `95e4ee63d4cbbf4f29fd08ce2ef7eec486b698654584e42f9badbbfe635e7fea` |
| Q5 contract input | `d0316e4769c22f1cc67fd808ef7a019e47d0b246:docs/design/q5-durable-notice-ledger.md`, successor of `ebb0626026c02c4e04f4c17c770d4369a7da4527` |
| Independent direction review | `2edfa73e9878dee79f3e5af668950e2baf818052:docs/qa-transfer/2026-11-20/reports/q5-runtime-coordinator-4388d2085-review.md`, SHA256 `eda537996151474014642feff204358344da4499cf7a84a12fed6634076a9055`; I1-I4 remain required contract corrections, not P1 implementation authority |
| Q5 precise compatibility assessment | `eb23ded2540148236ad1540a259103d71922de9b`, tree `00f671f49a7e10ce7e78e822c60ef2bd1b73d532`, `docs/evidence/q5-foundation/runtime-4388-ledger-compatibility.md`, SHA256 `0300e95dd6b2751d181ea803fa9fc91d573027936b30b87437bce26aa6a116f4`; typed entry/loss APIs are proposed dependencies, not accepted executable code |

The matching journal on another branch is file identity, not whole-branch
approval. Q5's G1, mutation/arbitration and M1-L approvals do not approve this
binding. Every line range below refers to the exact inspected main.

Ownership is split by **authority**, not by creating two coordinators:

- The host runtime owner, lane-3613-p2-routes, owns the sole generation allocator,
  resource leases, dispatch entry state, lifecycle retirement and work recovery.
- Q5 owns durable recipient/membership generations, installation/journal/index,
  exact sorted coverage, permission/membership admission, and notice/wake/outcome
  adapters. Its journal handle never allocates a runtime generation.
- Drivers and transports know only a Boolean transport-admission ticket and
  opaque dispatch correlation. They receive no journal handle, ledger callback,
  member publisher, runtime owner callback, or retained replacement-driver reference.

`handoffProcess` is journal provenance. PTY's native process generation is a
resource witness. Dispatcher `clearGeneration`, launch-gate receipts, session
strings and scalar notification cursors are not runtime or settlement authority.

## 2. One module, one shared structural seam

The only generation authority is the proposed new main-only module:

`src/main/services/agent-runtime/runtime-coordinator.ts`

The trusted host-runtime port is used by runtime installation/lifecycle code.
The notice port captures existing leases and creates scoped dispatch tickets;
it cannot attach a resource, advance a generation or resurrect a retired lease.
Both ports reference the same coordinator state. These are not separate engines.

Opaque values are created only in main; neither tools nor renderer/phone inputs
can supply, deserialize or adopt them. Both handoffs and transport admissions have
distinct unique-symbol brands **and** are registered in the sole coordinator's
private `WeakSet` registries when issued. A symbol property or matching IDs alone
is not authority. The coordinator retains no prompt content,
durable coverage or driver methods. A transport ticket retains only immutable
token identities and revocation state, not a driver/session or ledger closure.

Frozen structural interface proposal, not implemented source:

```ts
type RuntimeLease = RuntimeLiveLease | RuntimeDormantLease;
type RuntimeLoss = 'unsubmitted' | 'unknown';

export const runtimeHandoffBrand: unique symbol = Symbol('runtime-handoff');
export const runtimeAdmissionBrand: unique symbol = Symbol('runtime-admission');

type RuntimeEntryDecision =
  | { kind: 'entered' }
  | { kind: 'rejected' }
  | { kind: 'journal_owned' };

type RuntimeJournalEntryDecision = 'entered' | 'journal_owned';

interface RuntimeLossCommit {
  committedOutcome: 'unsubmitted' | 'uncertain';
}

type RuntimeLossClaim =
  | { kind: 'journal_owned' }
  | { kind: 'claimed'; committed: Promise<RuntimeLossCommit> };

interface RuntimeRetirementInfo {
  candidateDisposition: RuntimeLoss | 'journal_owned';
  firstRetirement: boolean;
}

interface RuntimeTransportAdmission {
  readonly [runtimeAdmissionBrand]: true;
  readonly dispatchId: RuntimeDispatchId;
  readonly resource: RuntimeResourceId;
  allowed(): boolean;
}

interface RuntimeHandoff {
  readonly [runtimeHandoffBrand]: true;
  readonly dispatchId: RuntimeDispatchId;
  tryEnter(): RuntimeEntryDecision;
  observe(receipt: RuntimeHandoffReceipt): Promise<void>;
}

type RuntimeHandoffReceipt =
  | {
      kind: 'local_handoff';
      dispatchId: RuntimeDispatchId;
      resource: RuntimeResourceId;
      boundary: 'pty_input' | 'stream_stdin' | 'sdk_input_consumed';
    }
  | {
      kind: 'native_response';
      dispatchId: RuntimeDispatchId;
      resource: RuntimeResourceId;
      request: RuntimeProviderRequestId;
      provenance: 'codex_rpc' | 'verified_provider_adapter';
    }
  | {
      kind: 'approved_handoff_ack';
      dispatchId: RuntimeDispatchId;
      resource: RuntimeResourceId;
      request: RuntimeProviderRequestId;
      provenance: 'codex_rpc' | 'verified_provider_adapter';
    };

interface RuntimeDriverSendResult {
  delivery: MessageDelivery;
  receipt?: RuntimeHandoffReceipt;
  pendingReceipt?: Promise<RuntimeHandoffReceipt>;
}

interface RuntimeAttemptHooks {
  markEntered(): RuntimeJournalEntryDecision;
  onLoss(outcome: RuntimeLoss): RuntimeLossClaim;
  onReceipt(receipt: RuntimeHandoffReceipt): Promise<void>;
}
```

`RuntimeDispatchId`, `RuntimeResourceId`, leases and transition handles are opaque,
main-created values. A display string or UUID does not let a caller reconstruct
one. The implementation must keep exactly one owner-defined runtime generation
per logical local agent within the main process, regardless of runtime kind.

Main runtime ingress validates the registered handoff **before invoking its methods
or a driver**. The issued transport admission is also registry-checked before
passing it to a driver. Reject a fabricated, cloned, cross-coordinator or
unregistered value through the repository's explicit error boundary; do not call
its `allowed()`/`tryEnter()` or silently discard it as ordinary untracked input.
Registered membership does not imply liveness: original generation/admission
checks still reject a retired registered value.

Drivers remain coordinator-free and receive only already-validated admissions.
Brand/registry constructors are never exported through IPC, tool schemas, preload,
renderer or plugin APIs. P1 proves issuing/registry/retirement mechanics without
consumers wired; P2/P3 must prove zero calls at the actual chat/PTY ingress.

The proposed coordinator ports use these concrete signatures. Their opaque owner,
native-witness, queue and publication values are supplied by existing trusted main
owners, never a caller-provided session string. `RuntimeAttemptHooks` contains only
Q5's sealed synchronous marker, loss reporter and attempt-only historical observer;
it does not contain a member/current UI publisher.

```ts
interface RuntimeOwnerPort {
  registerOwner(agentId: string, owner: RuntimeOwnerIdentity): RuntimeDormantLease;
  beginTransition(
    lease: RuntimeLease,
    reason: RuntimeTransitionReason,
  ): RuntimeTransitionResult;
  claimStart(lease: RuntimeDormantLease | RuntimeTransition): RuntimeStartResult;
  attachResource(
    start: RuntimeStartClaim,
    witness: RuntimeNativeWitness,
  ): RuntimeAttachResult;
  bindQueue(handoff: RuntimeHandoff, queue: RuntimeQueueIdentity): void;
  bindPublication(
    handoff: RuntimeHandoff,
    publication: RuntimePublicationIdentity,
  ): void;
  mayPublish(handoff: RuntimeHandoff, publication: RuntimePublicationIdentity): boolean;
  retireResource(lease: RuntimeLiveLease, reason: RuntimeTransitionReason): RuntimeTransitionResult;
}

interface RuntimeNoticePort {
  isRegisteredHandoff(value: unknown): value is RuntimeHandoff;
  isRegisteredAdmission(value: unknown): value is RuntimeTransportAdmission;
  captureLease(agentId: string): RuntimeLease | undefined;
  captureAdmission(scope: RuntimeAuthorizedNoticeScope): RuntimeAdmissionLease;
  closeAdmission(admission: RuntimeAdmissionLease): void;
  holdScope(
    scope: RuntimeAuthorizedNoticeScope,
    deadline: RuntimeAdmissionDeadline,
  ): RuntimeAdmissionHold;
  scopeHoldStatus(hold: RuntimeAdmissionHold): RuntimeAdmissionHoldStatus;
  finishScopeHold(
    hold: RuntimeAdmissionHold,
    currentAuthority: RuntimeNoticeAuthorityResult,
  ): RuntimeAdmissionResult;
  createHandoff(
    lease: RuntimeLease,
    admission: RuntimeAdmissionLease,
    hooks: RuntimeAttemptHooks,
  ): RuntimeHandoff;
  transportAdmission(
    handoff: RuntimeHandoff,
    resource: RuntimeResourceId,
  ): RuntimeTransportAdmission;
  retireHandoff(handoff: RuntimeHandoff): RuntimeRetirementInfo;
  lossSettlement(handoff: RuntimeHandoff): Promise<RuntimeLossCommit> | undefined;
}
```

Transition/start/attach/admission results are discriminated
`applied`/`superseded`/`failed`, with failure requiring an explicit reason; they
never default to an applied lease.
`registerOwner` is host-only initial installation, not a Q5 allocator or an
implicit adoption of an existing owner. `bindQueue`/`bindPublication` bind once,
before the first dispatch await. Replacement/removal invalidates that binding.
The coordinator-created `RuntimeHandoff.tryEnter` checks these bindings and the
original admission/resource before invoking the sealed journal marker.
The discriminated runtime entry result is main-only; drivers' `allowed()` remains
strictly Boolean. Q5's proposed atomic marker returns only `entered` or
`journal_owned`. Only the runtime's own exact pre-marker guard can return
`rejected`. A journal-owned result is not Boolean false followed by an unsubmitted
settle. These proposed dependencies do not exist in the accepted `71bd` API.

One owner-defined generation has the phases `dormant -> claimed -> live`.
`claimStart` exclusively claims that original dormant generation: it does not
allocate another generation or adopt a separately started process. `attachResource`
requires the same original start claim. Retirement/replacement revokes the old
generation and stages a new host-owned generation; Q5 cannot promote an old live
dispatch into it. A transition's start claim is valid only for that transition.
`finishScopeHold` requires the original hold still owns its scope revision plus
verified current authority; failure/supersession cannot reopen any old admission.

The host maps native witnesses to the actual original chat session or manager-owned
PTY process. Transport tickets contain opaque resource IDs, not those native
objects. Driver native checks compare captured actual objects as well as the
ticket's scalar admission. Neither a mode string nor a fabricated receipt object
can establish `RuntimeProviderRequestId`: the verified native adapter binds its
actual original request/result to that dispatch and resource.

The coordinator's host port has these synchronous operations:

| Operation | Contract |
| --- | --- |
| Capture live/dormant lease | Capture original generation and current admission state; no asynchronous lookup or equal-ID adoption |
| Begin owned transition | Verify original owner, synchronously close admission and revoke its tickets before any recovery/retirement await; return an owned transition handle or typed superseded |
| Attach created resource | Require the original opening/start handle still owns its generation; attach exact native witness once; stale creation closes only its own resource |
| Retire resource | Revoke admission before asynchronous close/kill; old close failure cannot revive old leases |
| Check publication | Compare original generation, exact resource and captured conversation/publication context; no mutation or IO |

The notice port has these synchronous operations:

| Operation | Contract |
| --- | --- |
| Capture scoped admission | Q5 supplies a main-owned, already-authorized permission/membership scope; generation, scope revision and live/dormant lease are captured |
| Revoke scoped admission | Immediately invalidate affected tickets; other groups/recipients and unrelated human messages remain admitted |
| Create dispatch | Bind original lease, admission token, immutable queue/message identity and Q5's original historical handoff; no resource relookup after a wait |
| Final try-enter | Check all ownership/admission/queue predicates, then invoke only the sealed synchronous journal entry primitive; no await or driver access |
| Create transport ticket | Bind that dispatch to the exact originally attached resource; `allowed()` is synchronous, Boolean-only and memory-only |
| Record loss/receipt | Preserve irreversible entry classification independently of queue slots and current UI; receipts cannot retarget an attempt |

The coordinator's classification, revocation and native checks are synchronous.
The coordinator alone invokes `hooks.onLoss`, at most once per handoff, through
one internal retirement transition. Runtime discard, direct/queued failure,
resource teardown and repeated `retireHandoff` calls converge on that transition.
An entry result of `journal_owned` invokes **zero** loss hooks. Otherwise the
single loss hook performs Q5's proposed synchronous ownership claim, outside the
entry hook: validate the exact capability/attempt, decline a journal owner, or
atomically install the existing settlement fence before scheduling one producer.
A declined claim appends nothing. A claimed producer uses the **one** journal queue
and returns its actual committed outcome, including unsubmitted-to-uncertain
coercion, not the caller's requested/local candidate classification.

`retireHandoff` returns informational state only: callers never invoke `onLoss`
or append another settle using its return value. `lossSettlement` exposes the
same already-started claimed persistence promise for awaiting, not another
invocation. For journal-owned settlement/reconciliation it is undefined,
explicitly meaning the coordinator is not the settlement owner, never a
resolved/success-shaped substitute.

Q5's claimed loss/receipt persistence is deliberately awaitable outside the entry hook:
failed journal writes remain visible failures/uncertainty, never an accepted
default, an automatic retry or a silently swallowed acknowledgment error.
An unexpected synchronous claim exception also remains UNKNOWN with a visible
failed/reconciliation state and failed settlement promise. It does not clear the
at-most-once latch, retry the producer or return undefined as if a journal owner
had been proved. Informational candidate disposition is not committed proof.

The structural `RuntimeHandoff` and `RuntimeTransportAdmission` seam belongs in
`src/shared/chat/runtime.ts`, which already contains main-owned callback options.
That file must not import the main coordinator or ledger. The coordinator owns
constructors and opaque authority; the shared file owns only the structural types.

Add an optional **trusted-main-only** `RuntimeSendOptions.handoff` and optional
driver `send` admission argument:

```ts
send(
  content: ContentBlock[],
  delivery: MessageDelivery,
  admission?: RuntimeTransportAdmission,
): Promise<MessageDelivery | RuntimeDriverSendResult>;
```

An untracked legacy driver may still return its current mode string. A tracked
driver returns a separate mode/receipt result; absence of a verified receipt is
never acknowledged. An outstanding native source may expose `pendingReceipt`,
without ledger callbacks in drivers. Main registers the attempt-only historical
observer and releases it on the actual bounded source's termination/timeout.
Local receipt completion does not manufacture a subsequent provider ACK.
The runtime unwraps this internal driver result into the existing public mode.
Existing `RuntimeSendResult` and public chat/phone event shapes stay unchanged.
Runtime mode results are not receipt authority.
The new `RuntimeLoss` is internal: do not smuggle `unknown` through the old
`ActionQueueSettlement` or public delivery enum and call it wire compatibility.
Q5 consumes the internal handoff disposition rather than existing weak Action
callbacks. Adopting UNKNOWN for other Action/public receipts is a separate reviewed
consumer change, not implicit clearance here.

### Trusted construction-site inventory

On inspected main, **no existing ingress constructs a runtime handoff**.
The only proposed callers of the coordinator factory are Q5's trusted main
delivery/wake adapters,
after original lease/admission and saved-intent proof. Wrappers carry that issued
object; they do not construct or deserialize another one.

| Construction/carry site on inspected main | Exact rule |
| --- | --- |
| `group-project-delivery.ts:366-411` | Proposed Q5-only constructor after durable intent; normal message text/source/actionId does not mint a handoff |
| `group-project-wake.ts:13-34` | Proposed Q5-only dormant constructor after existing prechecks and saved intent |
| `agent-lifecycle.ts:155-250`; `agent-system.ts:117-169,812-827,1243-1289`; `chat-spawn.ts` mission send; PTY pending command | Carry the registered trusted-main object from Q5; never hydrate it from wake/spawn args or native command text |
| `ipc/chat-handlers.ts:168-186` | Validated text/delivery/attachment IDs become literal `{ source, delivery }`; no payload/options spread |
| `ipc/group-project-handlers.ts:311-324` | Validated agent/message become literal source option or raw PTY input; no handoff construction |
| `clubhouse-mcp/tools/agent-tools.ts:301,579-582` | Literal selected main options; do not accept `args.handoff` or derive authority from `taskId`/routed content |
| `clubhouse-mcp/tools/dispatcher-delivery.ts:101,239-243`; `actions/steps.ts:77-95,140-149` | Existing `Pick<delivery, actionQueue>` forwarding is not authority; do not widen/spread untrusted options into the new field |
| `annex-server.ts:3254,3532` | Literal `{ source: 'annex' }`; remote body/content never carries coordinator authority |
| `ipc/plugin-mcp-handlers.ts:48-87`; `plugin-tool-registry.ts:99` | Renderer tool definitions/results/args remain external data; no coordinator constructor exposed through the plugin tool bridge |
| `src/preload/chat.ts:16-17`; `src/preload/groupProject.ts:70` | Plugin/page-facing invocation carries only existing agent/text/delivery/attachment values into the validated IPC handlers; no handoff argument or factory |

Exact future ingress controls must also exercise the plugin-facing preload/IPC
path, not merely check a TypeScript type. A fabricated branded/structural object,
serialized payload with a `handoff` key, or matching opaque-looking IDs cannot
enter the coordinator registry. Prove zero driver/provider calls and no new Q5
intent/capability construction from those inputs. A valid issued object remains
usable only for its original main owner and generation.

## 3. Intent, queue and final entry linearization

For each Q5 attempt:

1. Existing budget/session/membership/grant prechecks run first. A refusal creates
   **zero intents**. Capture an original live or dormant lease and scoped admission.
2. Q5 durably appends intent with exact recipient generation, attempt and sorted
   coverage, then captures the same-process journal handoff capability. Recheck
   the original lease/admission after IO; never capture a new generation to save
   an old attempt. Capture failure is visible, not an accepted/default receipt.
3. Runtime dispatch state binds that capability to one exact message/queue object.
   Main owns the entry marker. It is not transferred into an unrelated coalesced
   message or reconstructed from text, `actionId`, sequence maximum or client ID.
4. After **every** await, including `beforePrompt` and causal activation, the final
   synchronous gate checks session, generation, lease, queue identity, expiry and
   scoped permission. Only then may it call Q5's proposed
   `tryMarkHandoffEntered(handle)`.
5. There is no await between a successful entry marker and adapter invocation.
   Native transport checks later use the ledger-free ticket, not a second journal
   callback or a new current runtime lookup.

The existing client queue is not the dispatch lifecycle. In particular,
`chat-runtime.ts:1002` clears `pendingDispatch` before the await at `1008`.
An independent dispatch record must remain reachable until definitive outcome/
retirement. `pendingDispatch === undefined` never proves non-entry.

Queued removal, expiry and latest-only replacement use exact original objects.
An entered message cannot be reclassified as expired/replaced/dropped-before-entry.
Q5's saved coverage remains gap-preserving, not a maximum scalar cursor.
Coalescing of unrelated tracked attempts is prohibited unless Q5 supplies an
explicit reviewed exact-coverage operation; do not copy one hook onto merged text.
Non-Q5 queue/coalescing defaults remain unchanged.

## 4. Entry strength and no-replay rule

This is a deliberate conservative **adapter-early entry contract delta** for
tracked chat messages. It is not exact provider-entry proof:

| Original attempt state | Consequence without a genuine correlated ACK |
| --- | --- |
| Runtime's exact pre-marker guard refuses | Candidate `rejected`; no adapter/native call; Q5's atomic loss claim decides whole-attempt settlement |
| Q5 marker reports `journal_owned` | This candidate did not newly enter; zero runtime loss hook/append, no replay or capability recapture |
| Marker throws an unexpected exception | UNKNOWN; never blanket false/rejected/unsubmitted, even if the native call was prevented |
| Successfully marked chat adapter entry | Any subsequent rejection, transport refusal, reset, discard, loss or timeout is `unknown` |
| Live PTY before first actual message write | Runtime guard can reject this candidate; whole-attempt unsubmitted still requires Q5's claim |
| Live PTY first write marked/called, including only a paste prefix | Any later loss/refusal is `unknown`; preventing Enter does not undo earlier entry |
| Wake mission exposed in native argv at process creation | Mark before the first mission-bearing spawn; failure/loss afterward is `unknown` |
| Wake mission retained only in the original pending command | Final gate/marker precede first command write; any earlier mission exposure overrides this later boundary |

The sealed `tryEnter` invokes Q5's proposed
`tryMarkHandoffEntered(handle): 'entered' | 'journal_owned'` after runtime guards.
It is synchronous/atomic, with no IO, scheduling, await or driver access. It
validates the exact original capability, attempt/process/digest and arbitration.
Exactly one valid unheld candidate irreversibly marks.

Held, already-entered sibling, consumed, uncertain/terminal, stale/released or
unhealthy cases return `journal_owned` without a new mark or settlement. That
means **this invocation did not newly enter**, not that the whole attempt never
entered; journal ownership can mean reconciliation rather than an already queued
operation. Retire the candidate's transport/pre-entry references without `onLoss`,
resend, recapture or resurrection when a hold releases.

The accepted `71bd` method is void and its combined explicit refusal guard precedes
mutation, but it exposes none of this typed ownership. Generic/unexpected throws
are **not** blanket nonentry proof. Unexpected exceptions escape the proposed
primitive and produce UNKNOWN; never catch-all false or exception-string matching.
If Q5 retains the old void method, it wraps the **same** primitive, not duplicated
entry/capability state.

The separate proposed loss claim is also not current `append`. Outside the entry
hook it validates the same original handle/attempt, atomically owns the settling
fence before any yield, and schedules at most one producer. Existing journal
ownership/hold/staleness declines without append. Actual committed unsubmitted
may release coverage; uncertainty/recovery does not. A producer failure before
writing is visible and requires conservative owner reconciliation to uncertainty
or a visible reconciliation hold, never silent ready revival. Ambiguous IO
remains poisoned. Journal coercion of entered unsubmitted to uncertainty is
preserved; runtime state must not rely on that backstop to justify a false claim.

**Once early entry is marked, there is no automatic second Codex transport leg.**
Even typed evidence that the first steer was refused before transport cannot undo
the ledger entry or authorize `turnStart` for that same attempt. Existing untracked
driver fallback may retain its current behavior; tracked attempts must not execute
the `send:523-536` catch-and-retry branch. `turnSteer:170-174` currently constructs
an ordinary `Error` for no active turn: it is not a typed settlement capability.
No exception-string matching, ambiguous catch fallback or equal-session adoption.

## 5. Receipt strength, provenance and historical settlement

`observe` distinguishes **local input handoff**, **native protocol response** and
**Q5-approved genuine acknowledgment of the original handoff**.
None proves model processing, completion, exactly-once execution or drain.

| Observed source | Permitted fact | NOT permitted |
| --- | --- | --- |
| PTY process write returns | Local write invocation; full guarded paste/submit completion may report `local_handoff/pty_input` | Provider ACK, processing or acknowledgment from a liveness/size no-op |
| Claude stream void send/stdin write | Local `stream_stdin` handoff when the exact writable original child was actually used | Provider ACK or inferred CLI acceptance |
| Claude SDK queue push | Local buffering only | Input consumption, provider ACK or withdrawal after SDK yield |
| Guarded SDK iterable returns exact input to SDK consumer | `local_handoff/sdk_input_consumed` | Provider acceptance/processing or cancellation of SDK-internal work |
| Driver resolves `'prompt'`, `'steer'` or `'queued'` | Delivery mode only | Genuine ACK or automatic journal acceptance |
| Successful runtime/resource spawn | Process/resource creation only | Mission ACK, budget refund after possible submission or accepted notice |
| Exact original Codex request receives a successful response | Native app-server response candidate only; initial binding stays UNKNOWN | Journal ACK without Q5-approved shape/provenance semantics, model processing, global cursor advancement or replacement UI authority |
| Copilot SDK `.send` resolves | SDK call resolution at the currently inspected source | Provider ACK unless the exact SDK/provider result semantics and request correlation are independently verified |

**Every backend, including Codex, defaults UNKNOWN after entry in this initial
binding. No ACK mapper/source is approved or wired by this freeze.** A native
response, local handoff or driver resolution cannot call `acknowledgeLiveHandoff`.
The future `approved_handoff_ack` receipt branch is unavailable until Q5
explicitly accepts an exact original same-process handoff mapper and independent
source proof. A fabricated discriminator is not source approval: initial
observers cannot promote even an object labelled `approved_handoff_ack`.

The accepted `d031:68-72` contract defines acknowledged runtime/driver **handoff**,
not remote model processing, and permits successful PTY input handoff labelled as
weaker. The initial UNKNOWN/provider-mapper-deferred subset is intentionally
narrower support, **not a redefinition of that accepted contract**. It does not
advertise all-backend readiness or auto-replay weaker/unknown work.

The `71bd` state/`NoticeDelta` has **no** durable receipt-strength field or local
receipt delta. Local receipt facts here are transient, bounded/content-free
observations; the existing adapter may persist uncertainty, not a separate weaker
receipt fact. Durable weaker-strength recording requires its own separately
reviewed bounded content-free schema. No such schema addition is authorized here.

Claude currently sends no owned request correlation in `toWireUserMessage`, and
its driver ignores `user_message` echoes (`1062-1064`). Echo/content matching does
not mint a capability. Copilot currently discards `.send` results. Those sources
need separate exact provider-result/correlation proof before being credited.
Codex currently casts unknown/raw results and discards them into a mode return;
generated/static types are not runtime response validation. Before future ACK
acceptance, bind original request/client/native child/thread/expected turn,
validate actual shape/semantics and prove error/mismatch/timeout/ignored-late
refusals plus historical/publication separation on the exact head.
Codex's request ID and successful response are observable, but a timeout removes
the pending request (`requestRaw:217-227`): a subsequently ignored response is not
an available historical ACK callback merely because the server might have sent it.

The genuine historical ACK sink captures **only** original journal capability,
recipient/membership generation, attempt/coverage proof and request correlation.
It does not capture the current member, driver, runtime, chat emitter or cursor
publisher. A real old ACK may settle its original historical attempt after runtime
revocation. It cannot settle a new attempt, reopened journal or rejoined membership,
or publish into the replacement chat/member UI.

When connecting `pendingReceipt`, extract the attempt-only observer function;
do not capture the entire handoff object, runtime or current-member closure.
Its original receipt correlation check is independent of current runtime
admission. Await durable ACK settlement and surface commit failures before
crediting accepted coverage; native success alone does not prove journal commit.

Runtime retirement synchronously clears owner/pre-entry hooks and mutable member/
publisher references. Unknown/pre-entry loss notification is at most once.
It does **not** call `releaseLiveHandoff` while a genuine original bounded ACK
source is outstanding; doing so would invalidate the historical capability.
The separately retained historical sink survives only while its actual original
ACK source remains outstanding; clear it after response, definitive source
termination or bounded request timeout. No infinite ticket/driver retention.
Recovery/reopen cannot create a missing same-process ACK capability.

## 6. Every owned transport boundary

Choose **coordinator-owned transport-ticket rechecks**, not a broad asynchronous
prepare refactor. `allowed()` has no await, ledger callback or side effect.
Drivers additionally check their own captured native object and closing state.
No provider access occurs inside the journal entry hook.

| Exact source and boundary | Required ticket/resource behavior |
| --- | --- |
| Chat direct `675-784`; queued `978-1026` | Original session and immutable dispatch; final recheck after `756/768` or `993/1008`; no mutable queue-slot proof |
| Claude driver `759-783` | Capture original transport; after image waits, reject closing/retired original dispatch before send |
| Claude SDK `sdk-transport.ts:57,125,193-196,240-244` | Queue tracked envelope with ticket and original query/resource; guarded prompt iterable checks after awaited dequeue and immediately before returning/yielding input |
| Generic `async-queue.ts:22-29,46-55` | **No modification**: `finish()` retains buffered items and `next()` drains them before done; it is not withdrawal proof |
| Claude stream `142-145,182-194,302-307` | Check exact original child/stdin and ticket immediately before the write; no optional-chain/no-op accepted fallback |
| Copilot driver `494-533,557-605` | For registered tracked attempts only, recheck after command/image awaits with captured original SDK and closing/finished checks; gate `commands.invoke:562`, post-await mode/prompt effects `572/576`, and `setModel:589` after `ensureProviderModel:588`. Untracked command behavior remains unchanged |
| Codex driver `484-541` | Carry one ticket to original client/request; no tracked automatic steer-to-start retry; commands cannot synthesize message ACK |
| Codex client `requestRaw:204-229` and `ndjson-rpc-base.ts:153-155` | Original native process/stdin witness checked before request write; unavailable/nonwritable transport is an explicit refusal, never successful void/no-op |
| PTY `pty-runtime.ts:83-106` | Capture exact manager session before assignment await; first actual write marker and ticket for all remaining paste/submit effects |
| PTY `pty-input.ts:41-61,128,143,152-171` | Every delayed chunk, Enter and buffer observation uses original native session/process, not `agentId` lookup after delay |
| Bare join injection `group-project-lifecycle.ts:39-60` | Capture exact PTY resource for paste plus timed Enter; no replacement-process targeting |
| PTY manager `write:747-782` | Tracked path requires explicit success/refusal and original session identity; validate size/liveness before entry, without altering raw human-input defaults |

Claude's guarded iterable wraps **only its private input queue**, retaining current
generic queue behavior for all other callers. It skips retired tracked envelopes,
releases their ticket references and reports UNKNOWN if already adapter-entered.
It checks again after waiting even when push resolves an already-pending `next`.
Closing invalidates admissions before asynchronous query close. Buffered values
that were already yielded to the SDK, Copilot's internal native enqueue and bytes
already written to stdin/PTY cannot be withdrawn by these checks.

Q5 tracked delivery uses the existing host/client queue rather than treating a
native SDK queue as removable. Native queue acceptance still has its own receipt
strength; no SDK-internal drain/cancellation guarantee is introduced. Untracked
native queue defaults and provider behavior remain unchanged.
Copilot's additional command gates apply only when the host supplied a registered
tracked admission. They do not change ordinary commands, hidden/busy handling or
the existing unawaited command behavior for untracked messages. A tracked command
response is not an ACK mapper, and suppression after entry remains UNKNOWN.

## 7. Dormant wake and earliest mission exposure

Existing group wake requires a durable last session and budget reservation
(`group-project-wake.ts:21-34`); these remain pre-intent checks. A dormant lease
belongs to one original wake/start attempt, not whichever process later shares
the agent ID. After settings/authorization/causal waits, recheck that same lease.
Only its owned successful creation can attach its native resource.

Carry the original handoff through `WakeAgentRequest`, `SpawnAgentParams` and
the selected launch path. The earliest source-owned mission-bearing exposure is
the entry boundary:

- Chat creates a driver session without input, then sends its mission through
  the final adapter-entry seam.
- The inspected interactive PTY implementation constructs mission-bearing command
  arguments (`agent-system.ts:1116-1137`) but spawns a shell with only `['-il']`
  or `['/v:off']` (`pty-manager.ts:513-545`). Its mission is retained in the
  original `ManagedSession.pendingCommand`; mark immediately before the original
  command write at `216-225`, after final lease/launch/resource checks.
- Any selected path that passes mission-bearing argv to native process creation
  must instead mark **before that spawn**, after its final asynchronous preparation.
  `agent-system.ts:865-883,954-970` demonstrates a headless argv path; it is limited
  to quick agents and is not the currently permitted durable group wake. Do not
  broaden wake policy to admit it. If future tracked launch selection cannot prove
  the earlier boundary absent, write-only classification is not allowed.

Pending-command state binds original dormant/start lease, dispatch and native
session; command flush on either data or resize cannot re-resolve a respawn by ID.
Revocation clears the owned pending command and its hook before maintenance.
If an earlier argv exposure was marked, suppressing the later flush remains
UNKNOWN. Process creation/`onCreated`/`announceAwake` is never a notice ACK.
No budget refund is authorized after possible mission submission.

## 8. Lifecycle, publication and work-only recovery

Capture native witnesses, not facade equality:
`getAgentRuntime` creates a new `PtyAgentRuntime` on each lookup (`index.ts:26-34`).
PTY manager owns the original `ManagedSession`, native process object and native
generation. Chat owns the actual `ChatDriverSession` plus original opening handle.
Store those witnesses in host-owned records; drivers retain their own exact native
objects, while ledger sinks retain no resource methods.

Synchronous admission closure precedes the first asynchronous retirement/recovery
work. Entry state is independent of queue removal. Superseded transitions close
or clean up only their own created resource, never the current global agent.
Failed close cannot restore revoked generation/admission tickets. An authorized
transition that fails before destructive work may preserve its exact still-owned
resource under a fresh lease after verified current ownership; it never reopens
the old lease or silently retargets an old tracked attempt.

`dispatcher-clear-chat.ts:129-153` currently awaits policy/session/quarantine/
preparation before `runtime.clearContext` at `143`. At the real authorized recovery
admission, capture work owner and affected old waiting requests, then close its
admission **before those awaits**. Policy/confirmation refusals still perform no
destructive recovery. Do not move a confirmation check into a synthetic always-true
gate or use the separate local `clearGeneration` as settlement authority.
Each asynchronous step rechecks the same transition, including actual final clear.

Work-only recovery preserves the separate visible chat, conversation and held
queue. The explicit `both` scope clears it separately (`161-170`); work failure
never authorizes clearing chat. Newly admitted requests are not part of the old
captured waiting-request cancellation set.

Bind publication context before awaits. `chat-runtime.ts:1300-1348` currently
stamps `this.sessionId` after emit-chain/media awaits; direct send also publishes
after adapter resolution. The owned path captures conversation ID, sequence owner,
resource and trace/display context before entry. Recheck before invoking emit,
after queued media work and before current UI/state mutation. Historical output
must never be stamped with a new session ID or update replacement pending turns,
Details state, transcript, cursor or event listeners.

Historical ACK settlement is a separate lane: suppressing old UI does not discard
the original genuine ACK. There is no conditional `if currentMember` around
historical journal acknowledgment.

## 9. Scoped revocation and real queues

No new permissions or policy defaults. Q5 translates existing receiving-computer
grants/membership into scoped admission tokens and closes them synchronously
before asynchronous removal/maintenance. A group/recipient change does not
retire an unrelated agent generation or other recipients' tickets.

Actual sources must compose, not be replaced by a fictional common queue:

| Actual source | Required fence and owner |
| --- | --- |
| `agent-grants-store.ts:43-58` | Q5 admission adapter closes affected scope before store update/maintenance; saved revision is rechecked, tool-change notification after await is not the final fence |
| `group-project-host.ts:537-562,588-607,677-711` | Q5 brackets authorized grant/membership/deletion changes before their async body; arbitrary async membership draft requires conservative scoped hold, not delayed departure inference |
| Host `onChange:2090`; delivery listener `535-566` | Synchronously close/hold affected scoped admissions on record/membership/deleted notification before appending asynchronous `changes` work |
| Delivery `forget:260-278` | Revoke original member admission first, remove exact queue object afterward, report removal failure visibly; a new member-map entry is a different recipient generation |
| Dispatcher recovery queue and runtime registry | Host owns generation/resource transition; neither board write serialization nor journal serialization owns the provider lifecycle |
| Journal append/recover queue | Q5 retains accepted synchronous holds/irreversible entered arbitration; no runtime authority inferred from durable IO completion |

A proposed change awaiting validation may **hold** the affected notice scope,
without changing the grant or deleting anything. Refusal/failure must be visible.
Only verified current authority may issue a fresh admission token; old tokens
never revive. Permanent deletion/departure remains governed by existing host
authorization and durable membership generation. Incoming replica changes require
the same receiving-host scope fencing, not a local user-action-only shortcut.

Each asynchronous-draft scope hold has a trusted-main finite monotonic deadline,
validated against its separately reviewed operation budget; no infinite deadline
or raw IPC/tool-supplied timer. Success, denial, thrown/aborted draft and deadline
expiry all terminate that exact hold and release its retained hooks/timer.
`scopeHoldStatus` distinguishes pending/released/failed/expired, with an existing
held-notice reason and repository-standard visible log/status on failure/expiry.
An unresolved draft cannot silently hold a resource forever.

Expiry does not restore old tokens or grant permission: the scope is visibly
unconfirmed until fresh verified current authority issues new admission.
Completing an old draft after timeout or after another scope revision cannot
reopen the expired hold. No new UI/phone field or implicit permission widening
is authorized. Exact production deadline/budget and existing status sink need
P5 review; P1's fake-clock expiry tests do not choose a new product timeout.

Exact lower-store/bracketing implementation must be independently reviewed against
the actual writer queues. These are proposed Q5-owned adapter hunks, not cleared
grants/store changes or a claim that post-commit notifications already close races.

## 10. Exclusive hunk ownership and implementation order

No parallel shared edits. All source entries are reservations for review only.
Q5 prepares compatible consumer changes against the frozen shared interface;
the host runtime owner is the **only editor** of shared runtime/types files.

| Exact file/site on inspected main | Editor and responsibility |
| --- | --- |
| New `services/agent-runtime/runtime-coordinator.ts` | Host: sole generation/resource/dispatch/transport/retirement state |
| `shared/chat/runtime.ts:42-77,282-324` | Host: main-only handoff/transport structural seam; public results/wire projection unchanged |
| `agent-runtime/index.ts:12-45` | Host: attach/retire actual chat or manager-owned PTY witness, no facade equality |
| `agent-runtime/chat-runtime.ts:295-410,556-571,675-837,904-1037,1055-1154,1300-1348,1386-1408` | Host: all shared-file entry/queue/loss/lifecycle/publication plumbing; Q5 supplies historical adapter, not overlapping edits |
| `agent-runtime/chat-spawn.ts:278-295,386-414,643-656,675-772` | Host: original opening ticket, stale creation/cleanup, registry guard and fallback no-replay |
| `agent-runtime/pty-runtime.ts:79-134`; `pty-input.ts:41-171` | Host: original native session, all delayed tracked writes and typed handoff/loss |
| `pty-manager.ts:39-45,216-228,457-471,491-591,747-782,828-908` | Host: exact resource ticket, pending command, original process close/timers; no replacement cleanup on mismatch |
| `agent-system.ts:117-169,812-827,865-970,1116-1137,1243-1289,1511-1590` | Host: trusted wake handoff through actual start/argv/command; exact original resource at final create/kill and exit bookkeeping |
| `group-project-lifecycle.ts:39-60` | Host: capture original native process for bare delayed paste/Enter, no new ledger semantics |
| `src/main/chat/claude/driver.ts:759-783,954-961`; `transport.ts:84-113`; `sdk-transport.ts:57,125,193-196,240-244`; `stream-transport.ts:142-145,182-194,302-307` | Host: ledger-free transport ticket and exact-resource checks; private guarded iterable, no generic queue edits |
| `src/main/chat/copilot/driver.ts:494-605,680-709` | Host: tracked-only post-await SDK/command ticket checks and honest receipt strength; untracked commands unchanged |
| `src/main/orchestrators/adapters/codex-chat-driver.ts:484-541,640-648`; `codex-app-server-client.ts:157-174,204-229`; `ndjson-rpc-base.ts:153-155` | Host: final original transport fence, no tracked second leg, explicit refusal; untracked request/default behavior preserved |
| `dispatcher/dispatcher-clear-chat.ts:129-170`; work-health `39-65` | Host: admission-first owned recovery; preserve real confirmation/policy, work/chat split and single-flight |
| `group-project-delivery.ts:89-119,253-278,281+,360-419,535-566` | Q5: durable intent before handoff, exact queue/attempt/coverage, scoped revocation, UNKNOWN/no-resend and historical ACK separate from current cursor |
| `group-project-wake.ts:13-41`; lifecycle `WakeAgentRequest/wakeWiredAgent:155-250` | Q5: original dormant lease and main-only handoff passed to host-owned spawn seam; precheck zero intents and no spawn-success ACK |
| Grant/store/host admission sites in section 9 | Q5: scoped admission bracketing using the one coordinator; exact hunk review before any edits |
| Journal/index/root/installation files | Q5 only; accepted isolated file identities are not permission to change them through runtime work |
| Actions `engine.ts:1492-1519`, `steps.ts:86-95`; Dispatcher delivery `239-244` | Read-only compatibility inventory in this freeze: existing mode/Action outcomes cannot be reused as Q5 ACK. Any broader UNKNOWN/public receipt adoption needs its own exact hunk/serialization review |
| Generic `async-queue.ts`, phone, renderer/plugin and Annex lifecycle | No edits authorized by this proposal |

Implementation may start only after exact independent contract/hunk review and
Q5 interface concurrence. Foundation/types and each consumer must bind the exact
integrated source, not an earlier partial branch. The eventual ledger binding
cannot be declared complete before every admitted backend's receipt limitations
and native transport inventory are explicitly accepted.

### Reviewable delivery pieces, not six automatic PRs

| Piece | Bounded scope and prerequisite |
| --- | --- |
| P1 | After exact corrected-contract review: unwired coordinator/unique-symbol brands/WeakSet registries and focused unit controls. No consumers, ACK mapper or runtime acceptance |
| P2 | Independent chat dispatch record, post-await final gate and captured publication; Codex ticket/no second tracked leg, all post-entry UNKNOWN |
| P3 | Exact PTY native witnesses, chunk/Enter tickets and original wake pending command/earliest exposure; existing argv/wake policy unchanged |
| P4 | Claude stream/SDK private iterator and tracked-only Copilot transport/command gates; UNKNOWN only |
| P5 | Q5-owned delivery/wake/loss-claim consumers plus scoped grant/store/host bracketing after exact queue and proposed journal-API review |
| P6 | Admission-first original-owned Dispatcher work recovery, with visible chat preserved |

These are independently reviewable source/evidence boundaries, not authority to
implement all pieces or create six full-matrix PRs. Batch coherent delivery where
safe, run risk-targeted controls per exact integrated head, and retain independent
review of each changed authority seam. P1 does not prove missing consumer behavior.

## 11. Decisive future controls

These are required executable controls/mutants, **not tests run by this freeze**.

| Control | Exact evidence required; corresponding negative mutation |
| --- | --- |
| Direct/queued final gate | Hold real beforePrompt/causal awaits, revoke/reset before entry; zero calls and rejected candidate. Fresh claimed loss must commit actual unsubmitted; journal-owned cases append nothing. Remove post-1008 gate to make control fail |
| Brand/registry fabrication | Unique-symbol-only, structural, cloned and cross-coordinator fake handoff/ticket fail the sole WeakSet guard. P2/P3 actual ingress rejects before methods/driver with zero calls; unchecked-brand/shape-only mutant fails |
| Single loss owner | Direct/queued discard/teardown and repeated retirement converge; coordinator invokes `onLoss` at most once, result is informational, same claimed persistence promise reused. Caller-second-settle mutant fails |
| Journal ownership/exception | Held settle/recover, stale/released/consumed/terminal and already-entered sibling return journal_owned: no new mark/onLoss/append/retry after release. Unexpected marker exception is UNKNOWN, never blanket rejected; claimed loss commits actual coerced outcome |
| Independent dispatch state | Clear `pendingDispatch` while activation is held, then discard/reset; classify using actual entry marker, not queue slot. Slot-as-nonentry mutant fails |
| Early entry UNKNOWN | After marker, reject driver/native ticket, expire/remove queue or replace session; uncertain original coverage, zero automatic replay. Dropped-to-ready mutant fails |
| Codex second leg | First tracked steer rejects with both ambiguous and typed pretransport refusal after early marker; `turnStart` count stays zero. Catch fallback mutant fails |
| Claude image/SDK buffer waits | Revoke after image preparation and after push while SDK consumer is held; no later owned send/yield, entered attempt UNKNOWN. `finish()`-only/no-yield-check mutants fail |
| Private iterator compatibility | Retired tracked buffer is skipped even after `finish`; untracked queue behavior unchanged; SDK-already-yielded work receives no withdrawal/drain claim |
| Copilot native preparation | Hold command/image and commands.invoke/ensureProviderModel waits, retire captured SDK; no new tracked request/model/prompt effect. Untracked command behavior unchanged. Current-session-relookup/global-gate mutants fail |
| PTY chunks/Enter | Respawn same agent between every chunk/timer; no write/buffer observation against new native process, partial entry UNKNOWN. Agent-ID/PID-only witness mutants fail |
| Wake earliest exposure | Precheck refusals zero intent; original admitted intent before mission-bearing argv spawn or first original command flush; delayed resize/data uses same native witness. Write-only-when-argv-exposed mutant fails |
| Wake failure strength | Spawn/announce/pending command success is not accepted; no refund after possible submission. Spawn-success-as-ACK mutant fails |
| Receipt honesty | Void, queue push, SDK yield, native raw/cast Codex response, mode and size/liveness no-op cannot call ACK: initial all-backend outcomes UNKNOWN. No durable local-strength delta. Future approved mapper requires its own provenance/shape/error/late negatives |
| Historical ACK/UI split | For a future approved source or accepted journal fixture only, old genuine ACK after replacement settles original history, never replacement transcript/member/cursor. No initial backend mapper credit; current-member-gated ACK/mutable-session mutants fail |
| ACK source termination | Timeout/ignored late response is not fabricated ACK; original sink is released on terminal source, not leaked indefinitely; reopen cannot mint capability |
| Queue identity/coalescing | Latest-only/removal/expiry race preserves exact attempt/coverage; duplicate loss callback harmless, old member callback cannot adopt new generation |
| Scoped permission/ABA | Hold real grant store, host write and journal queues separately; revoke/rejoin/final equal IDs never revive old tokens; unrelated recipients remain admitted |
| Finite scope hold | Fake-clock deadline, denied/thrown/aborted draft and delayed stale completion release exact hold resources, expose failed/expired status and never restore old admission. Infinite/silent-hold and stale-reopen mutants fail |
| Work-only recovery | Admission closes before quarantine/preparation waits; captured old requests only; visible chat and held queue unchanged. Late global clear/current-request cancellation mutants fail |
| Resource ownership failure | Opening/close/kill failure and replacement cannot publish, restore old lease or clean up new resource. Generation/equality-adoption and global cleanup mutants fail |
| Main-only compatibility | IPC/tool input cannot construct handoff/ticket, legacy results/events/phone fixtures unchanged; no provider SDK internals or generic queue policy rewritten |

Risk-targeted checks and independent review must run on the exact eventual
integrated head under the existing desktop resource gate. No full local suite,
local E2E, live provider/phone actions, spending, grants or restart is authorized
by this document. Current source reading and documentation identity are not
executed runtime proof. Phone hidden-history privacy remains separately gated.
