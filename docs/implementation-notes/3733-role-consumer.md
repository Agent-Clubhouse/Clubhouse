# #3733 selected-role consumer wrap

Base: approved HTTP integration `c5d6c20bcf321fedc7473f04c741cb7d203de397`.
Branch: `DetailsSessionDisplay/role-read-consumer`.

First recoverable checkpoint stages shared full-wrapper validation and a fixed pinned-host client/preload/IPC read. No arbitrary URL, role/id/page caller parameters or fallback read. The existing authoritative connection epoch is exposed as optional local connection metadata so a batched reconnect cannot revive an earlier component result. Private role Details are never retained in the satellite/snapshot store.

Wrapper validation binds role=dispatcher, exact nested agent/settings identity, full Details contract and byte bound; it rejects helperPageOnly, connectionPageOnly and inventoryPageOnly, including the unknown-additive managed partial injection. The host full-response guard also rejects the managed partial marker.

First-checkpoint pending work (subsequently implemented below): Dispatcher-only view-local consumer with explicit source/currentness/refusal states and no synthetic Agent; a bounded fix ONLY to real-chat Dispatcher Other machines admission/notice; transport/UI/IPC/partial-envelope tests, serial exact-head proof and independent review. Real-chat offline policy will withhold the private peer list rather than substitute local presence or show retained private data.

No tests run or acceptance claimed at this first checkpoint. No authority/route changes, live actions/grants, PR/merge/release. Subsequent normal commits and final handoff record delivered scope/proof/deferred work.

Consumer checkpoint: view-local, coalesced selected-fingerprint role read; connection generation, receipt and role-change invalidation; no synthetic Agent or role cache. Settings, Connections and Actions expose existing authorized DTO evidence only. Other machines requires a separately positive host snapshot receipt and successful current Details read; offline/private retained lists are withheld. Real-chat edits are restricted to that Other machines admission and notice. Current ordinary/role 401/403 removes only positive snapshot admission and broadcasts only on change. Existing page/response classifications remain intact.

Proof pending on frozen consumer checkpoint. Coverage authored for cloned retained snapshots, remount/regrant before fresh snapshot, denied reads, repeated denial, prior-epoch denial, peer mutation, reconnect, full-envelope rejection, absent/empty/off/omitted distinctions, selection changes, and unmount/no-events. Deferred: role-card pagination by safe role binding, management/live actions and unsupported parity; no raw role-id paging or permission changes.

## Proof and handoff

Consumer code frozen at `863c45a8ebd548564d2bda7396af9604bb0ea898`: 9 files / 489 tests passed with the verified existing dependencies, Node 25 webstorage disabled and one serial worker. The preceding `b8127cff2c6343655be88b3a8aee289f4518d31a` ran 466/467; its only failure was the obsolete offline notice assertion, corrected while preserving the no-local-peer/identity assertions. Typecheck passed on b8127cff before the test-only successor.

Exact bounded command, repeated on the final notes head before handoff:

```sh
NODE_OPTIONS=--no-experimental-webstorage ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism src/main/services/annex-client.test.ts src/shared/selected-dispatcher-details.test.ts src/main/services/selected-dispatcher-details.test.ts src/main/ipc/annex-client-handlers.test.ts src/preload/index.test.ts src/renderer/features/dispatcher/RemoteDispatcherDetails.test.tsx src/renderer/features/dispatcher/DispatcherView.test.tsx src/renderer/features/agents/details/RemoteAgentDetailsView.test.tsx src/renderer/features/agents/details/AgentDetails.test.tsx
./node_modules/.bin/tsc --noEmit
```

Scoped ESLint covers all changed TypeScript/TSX files and `git diff --check` covers the complete slice. Final exact commit/results are reported to the parent after these commands finish; independent review remains required before integration.

Failure discriminators (all mutations restored, clean worktree): removing the inventoryPageOnly full-wrapper guard fails the explicit old-validator/additive-inventory injection test; removing denial receipt invalidation fails both ordinary and role denial tests; removing the real-chat positive-receipt guard fails the retained private peer test. All fail on the intended assertion rather than import/setup errors. Logs: `/tmp/details-role-discriminator-{wrapper,denial,peers}.log` (ephemeral; evidence above is durable).

No new authorization, protocol/host route, grant, discovery/capture, init/wake, local fallback, fake identity, shared private role data or management control. Existing ordinary Details page logic is untouched except the explicitly reserved current-connection 401/403 admission invalidation. The public selected-machine connection generation is local transport metadata, not private role data. Host selector/HTTP authority proof remains in the independently accepted predecessor notes. Parent review, integration and deferred parity remain separate.

Final verification update: b421c47e passed 489/489 and typecheck; scoped lint found only one new error, an unused test import, removed in the final successor. Existing warning-level findings remain outside this slice. The successor runs the same 489-test command, typecheck, scoped lint and diff check before handoff.
