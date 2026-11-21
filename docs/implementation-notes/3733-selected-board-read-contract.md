# #13 B: passive selected-board read (contract and hunk map)

Recorded November 21, 2026, from `main` `be0091d16`, for QA and lane3613 review **before implementation**. It amends `3733-omitted-board-navigation-options.md` under the parent's scoped approval. Runtime behavior stays C (refusal) until a reviewed implementation lands. This doesn't complete #13 or #3733.

## Scope and supersession

- **Narrow supersession.** This supersedes the selected Details contract's "no board payload export" and "board contents are not shared" exclusion (`selected-canvas-membership-page.ts:1,94`) **only** for one read:
  - the read is selected, bound to a current membership, bounded and redacted;
  - its result carries its own provenance and freshness.
- **Authority unchanged.**
  - Same principal and gate: `desktopDetailsAuthorized` (`annex-server.ts:4077-4081`), authorization before parse, rechecked after every await.
  - No new principal, grant or data class: paired desktops already receive whole boards in untruncated snapshots (see the options note).
- **Never:**
  - the mobile canvas routes, `readCanvasState` or plugin-storage `readKey`, or any read of recovery or backup contents;
  - quarantine, rename or restore;
  - merging into `sat.snapshot`, `remoteProjectStore` or any canvas store;
  - `hydrateFromRemote`, `canvasMutation` or any write;
  - whole-store export.

## Query (host route, unchanged path)

Same GET: `/api/v1/agents/:id/details`, gated as today (`annex-server.ts:4084-4098`). A new inventory source:

```
card=canvases&source=selected-canvas-board&member=<64 hex>&selection=<64 hex>
```

- **`member`** is the `key` of a row from a `selected-canvas-memberships` page: `hash([agentId, projectId, scope, canvasId, viewId])`, from `selected-canvas-membership-page.ts:80`. No raw board, view or path id is accepted.
- **`selection`** is that membership page's `selection` (`:90`). Both are required.
- **Key rules:** exactly `card`, `source`, `member`, `selection`, each once, with no `offset` or `projectOffset`. Anything else is `400 invalid_details_query`.
- **Shared validator:** `isRemoteCanvasBoardQuery` in a new `shared/remote-canvas-board-page.ts`, composed into `isRemoteInventoryQuery` (`shared/remote-inventory-page.ts:25`). Host, client and route share one rule set.
- **Sources:** the board source is offered only where Canvas membership is (`inventorySources`, `remote-agent-details.ts:99`; non-Dispatcher). Otherwise `400 unsupported_inventory_page`.

## Host read (one passive observation)

New `main/services/selected-canvas-board-page.ts`. It factors the store walk out of `readSelectedCanvasMembershipPage` so both share one parser.

1. **Admission:** reject the Dispatcher project, Dispatcher identity and disposed agents (as `:48`).
2. **Read the primaries:** the Home and selected-project `canvas-instances.json`, through `readReadOnlyConnectionSourceMetadata` (`:60`) with the same budget. Push each source receipt, the stat-only `missingRecoveryReceipt` (`:25-38`) and the home receipt.
3. **Re-derive membership** from this same parse: the rows and the `selection`.
   - If `selection !== query.selection`, or no row has `key === query.member`, return `unavailable: 'changed'`.
   - The board is the one containing that row's `viewId`, in that row's scope.
4. **Project that board only** (redaction and bounds below), with a combined receipt over all the pushed receipts.
5. **Producer fences in `readRemoteAgentDetails`:** the board page goes through the existing inventory-page branch (`remote-agent-details.ts:100-120`), so it gets:
   - the target witness (`409 agent_inventory_changed`);
   - settings (`409 settings_evidence_changed`);
   - inventory receipts (`409 inventory_evidence_changed`);
   - the run check (`409 agent_run_changed`);
   - authorization (403);
   - the M1 budget, never truncated: over budget is `500 details_read_failed`.

## DTO

The Details body is page-only (`inventoryPageOnly: true`, the `canvases` card requested, others `requested: false`), as for membership pages. `inventoryPage`:

```ts
type RemoteCanvasBoardPage = { version: 1; source: 'selected-canvas-board'; agentId: string; projectId: string;
  member: string; selection: string; observedAt: number; notes: string[] } & (
  | { state: 'unavailable'; reason: 'changed' | 'invalid' | 'unreadable' | 'limit' | 'unsupported' }
  | { state: 'recorded'; scope: 'app' | 'project'; board: string /* hash([scope, canvasId]) */; name: string;
      views: RemoteCanvasBoardView[]; total: number });
type RemoteCanvasBoardView = { key: string /* hash([board, viewId]) */; type: 'agent' | 'anchor' | 'plugin' | 'sticky-note' | 'zone';
  label: string; member: boolean; x: number; y: number; w: number; h: number; z: number };
```

`isRemoteCanvasBoardPage(value)` checks:
- own keys only;
- `agentId` equals the Details `agentId` (as the membership `:97` binding does);
- `member` and `selection` match the query;
- exactly one `member: true` view, whose key derives from the row;
- `views.length === total ≤ 500`;
- finite geometry;
- unique keys;
- the byte cap.

`shared/remote-agent-details.ts:97-98,123` map both canvas sources to the `canvases` card.

## Redaction and bounds

- **Label:**
  - for agent views, the host's known display name for `view.agentId` when it's admitted for display, else `displayName` or `title`;
  - for other types, `displayName` or `title`, and for anchors, `label`;
  - all through `display(v, 240)` (secret redaction and control replacement).
  - The selected agent's own view is labelled with its name.
- **Not exported:**
  - sticky-note `content` and `color`;
  - plugin `pluginWidgetType` and `pluginId` (type `plugin` and a label only);
  - zone `themeId` and `containedViewIds`;
  - `metadata`, `projectId` and raw `agentId`;
  - wire definitions;
  - other boards; the store's active canvas.
- **Bounds:**
  - more than 500 views gives `unavailable: 'limit'`;
  - the membership walk keeps `REMOTE_CANVAS_MEMBERSHIP_MAX_ITEMS` (4096 visits);
  - the body stays within the M1 budget;
  - removed view types are skipped, as membership does (`:73`).

## Client

`requestAgentDetails` (`annex-client.ts:2683-2700`):
- **Capture:** copy the query once before any await, validate the copy, then build a frozen page. The URL params are `card`, `source`, `member`, `selection`.
- **Response:** must pass `isRemoteAgentDetails(body, agentId)` and be page-only with an `inventoryPage` that passes `isRemoteCanvasBoardPage`, with equal `member`, `selection` and `agentId`. Otherwise `error`.
- **Status mapping:**
  - 400 to this page query from an older host gives `unavailable`;
  - 404/405/409 give `unavailable` as today;
  - 401/403 revoke only the receipt the read ran under (O1, `invalidateSnapshotAdmission(sat, receipt)`), with the epoch and receipt `current()` fence unchanged.
- No cache, retry loop or snapshot write.

## Renderer and focus behavior

- **Navigation unchanged.** `remoteCanvasJumpUnavailable` and `jumpToRemoteCanvas` (`agent-canvases.ts:120-200`) don't change. A board absent from the current snapshot still can't be opened in the canvas tab. The canvas tab is read-write for remote boards (`main.ts:515-517` forwards mutations), so a fetched board must never enter it.
- **New read-only preview.** A `RemoteCanvasBoardPreview` sits inside `SelectedCanvasMembershipPage` (`:61`).
  - Rows whose jump is refused because of omission or absence get "Preview board (read-only)".
  - It reads through `agentDetails(machine, agentId, query)` with the row's `key` and the page's `selection`.
- **What it shows:**
  - the board name;
  - "Read from <host> at <time>. A separate host observation, not the live canvas. Not editable here.";
  - a scaled read-only layout of view boxes (labels and type, no content), plus an equivalent accessible list.
- **Focus:** the member view is highlighted and scrolled into view, and gets keyboard focus when the preview opens. That's the focus behavior; there's no canvas-tab focus.
- **Freshness:**
  - state is keyed to the card's `freshnessKey` (generation, receipt, pause, retry), the membership `selection` and the row `key`; any change discards it;
  - `onRefused` re-reads central Details (as M2);
  - a page naming another agent, member or selection is never shown.
- No writes, store hydration, `remoteProjectStore` updates or local canvas reads.

## Required proof (before PR)

- **Shared:** the query and page validators, including the own-key, binding, geometry, one-member and byte-cap rejections.
- **Host:** a known membership on a board omitted from the snapshot gives a recorded page.
  - Source replacement between pages, a selection mismatch, an unknown member and an over-500 board give `changed`, `changed` and `limit`.
  - A corrupt primary with a backup present gives `unreadable`, and the backup is never opened (spy).
  - A missing primary with a recovery key present gives `unreadable`.
  - Dispatcher or disposed gives `unsupported`. Authorization is checked before parse and after awaits. No sticky or plugin content leaves the host.
- **Route:** mixed or extra keys and raw ids give 400 before lookup. A refused peer gets the gate's refusal first.
- **Client:**
  - the URL shape;
  - the agent, member and selection binding;
  - an older host's 400 giving `unavailable`;
  - O1 receipt binding;
  - capture controls for mutation and getter reads;
  - an `expectedAgentId`-style binding mutation must fail a test.
- **Renderer:**
  - the preview opens only for refused rows;
  - the member is highlighted and focused;
  - generation, receipt or selection changes discard it;
  - another agent's page is rejected;
  - `hydrateFromRemote`, `canvasMutation` and the store setters are never called (spies);
  - the canvas-tab jump is still refused.
- **Mutations:** RED first, discriminating mutations with byte-identical restore, `tsc` and scoped lint.
- **Exact-head bounded affected run:** the hosted CI gate.

## Hunk map (`main` `be0091d16`), coordination via the parent relay

| File | Hunk | Owner and notes |
| --- | --- | --- |
| `src/shared/remote-canvas-board-page.ts` | new | #3733 |
| `src/shared/remote-inventory-page.ts` | `REMOTE_INVENTORY_SOURCES` `:8`, query union `:11`, `isRemoteInventoryQuery` `:25-31`, `isRemoteInventoryPage` `:51` | #3733 |
| `src/shared/remote-agent-details.ts` | `inventoryPage` and card mapping `:97-98,123` | #3733 |
| `src/main/services/selected-canvas-membership-page.ts` | factor the store walk (`:51-85`), no behavior change | #3733 |
| `src/main/services/selected-canvas-board-page.ts` | new | #3733 |
| `src/main/services/remote-agent-details.ts` | `inventorySources` `:99`, dispatch `:106` | #3733 |
| `src/main/services/annex-server.ts` | `handleAgentSettingsDetailsRoute` query parse `:4094-4097` (adds the `member` key for the board source only) | **lane3613: please confirm no overlap** |
| `src/main/services/annex-client.ts` | `requestAgentDetails` `:2683-2721` (params and response binding) | **lane3613: please confirm no overlap** |
| `src/renderer/features/agents/details/SelectedCanvasMembershipPage.tsx` | the row action at `:61` | #3733 |
| `src/renderer/features/agents/details/RemoteCanvasBoardPreview.tsx` | new | #3733 |
| Tests | the matching tests | #3733 |

No preload or IPC signature change: `agentDetails` already takes a `RemoteDetailsQuery` object, and the union widens in shared. `agent-canvases.ts`, the canvas plugin and `remoteProjectStore` are **unchanged**.

## Related, separate

#3762 (LOW, filed by QA) covers the provenance of backup-fallback canvas data in the snapshot, mobile and backfill paths. It's a separate follow-up. This contract doesn't read through those paths, and it doesn't widen its scope to address them.

## Open questions for review

- (a) Agent labels: confirm that showing other agents' host display names on the board matches what the snapshot already shows the same desktop. If not, label non-member agent views "Agent" only.
- (b) Whether to offer the preview also for boards that **are** in the current snapshot. Proposed: no, since those already navigate.
