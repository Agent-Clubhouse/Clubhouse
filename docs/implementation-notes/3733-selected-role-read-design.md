# #3733 selected-machine Dispatcher role read: staged host composition

**HTTP follow-up:** the accepted staged reader is now connected only to the explicit same-gate HTTP adapter described in [3733-selected-role-http.md](3733-selected-role-http.md). This document records the prior staged/source-only phase. No client/UI or public snapshot wiring was added.

Base: `532f2ee4b523be23516146defc73acc7cc4d1efa`.
Branch: `DetailsSessionDisplay/role-read-design`.
Status: host selector staged for independent authority/source review; **no route, client method, IPC registration, renderer binding or snapshot-bus data added**. Existing no-chat unavailable/deferred fields remain unchanged.

## Actual authority evidence

`annex-server.ts` authenticates every main-port REST request with the paired caller's pinned certificate. `desktopDetailsAuthorized` additionally requires current `ctx.reauthorize()`, an explicitly classified desktop peer, no pending membership and no mobile-session peer. `handleAgentSettingsDetailsRoute` calls `ctx.requireMtls()`, applies that predicate before selected reads, gives the same callback to ordinary `readRemoteAgentDetails`, and checks it again before serializing. Reverse requests use the same route table with the authorizer's additional reverse-eligibility checks. Direct eligible desktop controllers do not require network membership merely to use this existing Details gate.

`readRemoteAgentDetails` already admits existing exact canonical Dispatcher identities under that gate: `resolveAgentConfigTarget(exactId, undefined, { strict: true })` handles cached coordinator/chat ids in their fixed host folders, including while off. It does not use enabled state as authority. `captureReadOnlyConfigTargetWitness` requires exactly one matching role id/path and the authoritative primary inventory; `captureReadOnlyRoleTargetWitness` binds the admitted selected record and its inode/size/time/content signature across the read. Ordinary Details checks that witness, current role classification, runtime identity, all related receipts and authorization before returning its allowlisted bounded metadata.

This source establishes an existing authorized principal set and selected-target set that includes exact registered roles. The staged selector is a host-side way of choosing one member of that same target set and invokes the exact ordinary reader under the exact same trusted gate. It does not grant a new principal, accept an address or caller-chosen id/path, or project fields unavailable from that ordinary reader. The new role-to-target association itself still needs independent contract/authority review before exposure; knowledge of a published address or a snapshot receipt is not substituted for that review.

No live peer settings/grants were queried or changed. "Same gate" here means the predicate in current source, not a claimed grant to the helper or an unobserved runtime principal.

## Distinct refused surfaces remain refused

- `annex-controller-chat.ts/controllerChatAllowed` requires active desktop network/federated controller identity plus an allowed `agent.read` grant. This is controller conversation authority, not the proposed metadata selector's predicate. No transcript/session reader is invoked and no refused controller read is retried through this service.
- Mobile `activeDispatcher` / `buildDispatcherSettings` deliberately refuse their active mobile settings surface while off or before a chat exists. Those routes and refusal semantics are unchanged. A phone never gains the existing desktop Details gate by requesting this proposed selector.
- Phones, unclassified devices, pending members, session-only/mobile peers, unknown/wrong-pin/revoked callers and a role that cannot control the host must retain their existing authorizer/desktop-gate refusal. No fallback to this computer's Dispatcher is permitted.

## Staged implementation

`selected-dispatcher-details.ts/readSelectedDispatcherDetails` is not imported by production callers. A missing authority callback is refused; an eventual trusted adapter must supply **the same** `desktopDetailsAuthorized(ctx)` callback and apply `requireMtls` and a final authorization check as the ordinary route does. The service is not an alternative principal authorizer.

The service reuses `dispatcherControllerForDisplay` rather than looking up a published address, chat name or synthetic id. That existing passive helper captures the canonical cached Dispatcher id and fixed folder, calls the strict primary resolver, rejects mismatched role/folder/disposal, and returns private role/primary receipts. It does not initialize settings, recover files, enable, create or wake the Dispatcher. A null/unreadable/unbound role returns unavailable, with no never-created/sleeping claim and no chat/global/project scan fallback.

It then invokes `readRemoteAgentDetails` directly with that exact admitted id and the same authorization callback. The outer role/primary witnesses are checked after the asynchronous ordinary read and after the proposed bounded wrapper is serialized, preventing a role replacement or primary revision from being relabelled as the selected Dispatcher. The wrapper contains only `version`, constant role name, the existing native selected id and the ordinary safe Details projection. Raw targets, folders, configs and private receipts are never exported. This is not a new global monotonic role generation or a stronger ABA guarantee than the existing role/primary witness.

Ordinary refusal/error results remain refused/error results; there is no mobile/controller retry. Mismatched response identity, Connections-source-page-only or helperPageOnly response or excessive wrapper size is unavailable/error rather than fabricated evidence. An exception returns only a bounded error. No private role metadata is placed on a public selected-machine snapshot or presence bus.

## Proposed reservations after authority review only

No current overlapping functions are edited. The reserved proposal is limited to a **new** host `handleSelectedDispatcherDetailsRoute`, a corresponding GET registration in the shared route table, and a **new** main client `requestDispatcherDetails` method. Existing `requestAgentDetails` and its pagination/query methods are not reserved or modified. Preload/IPC/shared result validation and renderer adoption remain a subsequent reviewed consumer step.

The route must:
1. Use the same mTLS + `desktopDetailsAuthorized` gate and final recheck, without widening or silently narrowing eligible ordinary desktop principals.
2. Resolve on the selected pinned host; take no raw address, requested agent id, path or agent/controller grant as identity proof. Return `Cache-Control: no-store` and a bounded allowlisted role binding.
3. Keep one selected role/primary revision across async reads; map unavailable/old host/offline/forbidden/changed distinctly without inferring absent role or zero data.
4. Keep client selected-peer/connection generation and post-await receipts. Renderer displays the returned binding directly; it must not manufacture an Agent to reuse local agent hooks.
5. Preserve existing mobile/controller refusals, no writes/initialization, no private snapshot fields, and all existing Details list/page restrictions.

## Proof boundary and remaining acceptance

Authored unit tests exercise the staged service with the **real existing canonical role admission and real primary-inventory witness**, mock ordinary Details, and no live services. They cover missing/refused authority before discovery, exact-id/same-callback delegation, unbound/unreadable/backup-only/disposed/wrong-folder refusal, role replacement during lookup, role/primary revision/removal/revocation during async read, ordinary refusal and mismatched/error responses. Existing primary remains unchanged, and a backup-only primary is not recovered. Unrelated enablement/relationship read ports must stay unused.

Unit authorization callbacks do **not** prove real HTTP caller classification. Current `annex-server.test.ts` source already has the ordinary pinned desktop positive and wrong-pin/phone/unknown/pending/post-await-revocation negatives, but those tests must be rerun and extended to the eventual new handler before claiming anonymous/other-principal route coverage. The staged module creates no reachable route for any principal now.

No tests were run during the occupied lane. The final handoff records any subsequently granted serial test lane and exact-head results; until then tests are authored/source-only, not acceptance. Independent authority/source review is required before route registration. No production/live activity, installations, grants, PR or merge.


## Subsequently granted serial-lane proof

After the source-only phase and independent source/design no-blocker assessment, Orchestrator granted the lane after Canvas. At staged code head `779ef524c0a0e030afa0695986f54d35bf6e0544`:
- New selector + existing real primary-witness, Settings and Details suites: **242 passed** across four files.
- Existing ordinary desktop Settings/Details HTTP gate matrix: **21 passed / 578 skipped**. This verifies the current ordinary gate, not a new handler; real principal classification tests for the reserved future route remain required before client/UI work.
- Bypassing the new outer role/primary receipts makes the role replacement and asynchronous revision/removal checks fail. Removing helperPageOnly refusal makes its new discriminator fail. All temporary mutations restored.
- No production/live activity, grants, installed dependencies or new route registration. Tests use the verified November19 dependencies, 1 worker and no parallel files. Final handoff records exact delivered head, final checks and lane release.

```
NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run --project main src/main/services/selected-dispatcher-details.test.ts src/main/services/read-only-config-target.test.ts src/main/services/remote-agent-settings.test.ts src/main/services/remote-agent-details.test.ts --maxWorkers=1 --no-file-parallelism
NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run --project main src/main/services/annex-server.test.ts -t 'remote full Details authority|remote Settings details' --maxWorkers=1 --no-file-parallelism
```
