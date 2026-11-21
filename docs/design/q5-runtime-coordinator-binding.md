# Q5 runtime coordinator binding: source-bound proposal

Status: **frozen design for independent interface and hunk review, not implementation approval**.
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
can supply, deserialize or adopt them. The coordinator retains no prompt content,
durable coverage or driver methods. A transport ticket retains only immutable
token identities and revocation state, not a driver/session or ledger closure.

Frozen structural interface proposal, not implemented source:

```ts
type RuntimeLease = RuntimeLiveLease | RuntimeDormantLease;
type RuntimeLoss = 'unsubmitted' | 'unknown';

interface RuntimeTransportAdmission {
  readonly dispatchId: RuntimeDispatchId;
  readonly resource: RuntimeResourceId;
  allowed(): boolean;
}

interface RuntimeHandoff {
  readonly dispatchId: RuntimeDispatchId;
  tryEnter(): boolean;
  lost(outcome: RuntimeLoss): Promise<void>;
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
      kind: 'provider_ack';
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
  markEntered(): boolean;
  onLoss(outcome: RuntimeLoss): Promise<void>;
  onReceipt(receipt: RuntimeHandoffReceipt): Promise<void>;
}
```

`RuntimeDispatchId`, `RuntimeResourceId`, leases and transition handles are opaque,
main-created values. A display string or UUID does not let a caller reconstruct
one. The implementation must keep exactly one owner-defined runtime generation
per logical local agent within the main process, regardless of runtime kind.

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
  captureLease(agentId: string): RuntimeLease | undefined;
  captureAdmission(scope: RuntimeAuthorizedNoticeScope): RuntimeAdmissionLease;
  closeAdmission(admission: RuntimeAdmissionLease): void;
  holdScope(scope: RuntimeAuthorizedNoticeScope): RuntimeAdmissionHold;
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
  retireHandoff(handoff: RuntimeHandoff): RuntimeLoss;
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
Q5's `lost`/`observe` persistence is deliberately awaitable outside the entry hook:
failed journal writes remain visible failures/uncertainty, never an accepted
default, an automatic retry or a silently swallowed acknowledgment error.

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
   scoped permission. Only then may it call `markHandoffEntered`.
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
| Proven final refusal before entry | `unsubmitted`; no adapter call and no native write |
| Successfully marked chat adapter entry | Any subsequent rejection, transport refusal, reset, discard, loss or timeout is `unknown` |
| Live PTY before first actual message write | Final admission/refusal can still prove `unsubmitted` |
| Live PTY first write marked/called, including only a paste prefix | Any later loss/refusal is `unknown`; preventing Enter does not undo earlier entry |
| Wake mission exposed in native argv at process creation | Mark before the first mission-bearing spawn; failure/loss afterward is `unknown` |
| Wake mission retained only in the original pending command | Final gate/marker precede first command write; any earlier mission exposure overrides this later boundary |

The sealed `tryEnter` hook performs only the exact accepted synchronous journal
primitive after final guards. No IO, arbitrary driver access or post-mark work is
allowed inside it. A false result proves non-entry under that contract.
An independently proven guard throw before the marker also proves non-entry.
An ambiguous/nonconforming throw that might follow marking is UNKNOWN, never a
string-matched pre-entry exception. Journal arbitration additionally coerces an
entered attempt's `unsubmitted` to `uncertain`, even after capability release;
runtime/publication state must not depend on that backstop to make false claims.

**Once early entry is marked, there is no automatic second Codex transport leg.**
Even typed evidence that the first steer was refused before transport cannot undo
the ledger entry or authorize `turnStart` for that same attempt. Existing untracked
driver fallback may retain its current behavior; tracked attempts must not execute
the `send:523-536` catch-and-retry branch. `turnSteer:170-174` currently constructs
an ordinary `Error` for no active turn: it is not a typed settlement capability.
No exception-string matching, ambiguous catch fallback or equal-session adoption.

## 5. Receipt strength, provenance and historical settlement

`observe` distinguishes **local input handoff** from **genuine provider ACK**.
Neither proves model processing, completion, exactly-once execution or drain.

| Observed source | Permitted fact | NOT permitted |
| --- | --- | --- |
| PTY process write returns | Local write invocation; full guarded paste/submit completion may report `local_handoff/pty_input` | Provider ACK, processing or acknowledgment from a liveness/size no-op |
| Claude stream void send/stdin write | Local `stream_stdin` handoff when the exact writable original child was actually used | Provider ACK or inferred CLI acceptance |
| Claude SDK queue push | Local buffering only | Input consumption, provider ACK or withdrawal after SDK yield |
| Guarded SDK iterable returns exact input to SDK consumer | `local_handoff/sdk_input_consumed` | Provider acceptance/processing or cancellation of SDK-internal work |
| Driver resolves `'prompt'`, `'steer'` or `'queued'` | Delivery mode only | Genuine ACK or automatic journal acceptance |
| Successful runtime/resource spawn | Process/resource creation only | Mission ACK, budget refund after possible submission or accepted notice |
| Exact original Codex request receives a successful validated response | Correlated provider-protocol ACK of that request | Turn/model processing, global cursor advancement or replacement UI authority |
| Copilot SDK `.send` resolves | SDK call resolution at the currently inspected source | Provider ACK unless the exact SDK/provider result semantics and request correlation are independently verified |

**This freeze does not broaden journal `accepted` to include local handoffs.**
Q5 calls `acknowledgeLiveHandoff` only for the genuine original same-process ACK
allowed by its accepted contract. A weaker receipt can be recorded truthfully,
but cannot be converted into accepted coverage. Backends lacking a reviewed ACK
source remain UNKNOWN after entry and are not auto-replayed. This is a disclosed
acceptance limitation, not synthesized all-backend readiness.

Claude currently sends no owned request correlation in `toWireUserMessage`, and
its driver ignores `user_message` echoes (`1062-1064`). Echo/content matching does
not mint a capability. Copilot currently discards `.send` results. Those sources
need separate exact provider-result/correlation proof before being credited.
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
| Copilot driver `494-533` | Recheck after `commandIn`/image awaits with captured original SDK, closing/finished checks; gate command invocation too, including asynchronous `runCommand` effects if admitted |
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
| `src/main/chat/copilot/driver.ts:494-533,680-709` | Host: post-await exact SDK/ticket checks and honest receipt strength |
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

## 11. Decisive future controls

These are required executable controls/mutants, **not tests run by this freeze**.

| Control | Exact evidence required; corresponding negative mutation |
| --- | --- |
| Direct/queued final gate | Hold each real `beforePrompt`/causal await, revoke/reset before final entry; zero provider calls and proven unsubmitted. Remove post-`1008` gate to make control fail |
| Independent dispatch state | Clear `pendingDispatch` while activation is held, then discard/reset; classify using actual entry marker, not queue slot. Slot-as-nonentry mutant fails |
| Early entry UNKNOWN | After marker, reject driver/native ticket, expire/remove queue or replace session; uncertain original coverage, zero automatic replay. Dropped-to-ready mutant fails |
| Codex second leg | First tracked steer rejects with both ambiguous and typed pretransport refusal after early marker; `turnStart` count stays zero. Catch fallback mutant fails |
| Claude image/SDK buffer waits | Revoke after image preparation and after push while SDK consumer is held; no later owned send/yield, entered attempt UNKNOWN. `finish()`-only/no-yield-check mutants fail |
| Private iterator compatibility | Retired tracked buffer is skipped even after `finish`; untracked queue behavior unchanged; SDK-already-yielded work receives no withdrawal/drain claim |
| Copilot native preparation | Hold command/image wait, replace or close captured SDK; no request/command reaches new SDK. Current-session-relookup mutant fails |
| PTY chunks/Enter | Respawn same agent between every chunk/timer; no write/buffer observation against new native process, partial entry UNKNOWN. Agent-ID/PID-only witness mutants fail |
| Wake earliest exposure | Precheck refusals zero intent; original admitted intent before mission-bearing argv spawn or first original command flush; delayed resize/data uses same native witness. Write-only-when-argv-exposed mutant fails |
| Wake failure strength | Spawn/announce/pending command success is not accepted; no refund after possible submission. Spawn-success-as-ACK mutant fails |
| Receipt honesty | Void, queue push, SDK yield, delivery mode and 64 KiB size/liveness no-op cannot call journal ACK; only genuine original provider response can |
| Historical ACK/UI split | Old real ACK after runtime replacement settles only original same-process journal attempt; replacement transcript/member/cursor untouched. Current-member-gated ACK and mutable-session emit mutants fail |
| ACK source termination | Timeout/ignored late response is not fabricated ACK; original sink is released on terminal source, not leaked indefinitely; reopen cannot mint capability |
| Queue identity/coalescing | Latest-only/removal/expiry race preserves exact attempt/coverage; duplicate loss callback harmless, old member callback cannot adopt new generation |
| Scoped permission/ABA | Hold real grant store, host write and journal queues separately; revoke/rejoin/final equal IDs never revive old tokens; unrelated recipients remain admitted |
| Work-only recovery | Admission closes before quarantine/preparation waits; captured old requests only; visible chat and held queue unchanged. Late global clear/current-request cancellation mutants fail |
| Resource ownership failure | Opening/close/kill failure and replacement cannot publish, restore old lease or clean up new resource. Generation/equality-adoption and global cleanup mutants fail |
| Main-only compatibility | IPC/tool input cannot construct handoff/ticket, legacy results/events/phone fixtures unchanged; no provider SDK internals or generic queue policy rewritten |

Risk-targeted checks and independent review must run on the exact eventual
integrated head under the existing desktop resource gate. No full local suite,
local E2E, live provider/phone actions, spending, grants or restart is authorized
by this document. Current source reading and documentation identity are not
executed runtime proof. Phone hidden-history privacy remains separately gated.
