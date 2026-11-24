# Handoff reverse scheduling: source-bound proposal, not implementation

Read-only source checkpoint: `c2a59f9f2c872bf2cb1fe9852adf8c92f2a996fc`.
Containing predecessor/proof: `be01f8bd511dba2a625462021732c119ce6b170e`.
Its exact executable source remains `a4074c7f5e76714bbe346ecee1acfc434307de0e`.
This artifact changes no production/test/proof source and executes no validation.
The proposal needs exact boundary review **before production edits**. The prior
81,937-byte envelope remains transport-only, and the newer paired transfer proof
does not cover host/coordinator scheduling, grants or product acceptance.

## Observed chain and actual gap

`handoff-host.ts:326` supplies `connected = isNetworkComputer &&
isMachineConnected`; client909–912 defines the latter as raw direct state only.
`handoff-coordinator.ts:239/247` uses this predicate before sending and before
reply adoption. Thus an authorized accepted reverse request link can transfer
bytes while an ordinary outgoing offer/snapshot never reaches the already
reverse-capable host `postToMachine` callback.

The host posts the existing `/api/v1/network/handoffs` JSON envelope with
512 KiB receive limit and the existing5-second `withCapacityDeadline`.
`requestSatelliteRaw` selects direct first, otherwise eligible reverse, and owns
the request's trust, connection/accepted-link epoch, signal and request ID. Its
lease ends before the coordinator's later async authorization and storage work.
A replacement's *current* availability therefore cannot attest the original
coordinator attempt. No route fallback or fresh epoch may silently continue it.

Original ordering and semantics that must remain:

| Boundary | Source and meaning |
|---|---|
| Offer/outbox | Coordinator83–103 marks undelivered and binds preparation before making the offer visible; preparing/cancellation/sync maps serialize same-ID work. |
| Never-attempted cancel | Coordinator125–150 uses durable undelivered/removed-peer proof to cancel locally. Uncertain/attempted delivery instead retains the same cancellation operation ID. |
| Grant admission | Host331–346 denies a fresh outgoing offer without its current sender grant and connection/Dispatcher target. Non-offered authoritative history remains queryable. A durable pending cancellation retains the original exception to the fresh-offer gate. |
| Attempt marker | Coordinator241–245 persists `markAttempted` before transport. Command-store87 removes the undelivered marker only after its atomic queued save. Failure/stale route must not restore undelivered or pretend no attempt occurred. |
| Response | Original parse/id/source/history-extension checks remain; a refusal is receiver-authored failed history, not a synthetic success. Receiver snapshot ACK and sender snapshot adoption have distinct branches. |
| Adoption/ACK | Coordinator247–278 awaits authorization, then may await service/store/command queues and secondary cancellation posts. Service201–216 checks source and extension inside a serialized transaction. Store124–140 admits, saves and then publishes committed memory. |
| Retry/lifetime | `syncing` single-flights each ID; trySync retains durable work on failure. Flush reserves at most10 slots, prioritizes active work and retains history ACKs. Host429–447 single-flights a30-second sweep; stop removes the listener/timer and awaits owned sweep work. |

The host's existing direct-connect listener cannot announce request-only reverse
readiness. The existing periodic sweep is nevertheless an available bounded
wake-up; no new event API/timer is necessary to make retained reverse work usable.

## Recommended smallest coherent change

Keep `isMachineConnected`, direct reach/publication, all global connectivity
consumers and the original `connected` legacy behavior unchanged. Add a
**handoff-local, captured reverse-sync admission**, rather than replacing
connectivity with authority:

1. Host: only when direct is absent, require existing network-computer membership
   and `getControllerReadObservation(peer).ready`. Capture its revision plus the
   original host instance. Recheck that same observation, absence of direct,
   membership and host instance at every later admission. The observation already
   incorporates accepted-link epoch and full pinned peer trust; it grants no
   handoff or snapshot permission and requires no accepted snapshot.
2. Coordinator: an optional reverse-admission callback leaves existing constructor
   callers/direct behavior untouched. Capture once before the first authorization
   await; do not recapture after a failed check. Retain the complete original
   authorizeOutgoing decision and cancellation exception. Check the captured
   route after authorization, after the attempt-marker await, before each
   primary/secondary POST and after each async authorization before adoption/ACK.
   A retired attempt rejects into the existing durable retry path; a future
   bounded invocation may capture a new route.
3. Host POST seam: bridge the same admission check into the
   `withCapacityDeadline` operation immediately before `postToMachine`, because
   that helper schedules its operation in a microtask. Preserve signal/deadline,
   statuses,512 KiB limit, route and logical offer/cancellation identities.
4. For **reverse fresh sender offers only**, reuse the existing host
   `transferAuthority` revision/binding lease as a *negative invalidation fence*
   around asynchronous grant/target lookup. A positive original grant decision
   is still mandatory. It must not become a positive permission, apply to
   grant-independent history queries, or erase the pending-cancellation exception.
   Its owned subscriptions require disposal following actual owned work, including
   timed-out work; do not release merely because a deadline caller stopped waiting.
5. Service adoption seam: pass an optional reverse `beforeAdopt` check into
   `receiveSnapshot`, invoked **inside** its queued transaction before accepting
   either newer history or an older-copy acknowledgement. Checking only before
   calling the service misses a store-lock wait. Other callers remain unchanged.
   Check before coordinator ACK/command-removal admission and before notices too.

Proposed production files: `handoff-host.ts`, `handoff-coordinator.ts`,
`handoff-service.ts` only. Existing host/coordinator tests and the bounded paired
fixture cover the delta; related desktop documentation is updated. No client,
control, protocol, cap, grant-store, snapshot/apply/worker, renderer, Naming,
federation or selected-board changes are proposed.

Scheduling initially preserves the existing listener,30-second sweep, single
flight and10-slot budget. An offer made while reverse is already eligible can
send immediately through its existing trySync; newly eligible retained work
sends on the next ordinary sweep. This explicitly does **not** promise immediate
request-only readiness notification. Do not add snapshot-triggered global flushes
or a new poller simply to hide that bounded latency.

## Boundary dispositions required before edits

The existing `transferAuthority` is source/content-oriented. Its fresh reverse
offer use must be reviewed against original host grants/connection/Dispatcher
semantics; a helper reuse that imposes an unrelated receiving-server/acceptance
requirement is not acceptable. If its predicates cannot be reused unchanged for
that operation, stop with the exact mismatch rather than invent a weaker lease.

The proposed service check is **queued adoption admission**, not cancellation of
an already admitted atomic disk commit. A link/host change during the subsequent
save cannot be made safe by dropping committed memory while leaving newer disk
state, rolling back a durable receiver decision, or claiming the save never
happened. Existing command ACK saves have the analogous queue/admission boundary.
If acceptance requires liveness through actual disk publication rather than
admission, this three-file scope is insufficient: independent review must resolve
that stronger storage/ACK contract before any change. No generic transport token
is asserted to revoke authenticated authoritative history already admitted.

Likewise, existing direct post/adoption behavior and unrelated optimistic ACK
ordering are not silently repaired. The narrow new reverse branch must not add
stale adoption, but this artifact is not a blanket coordinator correctness claim.

## Finite proof after boundary approval (not executed)

Use real coordinator/service history and attempt/command stores over the already
permitted Node pinned pair; preparation, grant/dispatch/app boundaries stay
explicit fixtures where necessary. A genuine baseline discriminator is a valid
reverse-only queued offer that never calls POST under the original host gate,
even though request capability is ready; its candidate must deliver/adopt valid
receiver-authored history while direct remains false.

Focused controls: request-only capability without snapshot; old/no-control peer
unchanged; revoked sender grant/connection before and during held lookup; retire
after attempt persistence but before send; no undelivered-marker restoration;
old response held across epoch/trust/host replacement; wait inside adoption
transaction; pending cancellation despite revoked fresh-offer grant; refused/
conflicting history; expired signal; secondary cancel cannot reselect a new
epoch; sweep single-flight/10-slot preservation and unrelated eligible work.
Prove exact no-POST/no-adoption/no-ACK outcomes, retained original IDs/history and
durable retry rather than testing a coarse ready boolean.

The paired sender can retrieve receiver decisions by its existing immutable-offer
retry; that does not itself prove receiver-originated push, apply/wake, both-host
app behavior or full duplex. Freeze the exact delta/proof for independent review
before a coherent proof+fix PR. No separate fullmatrix/PR/CI is started here.
