# #3733 selected-role consumer wrap

Base: approved HTTP integration `c5d6c20bcf321fedc7473f04c741cb7d203de397`.
Branch: `DetailsSessionDisplay/role-read-consumer`.

First recoverable checkpoint stages shared full-wrapper validation and a fixed pinned-host client/preload/IPC read. No arbitrary URL, role/id/page caller parameters or fallback read. The existing authoritative connection epoch is exposed as optional local connection metadata so a batched reconnect cannot revive an earlier component result. Private role Details are never retained in the satellite/snapshot store.

Wrapper validation binds role=dispatcher, exact nested agent/settings identity, full Details contract and byte bound; it rejects helperPageOnly, connectionPageOnly and inventoryPageOnly, including the unknown-additive managed partial injection. The host full-response guard also rejects the managed partial marker.

At this checkpoint client code is not yet consumed by UI. Pending work: Dispatcher-only view-local consumer with explicit source/currentness/refusal states and no synthetic Agent; a bounded fix ONLY to real-chat Dispatcher Other machines admission/notice; transport/UI/IPC/partial-envelope tests, serial exact-head proof and independent review. Real-chat offline policy will withhold the private peer list rather than substitute local presence or show retained private data.

No tests run or acceptance claimed at this first checkpoint. No authority/route changes, live actions/grants, PR/merge/release. Subsequent normal commits and final handoff record delivered scope/proof/deferred work.

Consumer checkpoint: view-local, coalesced selected-fingerprint role read; connection generation, receipt and role-change invalidation; no synthetic Agent or role cache. Settings, Connections and Actions expose existing authorized DTO evidence only. Other machines requires a separately positive host snapshot receipt and successful current Details read; offline/private retained lists are withheld. Real-chat edits are restricted to that Other machines admission and notice. Current ordinary/role 401/403 removes only positive snapshot admission and broadcasts only on change. Existing page/response classifications remain intact.

Proof pending on frozen consumer checkpoint. Coverage authored for cloned retained snapshots, remount/regrant before fresh snapshot, denied reads, repeated denial, prior-epoch denial, peer mutation, reconnect, full-envelope rejection, absent/empty/off/omitted distinctions, selection changes, and unmount/no-events. Deferred: role-card pagination by safe role binding, management/live actions and unsupported parity; no raw role-id paging or permission changes.
