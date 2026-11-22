# Handoff reverse synchronization: independent boundary review

**Verdict: CHANGES REQUESTED on the frozen three-file contract at `a9bc18116af5b0e7b6467601d323fccfad23d85c`.** The host-local captured reverse admission, mandatory existing grant decision, fresh-offer negative fence and serialized service adoption are sound directions. One concrete scope/ordering correction is required before product implementation: reverse ACK and cancellation-command removal need admission checks **inside the actual command-store queue**, and the new branch must not publish a refused queued ACK optimistically. The smallest correction adds `handoff-command-store.ts` as a fourth production file, with optional main-only guards and unchanged legacy/direct defaults. No shared settings-store, transport, protocol, global connectivity, grant policy or disk-rollback redesign is needed for the selected admission contract.

This is a design/security boundary verdict, not source implementation or execution approval. The separate composed transfer proof remains APPROVED in [74d2ed4](https://github.com/Agent-Clubhouse/Clubhouse/blob/74d2ed4f64c1e9d539339e5a75b7c3c31171e8b3/docs/qa-transfer/2026-11-22/reports/reverse-handoff-a407-independent-review.md); none of its fixture evidence proves the new host/coordinator/queue behavior.

## Exact inspection

- Design `a9bc18116af5b0e7b6467601d323fccfad23d85c`, tree `ea27d2d13024e4098081e30d1afce9eeb3036227`.
- Source checkpoint `c2a59f9f2c872bf2cb1fe9852adf8c92f2a996fc`, actual tree `33d3dfed92deaa3e159a46f41d79ce8287149ba8`.
- Full [README](https://github.com/Agent-Clubhouse/Clubhouse/blob/a9bc18116af5b0e7b6467601d323fccfad23d85c/docs/evidence/3613-handoff-sync-design/README.md), blob `82296bd3710911e38b019bd26ceede8f7e93b81c`, SHA256 `b0592144eb93e3b629d5815394c9e64129803c87aa7e4a8122e0ad74140bad5a`.
- Full source map blob `bf912a9d99b7f4fd7fcd1a8e1bce812ed7fed8d9`, SHA256 `52c0fd99b4593c091e3baf0ac3e232429e37e736cfb92b0d566544e7fca92686`.
- Independently checked every one of its ten source/test identity entries against immutable base/source blobs, sizes and hashes. The exact design adds only README/source-map beyond `be01f8bd511dba2a625462021732c119ce6b170e`; production and proof fixtures are unchanged. GitHub `gh` commit readback matches the supplied design tree.
- Read actual host, coordinator, service, stores, deadline helper, client observation/request lease and relevant grant/default helpers. Map line ranges are approximate (for example current `handoff-store.transact` is107–125); the actual matched blobs, not old line numbers, anchor the conclusions.
- No product/test/source edit, test/compiler/lint/app/CI execution, account/login/grant operation or remote helper access by reviewer.

## Required correction

| # | Severity | File / lines | Boundary gap | Confidence |
|---|---|---|---|---|
| D1 | Medium, design prerequisite | Design README76–83,103–115; actual `handoff-command-store.ts:61–71,82–89`; coordinator247–272 | Checking captured admission only before calling ACK/removal does not cover their private queued wait. The three proposed production files cannot place the check inside that queue. In addition, existing receiver-branch `acknowledged.set` at coordinator256 occurs before the awaited command ACK; copying it into the new guarded reverse branch would publish an ACK even when the eventual queue guard refuses. | High, directly source-derived; no executed candidate exists |

Concrete failing ordering: an unrelated command-store mutation holds its queue; a valid reverse reply reaches the coordinator and passes its current check; `acknowledge` or `remove` queues behind that mutation; the original host/link/trust admission retires; the earlier mutation releases; today's unguarded queued updater then persists the ACK/removal. A caller-only check cannot distinguish this from work admitted while still current. This is the same queued-wait issue the proposal correctly fixes in `receiveSnapshot`, not a demand that transport stay live throughout already admitted I/O.

Minimal correction:

1. Extend the coordinator-owned `HandoffCommandStorage` contract with optional synchronous main-only admission callbacks for the reverse response-driven `acknowledge` and `remove` operations. Add corresponding optional handling in `HandoffCommandStore.change` so each guard executes **after acquisition of that store's existing queue and before the updater or save is admitted**. Guard refusal must leave that operation's command/ACK state and disk untouched. Undefined guard leaves current callers/direct/local behavior identical. Do not serialize callbacks or expose them over the wire. A separate equivalent guarded command mutation API is acceptable if it has the same queue/ownership semantics.
2. Pass the **same original attempt** check to each response-driven reverse ACK and removal, including primary terminal-history cleanup and each secondary-cancellation reply. No route recapture. A successful prior history adoption does not automatically authorize later command deletion; each is a separate admission into its own queue.
3. In the **new reverse receiver-ACK branch**, stage the in-memory `acknowledged` update until its guarded durable ACK operation succeeds. Do not set it first and then leave it advanced after guard/save refusal. Once that ACK is admitted and successfully committed, publish its corresponding memory result even if the route subsequently retired. Do not rewrite unrelated legacy/direct optimistic ACK behavior as part of this slice.
4. Update the frozen scope to four production files plus focused tests/docs. The shared `settings-store` implementation need not change. No broad storage lock framework is justified by this finding.

## Chosen admission / commit contract

The proposal's weaker, implementable **queued admission** contract is acceptable; continuous transport liveness through rename/fsync is neither necessary nor established.

- **Service admission:** the original synchronous reverse check runs inside the serialized `receiveSnapshot` transaction, before either older-prefix/no-op acceptance or newer history is accepted. Parsing/source checks and full history extension checks stay intact. The check must not introduce an await between validation and the admitted decision. Current store `await change(...)` and subsequent save may yield; that does not retroactively revoke the decision already admitted under the queue.
- **Command admission:** the corresponding synchronous guard runs inside the command queue before its mutation, as D1 requires. Enqueueing a request is not the promised queue-execution admission.
- **Before admission:** retired original capture throws/refuses; no history/ACK/removal is admitted, no false receipt is published, and original durable work remains available to an ordinary future invocation.
- **After admission, before/during save:** retirement may occur. The already admitted atomic save may finish. Successful completion publishes matching committed memory and returns that committed result; no post-save currentness exception may pretend the commit did not happen or drop only its memory. A separately admitted ACK or later send/notice may still be refused. Already authenticated/admitted authoritative history may therefore become durable after link retirement. The contract must say so plainly.
- **Write failure/ambiguity:** preserve the actual storage error and existing committed-store behavior; never synthesize ACK, restore “never attempted” merely because an attempt failed, or infer absence of a durable effect from a generic transport/IO error. No compensating rewrite/rollback of a receiver's authoritative decision is proposed. Do not erase useful durable history to satisfy a stale-route assertion.

These rules assume the existing actual store/command queue remains the mutation owner. A replaced host must not be treated as a new independent writer entitled to bypass pending admitted work on the same files. This review does not prove global cross-instance locking or crash/power-loss atomicity. Tests should distinguish “retired while waiting for queue admission” from “retired after admission while its save is in progress”; those two outcomes intentionally differ.

## Authority-helper compatibility: accepted narrowly

At the exact `handoff-host.ts:196–246`, `transferAuthority` can be reused unchanged as a **negative fence for fresh outgoing sender offers**, provided the scope test is exact: original local sender, remote destination, offered record, reverse attempt, and no pending cancellation taking the preserved exception.

For that case:

- `agents` contains only the local sender because no acceptance exists; there is no lookup/requirement for a receiver acceptance or receiver saved grant.
- The incoming-server/`acceptsRemote()` condition is guarded by `record.from.machine !== ownMachine()` and therefore does not constrain this local-sender case. A local server/acceptHandoffs toggle must not become a new prerequisite for making a permitted outgoing offer.
- Remote destination/peer membership checks match the existing network-peer boundary. A concrete agent target needs the existing connection; a `via: dispatcher` target is not subjected to that agent-connection check. Original `peerTarget`/grant evaluation remains the positive authority and handles Dispatcher semantics.
- Captured grant revisions/config generation, relevant binding membership/permission stamps and sticky notifications detect changes through asynchronous lookup. The broad connection-notification invalidation can conservatively end an attempt even for an unrelated change; that is refusal/retry behavior, not a new permission. It does not replace full `authorizeOutgoing` or invent authority for sleeping agents; original running-vs-durable positive grant lookup remains intact.

Do **not** install this fresh-offer fence for grant-independent history/status or a pending cancellation that the original full authorization expression permits despite a revoked fresh-offer grant. Keep the full original authorization call and its current pending-command exception; never substitute “lease exists/check passed” for a positive grant decision. Do not generalize reuse to incoming or post-acceptance/content flows under this review.

Required discriminators include a fresh permitted Dispatcher destination with receiving-server/acceptHandoffs off, a permitted ordinary connected target, an unconnected ordinary target refused by original policy, revoked/restored grant or binding during a held lookup, and cancellation/history after fresh-offer grant withdrawal. They are proposed tests, not results already obtained.

## Original capture and owned lifetime

The proposed handoff-local optional reverse admission preserves direct semantics and avoids redefining global `isMachineConnected`. Capture reverse readiness revision plus original host once, only with direct absent; later checks require the same ready revision/host/membership and direct absence. Existing observation contains pinned trust and accepted epoch and existing reverse readiness gates; it does not mint a snapshot receipt or grant handoff permission. Keep direct preference and the adapter's request-only route/caps/deadline. Missing reverse capability must refuse, not dial or fall back after failure.

The microtask seam is real: `withCapacityDeadline` schedules `operation` with `Promise.resolve().then(...)` (capacity13–25). The captured check and expired-signal check must execute in that actual operation immediately before `postToMachine`, not only before calling the wrapper. Each primary and secondary POST uses the same capture; failures end this invocation. A subsequent normal invocation may capture a new epoch while preserving logical offer/cancellation IDs and durable history.

The existing deadline is a **race**, not a drain. Name one concrete owner in the implementation for the fresh-offer lease/subscriptions and any pending operation. Outer `withCapacityDeadline` rejection cannot dispose ownership while the actual operation still runs. A workable implementation can retain ownership for the posted operation before scheduling it and release it from the actual operation's settlement, with the enclosing sync releasing only its own hold. Equivalent scoped ownership is acceptable. There must be exactly one final disposal after all actual owned work, including queued adoption/ACK work, settles; never leak listeners or clear a lease so a stale continuation becomes valid. Retired checks stay sticky; disposal is not reauthorization. No shared deadline-helper modification is required merely to track the operation locally.

Preserve the attempt marker: after `markAttempted` resolves, recheck before any POST. If it has already removed the undelivered marker and the route then retires, preserve that conservative attempted state even when no POST occurred. An uncertain marker/write is not proof of zero delivery. Never restore undelivered or choose a fresh operation ID to get around refusal.

## Notices and sequential consequences

The phrase “check before notices” must retain an honest boundary. Coordinator-level `changed(...)` awaits a host callback with additional awaits (`handoff-host.ts:347–353`), and `notifyRecord` awaits federation publication, notice claim/name/label work and runtime delivery (`:283–307`). A check before invoking that callback cannot prove that every later publication was still current.

For **attempt-scoped** side effects promised to stop with this capture, thread the same optional main-only check to their actual final admission after intervening awaits (and into a queued notice claim if that claim is covered). Do not make the stronger claim from a caller-only check. Alternatively explicitly treat notification of **already committed authoritative history** as the existing retained-record notification path, with its normal local ownership/eligibility semantics; a retired transport cannot erase that history and later independent sweeps may announce it. State which model applies. Neither model may fabricate a new agreement/receipt, deliver an unadmitted stale reply, or claim runtime/provider delivery strength from transport success. Fixing the Q5 notice delivery ledger or whole runtime-generation framework is not part of this slice.

Secondary cancellation POSTs and their reply adoption/removal require original capture checks after each intervening await, including after primary service adoption and command ACK saves. Preserve the same cancellation operation ID and don't remove it from a fresh epoch's mere readiness. Never-attempted local cancellation, removed-peer handling and terminal-history acknowledgement sinks remain unchanged. No peer/grant change, automatic handoff acceptance/apply/wake or new task is authorized by this design.

## Focused proof required after the corrected contract

Batch these controls with the already approved lower-layer proof; no separate full-matrix proof-only PR is recommended.

1. An executable original-host baseline: reverse request ready, direct false, valid immutable offer and actual production host callback ⇒ no POST. Candidate reaches actual coordinator/service/attempt store and real pinned request boundary, adopting valid receiver-authored history. Include request-only/no snapshot and old/no-control refusal plus unchanged direct behavior. Mark any preparation/grant/route/app dependencies still supplied by fixtures.
2. Exact original capture across held positive authorization, microtask POST start, durable attempt-marker completion, old response, host replacement, link epoch and trust/pairing/member withdrawal/restoration. Assert no POST/adoption for work retired before those admissions, retained IDs/history/attempt state and unrelated eligible liveness.
3. Hold the actual history-store queue before the candidate transaction; retire before its guard executes ⇒ no newer/older-copy acceptance. Separately admit, hold its actual save, retire, finish save ⇒ truthful matching committed disk/memory, no rollback fiction. Preserve conflicting/refused history validation.
4. Hold an earlier **actual command-store** mutation, enqueue candidate ACK/removal, retire original admission, then release ⇒ typed refusal with no queued ACK/removal or premature reverse acknowledged-map result; command/offer remains retained. Guard-removal mutant must fail this assertion. Independent unrelated queued mutation must still run after the refusal. Separately retire after command admission during save and verify the intentionally allowed committed result and subsequent original-capture send refusal. Include save failure without invented ACK.
5. Pending cancellation after fresh-grant withdrawal, and secondary-cancellation reply across retirement while primary adoption/ACK/command work awaits; original operation ID retained, no fresh-epoch secondary leg. Keep never-attempted cancellation controls separate from ambiguous attempted delivery.
6. Expired outer deadline with actual operation still held: no stale adoption/notice; owned lease/listeners remain validly held until actual settlement and then release once. Original host stop/sweep lifetime,30-second bounded scheduling,10-slot fairness/single-flight and unrelated work remain unchanged.
7. For whichever notice contract is chosen, test its actual claimed admission boundary and don't call a coarse coordinator check final-sink proof.

Freeze exact corrected contract/scope, then exact implementation/proof for independent review before coherent PR/ordinary hosted CI. No tests were executed for this design review and no unseen callback/API/source is approved. The sole concrete expansion needed for D1 is the private command-store seam; no new user-owned product choice or access is needed to specify it.

## Preservation

Private Q5 branch/source and original Details worktree remain untouched. Prior proof/source/ref failures and review reports remain preserved. This publication is only a new remote review branch through the existing authorized `gh` route; it does not activate product behavior or change current main.
