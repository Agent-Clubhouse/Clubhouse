# Native reverse handoff admission

This desktop-only contract specifies the [independently approved design](https://github.com/Agent-Clubhouse/Clubhouse/blob/3e06e4f4e6a3c7ce9bc290a889fc06a02bd46dac/docs/qa-transfer/2026-11-22/reports/native-handoff-ingress-70eff-boundary-review.md), inspected at main `70eff94e9042ccc304e68282e76afc9065497858`. The design approval is not acceptance of unseen implementation or full handoff functionality.

## Original request and admission

Only the native **reverse** `/api/v1/network/handoffs` route opts in. Capture its original principal, request, TLS server/generation and existing pairing/trust scalars before reading the body. A pure synchronous check uses the original `reverseRequestLive(req)` link/cancel/deadline closure, authorization of that fixed principal, membership and captured server/trust. Retirement is sticky when observed. Never substitute an outbound-client observation, accepted-link epoch, cached snapshot or replacement principal.

Capture saved trust using the existing `trustOf(peer)` plus `kind` identity, including `pairingId` and saved certificate PEM as well as the existing public key, role, pin, pairing time and pending status. Route, alias and last-seen changes are not trust changes. This reuses the canonical saved field set, not outbound-client readiness or a new shared trust policy.

The private `HandoffReceiveGuard` is an optional synchronous callback in `handoff-service`: no argument checks original request/host admission; a new-offer argument additionally captures/checks new-work policy. It is not a grant or wire field. The same callback propagates through the coordinator to actual incoming offer, cancelled-offer, cancellation and snapshot queues, including existing/older/idempotent decisions and the synchronous retired-terminal ACK sink.

New offers retain complete capacity, expiry, receiver and positive authorization checks. Check again after awaited authorization on both success and typed-refusal paths. Fresh-offer policy continuity uses existing config generation, relevant Dispatcher identity/path/enablement, connection-change evidence and current incoming settings. It does not impose new-work permission on retained history/cancellation or claim detection of every unobserved settings revoke-and-restore interval.

## Actual ownership and committed truth

Register a host-local incoming owner before awaiting domain work. It holds the actual coordinator promise through queue waits, atomic save and normal committed-history callbacks, not the canceled waiter or a deadline race. Normal `stopHandoffs` retires new admissions and drains incoming and outgoing reverse owners; replacement cannot bypass either set. This is not a global server/app shutdown or drain of unrelated pre-capture local writers.

Existing outgoing sync ownership remains distinct from its retired, still-settling POST/authority-listener lifetime. After the outer deadline, that sync can no longer adopt a late reply; its network operation need not block host replacement. This legacy behavior is unchanged. Incoming ownership cannot end early in that manner because its actual domain promise can still complete an admitted save.

| Retirement point | Required outcome |
|---|---|
| Before actual queued/postauthorization admission | Refuse this incoming decision without message-driven history/version/notice. Unrelated eligible work remains usable. |
| After decision admission | An actual save may finish. Publish matching committed memory and return the actual result; no post-save fake refusal or rollback. |
| Actual IO error | Preserve the real bounded error and existing precommit versus ambiguous-after-rename behavior. |

Existing offer expiry/prune remain **separately admitted local maintenance** under the incoming owner's lifetime. Recheck the original request after those awaits. Refusing an incoming message does not promise zero unrelated maintenance writes.

The guarded reverse route does not replace an admitted result with its old post-await authentication branch. Existing control-layer authorization still suppresses dead/unauthorized wire publication. Direct/local defaults and legacy native direct pre/post checks remain unchanged.

## Cancellation is not a deadline or durable exactly-once delivery

Actual cancellation aborts the original signal but may leave a complete admitted result available for bounded same-key replay. A deadline destroys `ReverseResponse`; an incomplete late result is `not_retained`, and retry gets `replay_unavailable`, not a second invocation or fabricated ACK. A same-key pending/completed retry uses the original execution; conflicting digest is refused. Existing slot lifetime, peer/pin/cache lifecycle, ten-minute TTL, eviction and retention caps are unchanged.

## Bounded proof and exclusions

The genuine old-host baseline uses the native router/dispatcher, actual TLS identities/pins, real domain authorization implementation and real history/command stores. It explicitly sends control requests on the receiver-opened link; neither desktop client runs. Dispatcher availability and absent runtime are isolated fixture inputs, and the authorizer entry witness calls the unchanged real authorizer. Offers are synthetic metadata, not approved MCP producer/preparation executions.

Baseline attempt03 on unchanged production `70eff94e` produced **3 PASS / 2 FAIL**: a retired pre-admission request still committed its offer even after a replacement link served unrelated work; normal host stop allowed replacement while an admitted save was held. The current-positive, genuine canceled/same-key replay and native receiver-permission refusal controls passed. Both saves/queues are held at actual operations, including the fsynced temporary file before real rename. Downstream assertions after either baseline failure are not credited.

Attempts01/02 failed at an incorrect fixture witness of the authorizer's result wrapper; no boundary proof is credited to them. Their raw originals, including attempt01's cleanup warning, remain preserved.

At source `940365e`, the selected local candidate controls passed: 35 cases across real native TLS/RPC and private service/coordinator/host boundaries. Its changed-fixture type graph passed with 3,960 compiler inputs; scoped lint had zero errors, preserving the independently measured 71 native-server baseline warnings. The later canonical saved-trust correction has separate risk-targeted evidence; these historical counts are not a rerun or acceptance of that successor or the excluded product paths. Independent exact source/proof review remains required.

There is no new worker/grant/preparation/Git/apply/wake/provider/human-gate, real two-host, full-handoff or full-duplex acceptance. The accepted `#3777` and lower `74d2ed4` proof remain unchanged, not rerun.
