# Native handoff ingress: independent source-bound admission design

**Verdict: APPROVE the bounded design boundary below for implementation/proof, not unseen code.** The reported native-ingress gap is confirmed at landed `70eff94e9042ccc304e68282e76afc9065497858`, tree `208fb893fcc36e7154efdb2df07206f85d65f6ed`. Optional original-request admission propagation and an actual incoming-promise owner can address it within the native handoff server route, `handoff-host`, `handoff-coordinator` and incoming `handoff-service` queues. No control protocol/cache, shared store, worker/grant policy, Details/Naming/Q5 or global shutdown framework change is justified by this boundary review.

This selects **queued/postauthorization admission**, not continuously revocable disk commit. A stale operation must refuse before its actual decision admission. An already admitted atomic save may finish with matching committed memory/history and ordinary committed-history notification; a completed native RPC result must not be changed into a false refusal after that save. Cancellation, deadline, transport publication and bounded replay remain distinct. Exact implementation, the host's separately owned baseline/controls, typing/lint and independent source/evidence review are still required before PR/hosted/landing acceptance.

## Exact inspection and source finding

Read exact landed blobs for server/control/authorizer, host/coordinator/service/stores, peer trust and network-member predicates. GitHub `gh` commit readback matches the supplied tree. Companion verification records all ten blob/size/SHA256 identities. The four3777 production files independently match `9a5247` byte-for-byte; that acceptance is retained. This finding is in the previously excluded **actual native route/ingress** seam, not a reopened verdict or claim of a reproduced user incident.

| # | Severity | Exact source anchors | Source-derived boundary gap | Confidence |
|---|---|---|---|---|
| NI1 | Medium | `annex-server.ts:3815–3829`; `handoff-host.ts:614–623`; `handoff-coordinator.ts:179–216`; `handoff-service.ts:117–129,152–175` | Native handoff route rechecks peer authentication before/after awaiting the host but passes no original request fence through queued work. Incoming host work has no stop-drained registration. Queue waits and the awaited new-offer admission can therefore outlive original request retirement without the proposed final admission check. | High, source-only; no new reviewer execution |

The transfer route (`annex-server.ts:3864–3882`) already demonstrates propagation of original-principal/`reverseRequestLive(req)` checks into content `beforeRead`. Outgoing response adoption's optional guard already runs inside `receiveSnapshot` (`handoff-service.ts:201–214`). Neither covers this incoming path today. `HandoffStore.transact:107–125` awaits the domain callback, then validates/saves and only afterwards publishes committed memory.

No product source/test edit, test/compiler/lint/CI/app execution or additional helper/access/login operation was performed. The host owns the one new actual-native-handler/real-store baseline; no duplicate reviewer test is requested.

## 1. Original native request capture

The new **guarded reverse-native** path should capture immutable original request identity before the body-read await: original principal/fingerprint/pin/via, original request object, original server instance/generation and relevant pinned peer/pairing trust. Use main-owned values, never an origin/identity field supplied in the JSON. Keep body cap/parser and initial mTLS/network-member checks unchanged.

The guard is a synchronous, negative admission test, with sticky retirement once observed. It must cover:

- the **original** `reverseRequestLive(req)` callback, which closes over that dispatch's link, cancel signal and deadline (`annex-server.ts:5090–5111`);
- current authorization of the fixed original principal through the existing authorizer and original machine membership, not a newly minted principal;
- original server identity/generation and original host identity/normal-stop state when domain work starts;
- original pin/pairing/trust continuity so a replacement or same-fingerprint re-pair is not silently adopted. `stillAuthorized` checks the fixed pin and current eligibility but does not itself compare all original role/pairing fields (`annex-authorizer.ts:112–117`; `annex-peers.ts:314–319`). Capture the needed existing trust scalars privately; do not log credential material, expose a new receipt or probe a peer.

**Direction matters:** client `getControllerReadObservation`/`getAcceptedLinkEpoch` observe the requester-side accepted connection. A reverse request served here arrives on a control connection **this server opened**. They are not substitutes for the original server dispatch resource. Do not check “a usable link exists now,” a cached snapshot, or a newly selected epoch and call that original-request currentness. Existing original link cancellation/closure signals are sticky; ordinary equality observations alone do not prove detection of every unobserved revoke-and-restore interval. Claims and tests must name the actual retirement signal/revision they exercise.

Use a pure check, not `ctx.requireMtls()` as the callback: the latter writes a refusal response as a side effect and is unsuitable as a repeated queue fence. After refusal, use the route's bounded existing error envelope without peer content, paths, task text or storage diagnostics.

Compatibility choice for this minimal slice: optional guards are undefined for existing local and legacy direct callers; the reverse-native handler explicitly opts into the guarded path. Preserve the direct branch's current routing and response semantics. Do not silently harden every direct/local entry point or claim a global drain. If the owner deliberately opts native direct calls into the same contract, describe that actual changed behavior and its proof in the candidate; optional defaults alone do not prove the direct route was unchanged.

## 2. Actual host incoming owner and stop/replacement

At `receiveNetworkHandoff` entry, capture the selected original host and create/register a host-local incoming owner **before its first asynchronous domain work**. Body reading precedes this domain entry and remains bound to the original native request/server; do not claim that an unstarted body reader already owns the host's storage queue. The owner combines original request check with exact host/machine identity and stopping state. It never replaces positive handoff authority.

Register the **actual promise** for `coordinator.receive` and everything it truly awaits, including queue waits/saves and normal committed-history callbacks. Keep it registered until actual fulfillment/rejection, even if the requester canceled, the route's response is destroyed at a deadline, or some outer caller stopped waiting. A reject also releases registration exactly once, and its original error still reaches the original handler. Do not register only a `Promise.race`/reply-abort promise, a transport waiter, the seen-cache retry promise, or the owner's own stop-completion promise.

`stopHandoffs` must close new incoming admissions synchronously, retire registered incoming owners, and wait for the actual registered writers as well as existing reverse writers before replacing their host/files. A rejected incoming operation must not cause early stop completion while another writer remains pending; drain settlement independently from each operation's success/error. `handoffHost` replacement admission must also account for incoming owners; guarding only `reverseSyncs` leaves the incoming writer gap open.

Already admitted save work must be allowed to finish. Do not call stop from an incoming queue callback, make an owner wait for stop while stop waits for it, or make drain depend on a requester retry/cache read. Guards perform no await/IO/driver action. Cleanup must not mask a committed result with a fresh throw or create an unhandled rejected `finally` clone. Any late IO failure remains that real error. A hung actual writer is not “drained”; report that liveness limit rather than release ownership or hand storage to a replacement early.

This is a narrow host-domain owner. Current `annex-server.stop()` is synchronous, increments server generation and tears down control (`:6502–6577`); it does not by itself prove an awaited handoff-storage drain. Do not claim all app/server shutdown, pre-capture legacy/local writers, workers, filesystem crashes or unrelated runtime work are covered. The new proof must identify the actual normal `stopHandoffs`/replacement boundary it exercises.

## 3. Every incoming service decision admission

Propagate one optional synchronous check through the coordinator to these exact service paths, without recapture. Caller checks remain useful before dispatch but are not the queued guard.

| Incoming operation | Required location / semantics |
|---|---|
| `receiveOffer` new ID | Check inside `transact` after queue acquisition. Retain the complete existing `admitIncomingOffer` capacity/expiry/incoming-availability/positive authorization decision. **Recheck after its await**, immediately before admitting the record. Queue-entry-only check is insufficient. |
| `receiveOffer` existing ID | Inside-queue check before the existing history-prefix/idempotent return. Preserve the existing permission exception for retrieving already known history; do not rerun new-offer acceptance grants merely to fetch it. |
| `receiveCancelledOffer` unknown ID | Guard inside queue; keep original source/sender/offer identity checks and original new-offer admission when current is absent; recheck after that awaited admission before committing cancellation. |
| `receiveCancelledOffer` existing/terminal/applying | Guard before its in-queue existing-record decision or early no-op return. Preserve existing cancellation/history exceptions and applying/terminal semantics; no fresh accept grant is invented. |
| `cancelAtReceiver` | Optional guard inside actual transaction before mutation/idempotent decision. Preserve exact sender/authenticated-machine/version/operation-ID checks and local default calls. |
| `receiveSnapshot` | Reuse the landed optional inside-queue `beforeAdopt` for incoming native calls as well. Cover newer and older-prefix paths without changing source/history validation. |
| Coordinator unknown terminal snapshot ACK sink (`:198–200`) | Check original request before this synchronous no-persist acknowledgement. It is a real acknowledgement decision even though no new store record is created. Preserve its retired-history behavior and no-new-notice rule. |
| Coordinator `applyCancellation` early current/terminal path (`:162–175`) | Check the original admission before an early returned decision and propagate it to `cancelAtReceiver` for queued mutation. Remote commands must not accidentally take the local-only command-removal branch. |

Postauthorization checks must cover **both** successful and refused asynchronous new-offer admission. If an awaited authorization produces `HandoffOfferRefused` while the original request retired before its final decision, do not convert that stale request into a receiver-authored failed-history result via the coordinator's typed-refusal catch. Guard after that await (including its rejection/typed-refusal branch) before admitting the refusal decision; propagate original retirement distinctly to the route's bounded error. Conversely, a validly admitted domain refusal may be returned truthfully even if transport retires afterwards.

A negative request/policy fence never replaces the complete original grant/admission evaluation. Fresh incoming offers legitimately depend on incoming enablement/receiver existence/connection/Dispatcher policy; existing known history and cancellation retain their documented exceptions after new-work permission withdrawal. If a fresh positive policy lookup can become stale across its own await (for example `acceptHandoffs`, target/config or connection changes while `localAgent` awaits at host209–217), the final **fresh-offer-specific** admission must retain a defensible current policy/negative lease check. Do not apply incoming-new-work policy to every ACK/cancel, borrow the outgoing fresh-sender helper as a general permission, or claim the route's principal check alone proves application grants remained current. Keep such a check within the scoped host/service boundary and disclose exactly what original positive decision and existing change evidence it uses; no new collection/probes or grant-store policy changes.

### Existing maintenance is separate from the incoming message

`coordinator.receive('offer')` currently awaits `expireOffers()` and `prune()` before dispatching `receiveOffer` (`:185–187`). Those can independently maintain existing records/commands. Specify them honestly: the minimal contract may retain this preexisting **separately admitted local maintenance** under the actual incoming owner's lifetime, then recheck the original request after those awaits before its message decision. In that model, a refused incoming offer makes no incoming-message history mutation, but already admitted legitimate expiry/prune may still change unrelated retained history. Tests must not assert “the entire store never changed” while allowing that maintenance.

If instead the candidate promises to gate every maintenance write on request currentness through its own queue, it must supply actual owning-queue guards, including store/command prune; a coordinator-only check cannot provide that stronger promise. Do not silently add shared storage files to this four-file slice. No maintenance relocation, global no-write claim or policy change is approved merely by the incoming-message guard.

## 4. Exact admission/commit and native RPC result semantics

The following is the compatible contract:

1. **Before final actual queue/postauthorization admission:** retirement refuses the incoming decision; no new message-driven history/version or notice. Other unrelated work remains eligible. Guarding only outside `transact` or only before `admitIncomingOffer` does not satisfy it.
2. **After final decision admission:** the existing atomic save may finish after cancellation/link loss/host stopping. Success must publish matching committed memory/history and return its actual result. No post-save guard may report that the save failed, restore old disk/memory, or invent zero delivery.
3. **Normal notice:** only committed authoritative history enters the existing local notification path. It may notify after retirement under normal eligibility; this is not attempt-scoped final-sink or provider ACK proof.
4. **Native guarded route after successful resolution:** finish its actual domain response. In particular, do not execute the old post-await `requireMtls`/membership branch at3815–3829 in a way that replaces an admitted commit's result with403/400 solely because the original request retired. Current wire authorization still belongs to the existing control layer; this does not authorize output to a revoked requester. Direct legacy behavior is kept separate.
5. **Real IO error:** surface the actual bounded failure and preserve existing storage failure/ambiguity behavior. An IO exception may coexist with a replaced disk file; no fake success, rollback or no-effect claim.

The exact RPC comment referenced as5131–32 is now **`annex-server.ts:5140–5141`**. `dispatchReverseRequest` destroys the response only at deadline (`:5142–5143`), not simple requester cancellation. Thus:

| Event | Existing RPC behavior to preserve |
|---|---|
| Requester cancels / original connection closes **before admission** | Original `ctx.signal`/link fence becomes false; domain operation refuses before admission. The old requester receives no output. If the handler completes its bounded refusal before deadline, that actual refusal can be retained for same-key retry. |
| Requester cancels / link closes **after admission** | `runOnce` cancels the waiter but the actual handler may finish; actual admitted save/result may complete. Do not inject a new post-save currentness refusal. A complete response can be retained; no response is sent to the closed/canceled old requester. |
| Principal loses current access | Existing outer control `onRequest:817–822` refuses current wire publication. Do not bypass it or use a domain commit as fresh authorization. Cache availability is separately bounded by the existing peer/pin/cache lifecycle. |
| Deadline cuts response off | `ReverseResponse.destroy` prevents a late `end` from making it complete. The domain save may still settle, but `retainedForRun` stores `not_retained` for an incomplete response; same-key retry gets `replay_unavailable`, never a fabricated ACK or automatic second run. |
| Same authorized peer+pin, same request ID and digest within cache | Existing `runOnce:937–953` waits for/replays its original stored result; no second native-handler/domain operation. A different digest gives conflict. New link readiness does not re-admit the old operation. |

Control's active run slot remains owned until actual dispatched work and declared `operations` settle (`annex-control.ts:853–888`), independently of requester waiting. The minimal native handler can simply await the actual incoming promise; if any route work is deliberately detached, it must be registered with `ctx.trackOperation` as its **actual** promise, not an early race. Do not release a slot/host writer on cancellation or treat all-settled drain as operation success.

The cache is **not durable exactly-once delivery**: key includes original fingerprint+certificate pin+request ID (`:407–408`); digest includes method/path/content-type/decoded body (`:468–473`). TTL is10minutes, max512entries per peer, response retention1MiB; finished entries can be evicted. Peer forgetting/new pin/server target stop can invalidate retention, and `setControlTarget(null)` clears it (`:361–366`). Domain immutable offer/cancellation IDs/history remain essential beyond that cache window. Do not alter cache/timeout/protocol behavior or claim arbitrary restarts/re-pairing preserve RPC replay. “May leave a completed cached result” is conditional on these existing limits.

## 5. Required finite controls for the host's candidate

The host owns and is constructing the single new native-handler baseline; reviewer requests no duplicate execution. Before exact source/proof acceptance:

- Use the **actual native route/dispatcher plus real stores**, not another hand-built handoff dispatch adapter. Hold an earlier actual history queue job, allow the valid incoming operation to reach its wait, retire its original request/link before admission, release, and show the landed baseline's missing fence versus corrected refusal/no incoming-message mutation. Keep original raw failure; downstream baseline assertions are uncredited.
- Positive native current request with actual domain/history receipt, unrelated peer/agreement liveness, current idempotent older/existing-record paths, and snapshot/offer/cancel/cancel-with-original-offer branch coverage. No authority inferred from transport readiness.
- Retire during a held new-offer positive-authorization lookup and typed-refusal lookup; test after-await guard placement, policy withdrawal without breaking existing-history/cancel exceptions, and separate original principal/pin/pairing/server/host replacement from mere current readiness. A queue-check/postauthorization-check removal mutant should fail meaningful no-admission assertions.
- Separately hold an already admitted real save, cancel/retire, release, and verify matching disk/committed memory/normal notice and truthful completed RPC result where the response was not deadline-destroyed. No post-save guard may fabricate403/400. Keep precommit versus after-real-rename IO faults separate.
- Prove actual request cancellation versus deadline semantics: same-key retry waits/replays a completed retained answer without a second domain invocation; deadline-incomplete result is not retained as success, and slot/owner stay held until actual work settles. Test the existing conflict behavior rather than changing it. Disclose any fixture authority/context/timer boundaries; do not turn a mock context into native TLS authentication proof.
- Normal host stop while incoming work is queued and while its save is admitted: refuse new admissions, block replacement until actual registered writers settle, keep rejection/unrelated queue progress and cleanup correct. No owner/self-stop/cache-wait cycle or early drain. Original direct/local/outgoing defaults and the already accepted3777 controls remain unchanged.
- State the maintenance model and test the promised per-message invariant rather than an unimplemented global no-write invariant.

Independent review remains necessary for the exact implementation and execution receipts. This report approves this bounded engineering contract, not a particular unseen API/signature, helper reuse, selected implementation or broader caller activation. No new product choice, access or routine GO is needed to work within it.

## Preservation and limits

No accepted3777 source/proof or74d lower proof was rerun or expanded. Original failed runs, compiler scopes and unexplained historical timeout limits remain intact. No worker/real grant/preparation/Git/apply/wake/native-provider/human-gate/full-handoff acceptance is transferred.

Private Q5 WIP stays clean on `auto-reset-policy-design/q5-framed-root-journal-wip`, head `079a257acf38b168b529fb7745dae97f686b72b8`, tree `89e942aabd42c8ec93fe47794f2eef95b0b61980`. Original Details worktree, named identities and all preserved evidence refs remain untouched. Only this report and immutable source verification are published on a separate QA task branch using the existing authorized gh route.
