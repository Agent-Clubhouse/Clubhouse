# #3733 finite matrix section 1: no-chat selected remote Dispatcher

Base: approved `5077d3a380936f1f64fbc24f5f87c0d68ab68590`.
Isolated branch: `DetailsSessionDisplay/no-chat-dispatcher`.

## Delivered within existing observations

RemoteDispatcherDetails now has Settings, Connections, Other machines and Actions sections alongside the existing selected-machine presence explanation. No Agent object, id, sleep state or runtime is manufactured. Dispatcher-specific renderer files/tests only; no host/shared envelope/Connections producer edits.

- Settings exposes only an explicitly present admitted host snapshot `dispatcher.enabled` flag. Off does not prove a prior creation or a sleeping agent. Absent/old-host/unbound settings remain unavailable.
- Connections shows this computer's already published controller-link observation, clearly separated from the selected host's connection inventory. Presence addresses are never parsed or used for Details lookup.
- Other machines uses the selected host's `dispatcherPresence` snapshot only, with the existing shared list and summary presentation. Explicit empty is empty; absent is unavailable. This computer's presence list is never substituted for the host's peers.
- Detailed settings, Connections inventory and Actions remain explicitly unavailable without a host-bound Dispatcher identity. The existing real-chat selector/Details path remains the way known identities reach supported full cards; a no-chat-to-real-chat transition is tested.
- Connection loss, pairing unavailable (including access removal), snapshot unavailable, paused sharing and omission markers withhold private snapshot fields. During this mounted surface, clearing a connection/access problem cannot revive the same retained snapshot: a new snapshot object is required. Published local presence remains separately labelled. Raw transport/denial errors are not displayed.

## Exact missing role contract and passive host building blocks

This is a consumer improvement with explicit remaining implementation work, not whole-section/full-parity acceptance.

`SatelliteSnapshot.dispatcher` exposes enabled/projectId/chat agent. If agent.id exists, `resolveRemoteDispatcherTarget` already selects the real namespaced chat. If it is absent, neither projectId nor enabled nor the selected fingerprint supplies a canonical host role id. `RemoteDispatcherPresence.address` comes from `remoteFederationController` in `dispatcher-presence.ts`; it is a published coordinator address, not a fresh host Details role attestation. It is not used as proof or as a substitute chat identity.

Existing passive host pieces CAN support a future strictly selected-role read:
- `dispatcher-service.ts` cached `getDispatcherAgentId()` / `getDispatcherChatAgentId()` return existing coordinator/chat ids without creating them; coordinator id is kept while off. Their null result alone must not hide initialization/readiness failures as verified never-created state.
- `resolveAgentConfigTarget(exactId, undefined, { strict: true })` in `agent-config-reader.ts` resolves an existing role only against its authoritative folder's checked primary inventory, rechecks id/path and refuses ambiguity/disposal/unreadable inventory. Its strict path avoids global settings initialization/recovery. Exact roles are supported while off.
- `captureReadOnlyConfigTargetWitness` in `read-only-config-target.ts` and its role witness bind exact role id/path/primary inventory and final assembly; `readRemoteAgentDetails` also has post-await receipts and selected-field limits.
- `handleAgentSettingsDetailsRoute` requires mTLS and `desktopDetailsAuthorized`: current reauthorization, paired desktop peer, no network-pending membership and no phone/mobile-session substitute, with final reauthorization. These are the existing desktop display-read gates, not new permissions.

A future host-owned selected-Dispatcher-role read could compose those blocks under an explicitly reviewed **same desktop Details read authority**, resolving the canonical selected role on the host and returning only its applicable safe display fields with a role/currentness receipt. It needs a real selected-role contract/client reader; the current endpoint takes an exact agent id and does not attest the caller's claimed role. Review must distinguish uninitialized/unknown, verified absent role, unreadable inventory, stale/replaced role, old-host unsupported, offline and actual forbidden. It must preserve all current principal/peer/pin/revocation/final receipts and have no initialize/create/wake/global fallback. This note proposes reuse of existing mechanics, not an implemented or automatically equivalent permission.

`mobile-dispatcher.ts`/`buildDispatcherSettings` deliberately refuse active mobile settings while off or before a chat exists (404/dispatcher_off). That refusal is preserved, not treated as missing=zero. Controller-history reads have a separate desktop agent.read policy; they are not queried for identity discovery and do not authorize Details. No new route/role export/auth equivalence was added here. With no bound role there is no fresh Details denial result to invent: pairing/access unavailability is labelled as such, rather than fabricating a specific 403 or a nonexistent role.

## Proof and remaining acceptance

- Dispatcher-specific matrix/integration/selector/shared OtherMachines suites: **38 passed** (12 new RemoteDispatcherDetails cases plus 26 existing cases, including the strengthened transition).
- Bypass private snapshot admission temporarily: all **5 privacy discriminators fail**, 7 other matrix cases skipped. Covers disconnected, unavailable snapshot, pairing/access loss, paused sharing and retained-snapshot reuse after access returns. Source restored afterward.
- Every new matrix case forbids local settings/config/Actions/grants reads, local Dispatcher state fallback, durable mutation, remote lifecycle writes, controller conversation reads and identity-based agent Details/settings requests. Only existing local published presence is read.
- Serial tests only after the Orchestrator granted the lane; 1 worker, no parallel files, supplied verified November19 dependencies, no installs. Final report records exact-head rerun/typecheck/scoped ESLint/diff results and pushed SHA.

```
NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run --project renderer src/renderer/features/dispatcher/RemoteDispatcherDetails.test.tsx src/renderer/features/dispatcher/DispatcherView.test.tsx src/renderer/features/dispatcher/remoteDispatcherTarget.test.ts src/renderer/features/dispatcher/OtherMachinesList.test.tsx --maxWorkers=1 --no-file-parallelism
node_modules/.bin/tsc --noEmit
node_modules/.bin/eslint src/renderer/features/dispatcher/RemoteDispatcherDetails.tsx src/renderer/features/dispatcher/RemoteDispatcherDetails.test.tsx src/renderer/features/dispatcher/DispatcherView.test.tsx
git diff --check
```

Deferred: reviewed canonical selected-role lookup and supported full no-chat inventory/settings reads, actual denied/absent role discrimination on such a contract, independent new-head review and live app/provider/host acceptance. Snapshot observations are not new host reads or proof of runtime/role existence. Remaining #3733 scope stays open. No PR/merge/release; standby preserved/unpushed.
