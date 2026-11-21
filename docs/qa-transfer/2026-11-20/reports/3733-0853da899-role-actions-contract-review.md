# Independent QA: #14 role Actions paging contract

Reviewer: qa-details-local-composition. November 21, 2026.
Target: `0853da8991a85f88a86065bb724424f2d766f1ec` (`origin/details-local-composition/3733-role-actions-contract`, remote verified), docs only on main `50cb77ab6`. File: `docs/implementation-notes/3733-role-actions-paging-contract.md`.

Method: I read the contract and the source I had already reviewed (24909/66b0 Actions, b4a4 Canvas wiring, #3755 role paging, M1/M1-a). I ran nothing.

## Verdict

**APPROVE the contract for implementation**, with 3 small specification notes (A1–A3) to fold into the implementation. Phone hunk clearance is separate.

## Sound

- **No new producer:** the host already serves Dispatcher Actions pages.
  - `inventorySources` includes `selected-action-relationships` for Dispatchers. Canvas is non-Dispatcher only.
  - `readSelectedActionDetailsPageForAgent(..., dispatcher=true)` groups `owner.kind === 'dispatcher'`, with the same receipt-hash re-snapshot, page validator and `describeAction` (no prompt or message text).
  - The 409 fences (target, settings, inventory, run) and the M1 `budget` already apply.
- **Route:**
  - Per-card strict key sets (Actions takes `card`, `source`, `offset`, `selection`; Connections keeps `projectOffset`), each key once.
  - Offset is a multiple of 25 below 4096, selection is 64 hex characters, and a nonzero offset requires a selection.
  - Mixed keys, other inventory sources and `projectOffset` on Actions give 400.
  - **Authorization before parse** is kept.
- **Role and currentness:** host-selected role only, with no caller agent id. Authorization before and after, the final role receipt giving 409, and producer 409s passed through.
- **Wrapper validator:** four keys, role and `agentId` match, `inventoryPageOnly` and `inventoryPages === 1`, no connection or helper flags, `isRemoteActionRelationshipPage`, matching source, offset and selection, and the byte bound. Whole reads still reject page-only bodies.
- **Client:** query validation, a required `expectedAgentId`, and response binding to it. A page 400 maps to `unavailable` (older host). O1 receipt-bound 401/403, with the epoch and receipt fence unchanged.
- **Renderer:** eligibility is gated on the overview succeeding plus `inventoryPages` and `inventorySources`. It reuses the pure `SelectedActionsPage` with an ordered selection and resets on the role context key. A page from another role is never shown. No local Actions store and no writes.
- **Unchanged:** Connections paging, ordinary Details and Actions, snapshot receipts and generation, and the pairing frame.

## Notes

- **A1: one shared query validator.** In the route, validate Actions queries with the shared `isRemoteInventoryQuery(q) && q.card === 'actions' && q.source === 'selected-action-relationships'`, on top of the raw-param rules (keys once, digit regex). Don't re-implement the offset and selection rules separately, so the host, the client and ordinary Details can't drift. The same goes for `isSelectedDispatcherActionsPage`, which should compose the existing `isRemoteActionRelationshipPage`.
- **A2: say what the M1 inventory fixture checks.**
  - Unlike Connections pages, inventory pages are **not** text-truncated. `readRemoteAgentDetails` throws `inventory_page_limit` when the page exceeds `budget` (`remote-agent-details.ts` ~119), and that gives a host 500 and a client `error`.
  - The required role fixture should therefore assert:
    - a page exactly at `MAX - overhead` passes, and the wrapped response fits within MAX;
    - one byte over **fails closed** (500 → `error`) with no partial rows, rather than claiming truncation.
  - In practice, 25 rows of names (≤240) and descriptions (≤2048) stay well under the budget. The fixture proves the boundary, not a common path.
- **A3: open question (b).** Yes, show the Dispatcher relationship group exactly as produced (`group: 'dispatcher'`), with the existing presentation and labels reused. Role pages for a Dispatcher are exactly those Dispatcher-owned relationships, so no new grouping or relabelling is needed.

## Required proof (as listed in the contract)

The proof list in the contract is adequate:
- the validator, service, route, client and renderer cases;
- the M1 inventory fixture, as specified in A2;
- red tests first, discriminating mutations with a byte-identical restore;
- tsc, lint, and the store unchanged.

I'd add a mutation removing the `expectedAgentId` binding in the client that fails a test, as with #3755.

## Coordination

The `annex-server.ts` route-parse hunk (~4114–4140) and the `annex-client.ts` `requestDispatcherDetails` hunk (~2641–2675) are disjoint from the naming reservations (~4433, ~6597, ~576). Phone owner (lane 3613) confirmation is still required.
