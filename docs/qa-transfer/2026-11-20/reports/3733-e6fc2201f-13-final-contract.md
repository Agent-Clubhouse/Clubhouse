# Independent QA: #13 selected-board contract, final narrow successor

Reviewer: qa-details-local-composition, November 21, 2026.

- **Target:** `e6fc2201feb28cd8f0af6bb152ea831935188aef`, which matches the tip of `origin/details-local-composition/3733-selected-board-contract`. Parent is `fa39db486`.
- **Change:** one contract document, +64/-12, docs only.
- **Method:** source read on `be0091d16` only. Nothing was executed, and there is no implementation credit.

## Verdict: READY for bounded implementation, no remaining contract blockers

The fa39 mixed-version choices are retained, my B-1 items stay resolved, and every lane gap is closed at contract level. Runtime stays C (refusal) until reviewed code lands. **Canvas-tab navigation to omitted boards remains OPEN.** The preview is partial progress, and nothing here waives the objective.

## Lane gaps: checked against source

- **Pager exclusion: RESOLVED.**
  - `useSelectedInventoryPage.ts:10` `cardFor` does map unknown sources to `skills-mcp`, as stated.
  - The contract:
    - splits the shared types into a row-paged union with unchanged members (managed, Actions, membership) and row-paged guards;
    - types the hook against the row-paged set only, with an exhaustive `cardFor` and no default, so a new source is a compile error;
    - adds the board only to the `RemoteDetailsQuery` transport union.
  - The preview has its own transport.
  - Preserved paths are tested: `RemoteCanvasesCard` eligibility, quick-agent rejection, Dispatcher Connections and Actions only, and the managed subset.
- **Bindable keys and context: RESOLVED.**
  - The page echoes `scope`, `canvasId` and `viewId`.
  - **Exposure claim verified:** `RemoteCanvasMembershipRow` (`shared/remote-canvas-membership-page.ts:6`) already exports exactly `key`, `name`, `scope`, `canvasId` and `viewId`, and the producer emits them raw (`selected-canvas-membership-page.ts:80-81`). The echo adds nothing.
  - **No raw-ID request targeting:** the query is still `card`, `source`, `member` and `selection`, with no raw ids accepted. Raw ids appear only in the response echo, compared against the client's stored row.
  - The member view key equals the row key (`hash([agentId, projectId, scope, canvasId, viewId])`, `:80`).
  - The validator binds `agentId`, `projectId`, `member`, `selection`, the full row context and exactly one member view whose key equals `member`.
  - Wrong-focus and wrong-board mutants are required. Focus lands on the view keyed to the row, not the first agent view.
- **Currentness wording: RESOLVED and accurate.**
  - `annex-client.ts:2691-2692`: `current()` checks satellite identity, connected state and epoch. `receipt = sat.snapshotReceipt` is used only at `:2697` for the late 401/403 `invalidateSnapshotAdmission`.
  - The contract now says exactly this and claims no receipt fence. Freshness is the renderer's obligation.
- **Preview freshness: RESOLVED.**
  - The preview has an explicit store subscription.
  - Every notification re-evaluates the host, `connected`, `snapshotUnavailable`, the membership fence and `remoteCanvasJumpUnavailable`, whether or not the snapshot identity changed, which covers backfill.
  - Settlement is admitted only under the captured fence, a connected and available host, a row still refused for omission or absence, and full ownership.
  - No snapshot, receipt, epoch or store mutation, enforced with spies.
- **`CanvasMembershipList` change:** one optional `secondary` render prop. Local and `RemoteCanvasesCard` don't pass it, and identical output is tested. It is disclosed in the hunk map, along with the `useSelectedInventoryPage` and `remote-details-query` hunks.

## Non-blocking notes for implementation

- **N1 (privacy hygiene):** non-member view keys are `hash([agentId, projectId, scope, canvasId, viewId])` over **other agents'** raw ids. Correlating them back to agents would need those views' `viewId`s, which only an untruncated snapshot carries, and that snapshot already shows everything. So there is no new exposure.
  - Still, keys that don't include other agents' ids would better match the generic "Agent" intent. For example, `hash([member, viewId])`, or a per-page index.
  - Either way, the keys must stay unique and opaque.
- **N2 (liveness):** the membership fence object rotates whenever the snapshot identity changes (`SelectedCanvasMembershipPage.tsx:28-29`). A read settling across a backfill that produces a new snapshot object is discarded even if the row is still omitted. That's safe, but it can churn.
  - Show a "board data changed, read again" status rather than a silent blank, and add a control.
- **N3:** the `annex-server` and `annex-client` hunks keep lane3613 confirmation, which the lane reports as cleared for the mapped route and client hunks. No canvas-plugin hunks are in this slice.

## Required before PR (unchanged)

- The contract's full proof list: shared, host, route, client, renderer, mixed-version frozen fixture, pager exclusion, preview freshness, binding mutants and the list prop.
- RED first, with byte-identical restores.
- tsc, scoped lint and an exact-head bounded run, then the hosted gate and independent exact-source review.
