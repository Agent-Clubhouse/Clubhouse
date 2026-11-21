# Independent QA: #14 role Actions paging implementation

Reviewer: qa-details-local-composition. November 21, 2026.
Head: `e92eed445d11d5ec569ceb750bd2fa3b7f96e7b6` (`origin/details-local-composition/3733-role-actions-impl`, remote verified, no PR). The chain is `50cb77ab6` → contract `0853da899` → fixture prep `61d4c50f4` and `5159cfb30` (tests only) → implementation `e92eed445`.

Method: I read source and committed artifacts only and ran nothing. This is not live, CI or #14-completeness acceptance.

## Verdict

**APPROVE the source.** A1–A3 are met, the entry-copy capture is used correctly everywhere, and the role and receipt rules are preserved.

**Evidence:** the mutations are bound to the exact head through their product-file hashes. The **full-suite, tsc and lint claims are not sealed exact-head proof** (E-1), so they aren't credited as such. Hosted CI on the PR is the gate.

## Source

- **A1:**
  - `isSelectedDispatcherActionsQuery` is `isRemoteInventoryQuery` plus `card === 'actions'` plus `source === selected-action-relationships`.
  - `isSelectedDispatcherActionsPage` composes `isRemoteAgentDetails` and `isRemoteActionRelationshipPage`. It checks the four-key wrapper, role and `agentId`, `inventoryPageOnly === true`, `inventoryPages === 1`, no connection or helper flags, source, offset and selection (for a recorded page with a query selection), and the byte cap.
  - `isSelectedDispatcherPage` dispatches by card.
- **Route** (annex-server.ts ~4114): authorization before parse is unchanged.
  - The per-card key set is chosen by `params.get('card')`, and any duplicate key, `card` included, is refused by the each-once check.
  - Then the digit regex and the shared validators. Anything invalid gives 400 `invalid_dispatcher_details_query`.
- **Service** (selected-dispatcher-details.ts):
  - `page = Object.freeze({ ...query })` is taken **before any await**, and the **copy** is validated.
  - Only `page` reaches the producer (`page && { ...page }`) and the page check. No raw `query` is used after the entry line.
  - The M1 budget, role resolution, authorization before and after, and the final role receipt are unchanged.
- **Client** (`requestDispatcherDetails`):
  - One shallow copy, so each getter is read once, validated, then a frozen normalized `page`, and `expected = expectedAgentId`. All of it happens before any await.
  - The URL params and the response binding (`isSelectedDispatcherPage(body, page) && body.agentId === expected`) use only the captured values.
  - A page 400 gives `unavailable`. O1 receipt-bound 401/403 and the epoch and receipt `current()` fence are unchanged.
- **IPC and preload:** the type widens to `SelectedDispatcherPageQuery`, with the runtime object check unchanged.
- **Renderer:**
  - `RemoteDispatcherActionsPages` reuses `SelectedActionsPage` (A3: the Dispatcher group is shown as produced).
  - It re-validates `agentId === roleAgentId` and `isSelectedDispatcherActionsPage`, so a mismatch shows an error with no rows.
  - It's keyed on the role context key plus the role agent.
  - The navigator appears only when the overview has `inventoryPages === 1` and the Actions source. Otherwise a summary-only note.
- **Touched hunks** match the cleared areas (annex-server ~4114–4140, annex-client ~2641–2675) plus the #3733-owned shared, service, IPC, preload and renderer files.

## Expectation changes, assessed

- **(a)** The "other selection" fixture now asks *with* a selection. That's correct, because without a query selection there is nothing to bind under the contract.
- **(b)** One byte over the budget is refused by the page validator's own byte bound (`dispatcher_details_invalid`) before the outer `dispatcher_details_limit`. That's acceptable: it fails closed and is never sent, which satisfies A2.
  - The producer-level boundary from the fixture prep (exact size passes, one byte under the budget fails) covers the `inventory_page_limit` path separately.
- **(c)** In the existing Connections test, the "bad query" changed from a plain Actions query, which is now valid, to Actions plus `projectOffset`, which is still invalid. That's correct.

## Mutations, reconciled

- The inventory is **M1–M14, 14 mutations**. M12 (renderer identity reset) is **equivalent, no credit**: a role-context change unmounts the navigator.
- **13 discriminate.** The "14/15" figure in the brief doesn't match the artifacts.
- **M6** (client URL from the caller object) **survived run 1**, which exposed a test gap. After the read-once getter controls were added, **run 2 shows it discriminating**. Credit the run-2 result only. The run-1 survival is honestly recorded.
- **M13 and M14** (validate the caller object, copy afterwards) discriminate in run 2.
- **Binding:** every logged restore SHA256 equals the committed blob at `e92eed445`:

| File | SHA256 |
| --- | --- |
| shared `selected-dispatcher-details.ts` | `d07c9cdd…` |
| `annex-server.ts` | `22d5e74f…` |
| `annex-client.ts` | `f19f6d53…` |
| service `selected-dispatcher-details.ts` | `e6b7f5ee…` |
| `RemoteDispatcherActionsPages.tsx` | `03748c09…` |

  So the mutations ran against the exact head product source. Test-file hashes are not recorded.

## E-1: full-suite, tsc and lint not sealed

- `full-suite.txt` is a 5-line summary: 1468 files passed and 13 skipped, **35867 tests passed** and 114 skipped, exit 0.
- Its own header says "on the implementation tree before commit". tsc and eslint appear only as comment text.
- There is no validated head, no before or after status, no raw output and no source hashes. `SHA256SUMS` covers only the committed copies (all 6 match).
- So these are **owner claims, not exact-head proof**. Before landing, either seal a head-bound run (head before and after, clean status, raw output, exits, source hashes) or rely on hosted CI on the PR head.

## Not covered

Live behaviour, hosted CI, and #14 or #3733 completeness.
