# #14 role Actions paging: implementation evidence

This implements the approved contract `0853da899` (QA APPROVE, report `11fdc936f`, notes A1–A3). lane3613 cleared the hunks at annex-server ~4114–4140 and annex-client ~2641–2675. The parent is the fixture prep `5159cfb30`, from `main` `50cb77ab6`. This branch doesn't complete #14 or #3733.

## Product changes

- **`src/shared/selected-dispatcher-details.ts`** adds:
  - `SelectedDispatcherActionsQuery` and `isSelectedDispatcherActionsQuery`, built on the shared `isRemoteInventoryQuery` (A1);
  - the `SelectedDispatcherPageQuery` union;
  - `isSelectedDispatcherActionsPage`, which composes `isRemoteAgentDetails` and `isRemoteActionRelationshipPage` and checks the four-key wrapper, page-only flags, source, offset, selection when the query carries one, and the byte cap;
  - the `isSelectedDispatcherPage` dispatcher.
- **`src/main/services/selected-dispatcher-details.ts`**:
  - It copies the caller's query once at entry, before any await, freezes the copy and validates **the copy**.
  - Only that copy is used for the producer call and the page check.
  - The Actions query passes through with the same M1 wrapper budget. Role resolution, authorization before and after, and the final role receipt are unchanged.
- **`src/main/services/annex-server.ts`** (route parse only):
  - authorization before parse is unchanged;
  - one fresh parsed object;
  - per-card key sets: Actions takes `card`, `source`, `offset`, `selection`, and Connections keeps `projectOffset`;
  - each key appears once, plus the digit regex;
  - the shared validators.
- **`src/main/services/annex-client.ts`** (`requestDispatcherDetails`):
  - One shallow copy, validated with extra keys rejected, then a frozen normalized page. All of this happens before any await.
  - The URL and response check use only that page. `expectedAgentId` is required and bound.
  - A page 400 gives `unavailable`. 401/403 revoke only the receipt the read ran under (O1, unchanged).
- **IPC and preload:** the argument type widens to `SelectedDispatcherPageQuery`. The runtime object check is unchanged.
- **Renderer:**
  - New `RemoteDispatcherActionsPages` reuses `SelectedActionsPage` (the Dispatcher group is "Made by the Dispatcher", A3). It's keyed to the role pane's context key plus the role agent.
  - A page that names another role agent or doesn't answer the query shows the page error, never rows.
  - `RemoteDispatcherRoleDetails` shows the navigator only when the overview has `inventoryPages === 1` and the Actions source; otherwise it shows a summary-only note.

## Tests

- **Shared:** Actions page accept and reject cases (offset, selection, whole read, connection or helper flags, rows, extra field, other agent, about 307 KB over the cap, bad queries).
- **Service:** the former 7 RED-first tests now pass, with two corrections, both noted in the PR:
  - (a) The "other selection" case now asks with a selection; without one, the contract has nothing to bind.
  - (b) One byte over the budget is refused by the page validator's own byte bound (`dispatcher_details_invalid`) before the outer `dispatcher_details_limit`. Either way it fails closed and is never sent (A2).
  - Also added: a read-once getter control.
  - The existing Connections test's "bad query" changed from the plain Actions query (now valid) to an Actions query carrying `projectOffset`.
- **Producer:** the Dispatcher Actions page at its exact size passes, and one byte under fails closed (from the fixture prep).
- **Route:** the Actions page under the gate; 403 before parse for a refused peer with a malformed Actions query; 10 new malformed Actions shapes give 400 before lookup.
- **Client:**
  - the Actions URL, role-agent and page binding, older-host 400 giving `unavailable`, and a missing `expectedAgentId` or bad shape giving an error with no request;
  - O1 tests extended to `role-actions-page`;
  - capture controls for Connections and Actions (the caller mutates the query after invocation, with no effect);
  - a read-once getter control.
- **Renderer:** Browse, then Next, Previous with the selection, a page from another role agent rejected, a role event resetting to the overview, and an older-host summary note.

## Mutations

See `mutations-run1.txt` and `mutations-run2.txt`. The scripts are saved as `.py.txt`.

- **Discriminating** (each fails at least one targeted test):
  - M1 shared selection binding; M2 shared page byte bound;
  - M3 route Actions key set; M4 route repeated keys;
  - M5 client `expectedAgentId` binding (QA-required); M6 client URL from the caller object (run 2); M7 client response check from the caller object;
  - M8 service producer query from the caller object; M9 service page check from the caller object;
  - M10 renderer role-agent binding; M11 renderer dropping the selection token;
  - M13 service validating the caller object and copying after; M14 the same for the client.
- **Equivalent, no credit:** M12, the renderer identity reset. A role-context change always unmounts the navigator, because the overview read returns to loading. The identity check is defense in depth, as in the Connections navigator.
- Every restore was byte-identical (sha256 of the original bytes).

### Count and test-state attribution (docs-only correction after `e92eed445`)

- **Count:** 14 distinct mutations (M1–M14) in 15 executions. Run 1 covered M1–M12; run 2 re-ran M6 and added M13 and M14.
  - Distinct: 13 of 14 discriminating, and M12 equivalent.
  - Executions: 13 of 15 failed a test. Run 1 had 10 of 12 (M6 and M12 exited 0); run 2 had 3 of 3.
  - The earlier report of "14/15 discriminating" was wrong.
- **M6** is credited only through run 2, after the read-once getter controls were added. Its run 1 survival stays recorded in `mutations-run1.txt`.
- **Source identity:** in both logs, the pre-mutation sha256 of every mutated product file equals its blob at `e92eed445`.
- **Test state:** run 1 ran before the two read-once getter tests were added to `annex-client.test.ts` and `services/selected-dispatcher-details.test.ts`. Run 2 and the full suite ran with them, matching `e92eed445`.
- The raw logs, scripts and full-suite record are unchanged. Only this README's digest changes in `SHA256SUMS`, and the original manifest stays readable at `e92eed445`.
