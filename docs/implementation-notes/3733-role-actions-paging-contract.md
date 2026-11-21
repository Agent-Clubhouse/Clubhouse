# #14 remainder: Dispatcher role Actions paging (contract and hunk map)

Recorded November 21, 2026, from `main` `50cb77ab6ccf9f383a39e59db308f4f8336051ea`. This is a contract and source inventory for independent review **before implementation**. No product code here. It does not complete #14 or #3733.

## What already exists

- **Host producer.** `readRemoteAgentDetails` already serves Actions relationship pages for the Dispatcher agent.
  - `inventorySources` includes `selected-action-relationships` for Dispatchers too (`remote-agent-details.ts` ~99).
  - An `actions` query reaches `readSelectedActionDetailsPageForAgent(agentId, project.id, dispatcher, { offset, selection, authorized, target, receipts, names })` (~100-121).
  - The page is fenced by the target witness, settings receipt, inventory receipts and run identity, giving 409 on change. The body is page-only (`inventoryPageOnly: true`), with the inventory page limit at the M1 `budget`.
  - The whole-read body already carries `inventoryPages: 1` and `inventorySources`, so the role overview tells the renderer whether pages exist.
- **Ordinary remote agents.** `RemoteActionsCard`, `useSelectedInventoryPage` and the pure `SelectedActionsPage` page with an ordered `selection` token (`remote-inventory-page.ts`: offsets are multiples of 25 below 4096, and a nonzero offset requires a selection).
- **Role path today.** The role route (`annex-server.ts` `handleSelectedDispatcherDetailsRoute` ~4114) accepts only Connections page queries (#3755). The role pane's Actions card shows the overview evidence only (`RemoteDispatcherRoleDetails.tsx` ~105-106).

## Contract

1. **Route query (host).** `/api/v1/dispatcher/details` additionally accepts exactly `card=actions&source=selected-action-relationships`, plus optional `offset` and `selection`.
   - The key set is per card. Actions allows `card`, `source`, `offset`, `selection`; Connections keeps `card`, `source`, `offset`, `projectOffset`.
   - Each key must appear once. `offset` must match `/^(0|[1-9]\d{0,3})$/` and `isInventoryOffset`. `selection` must be `isInventorySelection` (64 hex characters), and a nonzero offset requires a selection.
   - Anything else gets 400 `invalid_dispatcher_details_query`. That includes mixing Connections and Actions keys, other inventory sources (managed, Canvas) and `projectOffset` on Actions.
   - **Authorization before parse** stays: `requireMtls` and `desktopDetailsAuthorized` run before the query is read.
2. **Role resolution and currentness.**
   - `readSelectedDispatcherDetails` resolves the role on the host as it does today.
   - It passes the Actions query to `readRemoteAgentDetails(roleId, authorized, query, { maxBytes })`, using the same M1 wrapper budget.
   - It keeps the before and after authorization checks and the final role receipt (409 `dispatcher_role_changed`).
   - Producer 409s (inventory, settings or run changed) pass through unchanged.
   - No caller-chosen agent id. Only the host-selected role is paged.
3. **Wrapper validation (shared).** A new `isSelectedDispatcherActionsPage(value, query)` checks:
   - the same four-key wrapper, with `role: 'dispatcher'` and matching `agentId`
   - `isRemoteAgentDetails`, `inventoryPageOnly === true`, `inventoryPages === 1`, and no connection or helper page flags
   - `inventoryPage` passes `isRemoteActionRelationshipPage`, has source `selected-action-relationships` and an offset equal to the query's
   - for a `recorded` page with a query selection, the page selection equals it
   - the byte bound
   - The whole-read validator keeps rejecting page-only bodies.
4. **Client.** `requestDispatcherDetails(machine, query, expectedAgentId)` accepts an Actions query.
   - Before sending, the query is validated and `expectedAgentId` is required.
   - URL params are `card`, `source`, `offset`, and `selection` when present.
   - The response must pass `isSelectedDispatcherActionsPage` **and** name `expectedAgentId`; otherwise it's an error.
   - A 400 to a page query (an older host without role pages) gives `unavailable`. 404, 405 and 409 give `unavailable`, as today.
   - 401/403 revoke only the receipt the read ran under (O1). The epoch and receipt `current()` fence is unchanged.
5. **IPC and preload.** The `DISPATCHER_DETAILS` argument types widen from the Connections query to a role page query union. The runtime check stays an object argument, with the shared validators enforcing the shape. The call shape is unchanged.
6. **Renderer.** A new `RemoteDispatcherActionsPages` sits inside the role pane's Actions card, mirroring `RemoteDispatcherConnectionPages`:
   - It is shown only when the overview read succeeded, the pane is eligible, `inventoryPages === 1` and `inventorySources` includes the Actions source. Otherwise the existing overview evidence shows, and for an older host a summary-only note.
   - It reuses the pure `SelectedActionsPage` (`onPage(offset, selection)` keeps the ordered selection token), reading through `dispatcherDetails(machine, query, roleAgentId)`.
   - Its state is keyed to the role pane's existing context key (machine, generation, receipt, pause, role events, retry), so any role-context change returns to the overview.
   - A page naming another role agent is never shown.
   - No local Actions store reads, no `actions.list`, no writes.
7. **Unchanged.** Connections paging semantics; ordinary agent Details and Actions; snapshot receipts and connection generation; the pairing display frame.

## Required proof (targeted, before PR)

- Shared validator: accepts a matching page; rejects another source, offset or selection, whole reads, Connections pages and extra wrapper fields.
- Host service: the query passes through with the budget; page and role validation; authorization before validation; 409 on role change.
- Route: Actions page served under the gate; mixed or extra keys, bad offset or selection, and other inventory sources give 400; refusals happen before any lookup.
- Client: URL shape, role-agent binding, older-host 400 giving `unavailable`, and 401/403 receipt binding for an Actions page.
- Renderer: paging with Next, Previous and First carrying the selection; a page from another role agent is rejected; a role event resets to the overview; an older host shows the summary.
- **M1 follow-up now reachable:** an inventory-page-at-budget fixture through the role path. At the budget it passes, and an irreducible page fails closed. QA waived this earlier only because the role path could not reach inventory pages.
- RED-first, discriminating mutations with byte-identical restore, `tsc` and lint, and the shared store unchanged.

## Hunk map (current `main` `50cb77ab6`), coordination needed via parent

| File | Hunk | Notes |
| --- | --- | --- |
| `src/main/services/annex-server.ts` | `handleSelectedDispatcherDetailsRoute` (~4114-4140) query parsing only | Naming reserved machine snapshot ~4433 and `getStatus.alias` ~6597 (disjoint). **Phone/controller-view owner (lane 3613): please confirm no phone-route hunk overlaps here.** |
| `src/main/services/annex-client.ts` | `requestDispatcherDetails` (~2641-2675) | Naming reserved `toPublicConnection` ~576 label helper (disjoint). No receipt or epoch changes. |
| `src/main/services/selected-dispatcher-details.ts` | query type, validation and page check (~7-45) | #3733-owned. |
| `src/shared/selected-dispatcher-details.ts` | new query union and `isSelectedDispatcherActionsPage` (~25-45) | #3733-owned. |
| `src/main/ipc/annex-client-handlers.ts` | `DISPATCHER_DETAILS` handler (~183-188) argument type | #3733 IPC (#3755). |
| `src/preload/annexClient.ts` | `dispatcherDetails` signature (~50-51) | |
| `src/renderer/features/dispatcher/RemoteDispatcherRoleDetails.tsx` | Actions card (~105-106) | |
| `src/renderer/features/dispatcher/RemoteDispatcherActionsPages.tsx` | new file | |
| Tests | the matching tests in each area | |

Open questions for review:
- (a) The phone/controller-view owner's annex-server and annex-client reservations, against the two host and client hunks above.
- (b) Whether the role pane should also show the Dispatcher relationship group the ordinary page labels "Dispatcher …". It is produced by the same `readSelectedActionDetailsPageForAgent` with `dispatcher = true`; the presentation is reused unchanged.
