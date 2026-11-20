# #3733 no-chat Dispatcher: authoritative snapshot receipt successor

Parent under review: `f78102f62c61c0952b63a2ac6804017825ff7472`.
Task branch: `DetailsSessionDisplay/no-chat-dispatcher`.

Independent review correctly rejected the parent's WeakSet: a different JS object may be a reserialized retained snapshot, and unmount loses the component's memory. That check is removed. Private new-card observations now require an explicit positive receipt from the authoritative main-process connection. No component-local identity heuristic can grant admission.

## Narrow ownership and behavior

Orchestrator assigned main Annex client receipt/local IPC connection-type ownership for this purpose. Changes in annex-client.ts are confined to connection metadata/type fields, toPublicConnection, setState, actual snapshot acceptance, snapshot_failed and session:paused handling. Details query APIs, the other helper's pagination methods and #3744 branches are untouched.

- Main mints a new opaque `snapshotReceipt` only in the accepted `handleSatelliteMessage('snapshot')` branch for the current open pinned socket while connected, not needing pairing and not paused. Existing protocol/version/sequence/current-socket checks remain. A host-provided similarly named payload field cannot mint local connection metadata.
- Connection loss/new connection admission, snapshot failure and pause clear that receipt. A socket that is closing cannot export it even before its close callback. Public serialization omits it unless the connection and snapshot remain eligible.
- Cached snapshot content is preserved exactly as before. Connection-state broadcasts, reconnect open, pairing return, JSON cloning, cached snapshot events, canvas/icon hydration and resume never create a receipt. Only a real accepted snapshot message does. Old readers ignore the optional local IPC metadata; a new reader without it withholds private fields.
- Renderer pause handling removes only this admission metadata alongside its existing pause flag; it does not replace cached snapshots or add new permission/cache broadcasts. Resume and synthetic snapshot events cannot recreate admission.
- New Dispatcher Settings enabled state and host Other machines list require the receipt in addition to prior state/omission guards. Published local presence/link observations remain separate. Receipt proves transport snapshot provenance, not canonical Dispatcher role identity, permission equivalence or detailed inventory authority; the prior selected-role lookup gap remains deferred.

No host route, wire protocol, pairing grant, authorization policy, retained-cache semantics or lifecycle change. No live actions or grants were used.

## Proof

Serial single-worker run: **325 passed** across six suites: main Annex client **237**, renderer Annex client store **49**, four Dispatcher suites **39**. Covers existing pairing/pinning/reconnect/cache behavior plus:
- Real current-socket snapshot receipt, ignored older frame and host-supplied fake receipt; serialization preserves the existing receipt without minting one.
- Pairing loss/return retains old cache but no receipt, including connection-state broadcasts and a replaced socket's late message. New socket's actual snapshot supplies a new receipt even when its sequence restarts.
- Closing socket, snapshot failure, pause/resume and paused snapshots stay unadmitted until a valid fresh snapshot.
- Store pause strips only metadata, preserves cached object, and synthetic snapshot/resume events do not attest it.
- Renderer deserialized duplicates, grant return, unmount/remount, selection away/back, connection-state rebroadcast and fresh-looking content without main receipt stay withheld. A positive main receipt admits new selected-host observations. Old local reader/no receipt is explicit unavailable.

Failure discriminators:
- Restore only predecessor WeakSet component temporarily: **2 failed / 11 skipped** (deserialized/remount/access-return case and old-reader/no-receipt case).
- Omit authoritative setState receipt invalidation temporarily: **1 failed / 236 skipped** (retained old receipt revives on pairing return/transport open).
- Both temporary mutations restored. Final report records exact successor SHA and final suite/typecheck/scoped lint/diff results.

```
NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run --project main --project renderer src/main/services/annex-client.test.ts src/renderer/stores/annexClientStore.test.ts src/renderer/features/dispatcher/RemoteDispatcherDetails.test.tsx src/renderer/features/dispatcher/DispatcherView.test.tsx src/renderer/features/dispatcher/remoteDispatcherTarget.test.ts src/renderer/features/dispatcher/OtherMachinesList.test.tsx --maxWorkers=1 --no-file-parallelism
node_modules/.bin/tsc --noEmit
```

Existing verified November19 dependencies only; no installs. Orchestrator granted the serial lane before tests. Independent successor review and live host/app acceptance remain deferred, as do canonical selected-role lookup and full no-chat settings/inventory/denied-vs-absent discrimination. This receipt adds no role proof. No PR/merge/release; standby preserved/unpushed.
