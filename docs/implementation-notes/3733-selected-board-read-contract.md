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
- **Mutual refusal (QA B-1):**
  - The route admits the `member` key **only** when `source=selected-canvas-board` (`annex-server.ts:4094-4097`). A membership query carrying `member` is 400.
  - A board query carrying `offset` or `projectOffset` is 400.
  - `isRemoteCanvasMembershipQuery` (`shared/remote-canvas-membership-page.ts:16-19`) keeps its key set, so it already rejects `member`. `isRemoteCanvasBoardQuery` rejects every membership-only key.
- **Shared validator:** `isRemoteCanvasBoardQuery` in a new `shared/remote-canvas-board-page.ts`, composed into `isRemoteInventoryQuery` (`shared/remote-inventory-page.ts:25`). Host, client and route share one rule set.
- **Not advertised (QA B-1, mixed versions):**
  - The host must **not** add `selected-canvas-board` to `inventorySources` (`remote-agent-details.ts:99`).
  - Older clients' `isRemoteAgentDetails` requires every advertised source to be in their own `REMOTE_INVENTORY_SOURCES` (`shared/remote-agent-details.ts:96`). One unknown source would make them reject the **whole overview**.
  - The host admits a board query exactly when the computed `inventorySources` includes `selected-canvas-memberships` (non-Dispatcher). Otherwise `400 unsupported_inventory_page`. The admission check at `remote-agent-details.ts:101` (`inventorySources.includes(query.source)`) gains this board-only case. It's unchanged for every other source.
  - Clients discover support by probing: a 400 to the board query means `unavailable` (an older host).
- **Explicit source dispatch:**
  - `readRemoteAgentDetails` (`:100-106`) dispatches by exact source: membership to `readSelectedCanvasMembershipPage`, board to `readSelectedCanvasBoardPage`.
  - Any other `canvases` source is 400.
  - The current two-way `query.card === 'canvases' ? membership : managed` fallthrough must not route a board query to the membership or managed readers.

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
   - the M1 budget, never truncated.
6. **Premeasured budget (QA B-1).**
   - The board reader is given the remaining M1 budget: the producer's `budget` less the serialized bytes of the page-only envelope with `inventoryPage: null`.
   - If the serialized board page would exceed it, the reader returns `unavailable: 'limit'`, even with 500 or fewer views (long labels), instead of letting `remote-agent-details.ts:119` throw `inventory_page_limit` (`500 details_read_failed`).
   - The outer throw stays as defense in depth only.

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

- **Board validator bound to the membership source (QA B-1).** In `isRemoteAgentDetails` (`:97`), an `inventoryPage` of source `selected-canvas-board` is admitted only when `inventorySources` includes `selected-canvas-memberships`, not the board source itself (which is never advertised), and its `agentId` equals the Details `agentId`.
- **Explicit `isRemoteInventoryPage` branch** (`shared/remote-inventory-page.ts:51-54`). Add `source === 'selected-canvas-board'` → `isRemoteCanvasBoardPage`, **before** the managed fallback, so a board page can never be judged by `isRemoteManagedInventoryPage`.
- **Shared source list.** `selected-canvas-board` is added to the query union, but **not** to `REMOTE_INVENTORY_SOURCES` (`:8`). That list stays the advertisable set, and old and new hosts advertise identical lists.

## Redaction and bounds

- **Label:**
  - the member view (the selected agent's own view) is labelled with the selected agent's name, already in this Details body;
  - every **other agent view** is labelled `Agent`, with no name, `displayName` or `title`. No existing permitted Details projection exports other agents' board labels, so this read invents no such exposure. What the snapshot shows the same desktop is a **separate question and isn't relied on** for labels;
  - for other types, `displayName` or `title`, and for anchors, `label`;
  - all through `display(v, 240)` (secret redaction and control replacement).
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
  - the page is premeasured against the remaining M1 budget, giving `unavailable: 'limit'` and never a 500 (see host step 6);
  - removed view types are skipped, as membership does (`:73`).

## Client

`requestAgentDetails` (`annex-client.ts:2683-2721`):
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
- **Transition between preview and snapshot navigation:**
  - The preview action is offered only while `remoteCanvasJumpUnavailable(agent, hit)` returns the omission or "not in the host's current shared snapshot" reason.
    - If it returns null (navigable), the row shows the existing Open action only.
    - If it returns a host or reconnect reason, neither action is offered.
  - It's re-evaluated on every Annex client store change, as the jump subscription already does.
  - If an open preview's row becomes navigable (a later full snapshot contains the board), the preview closes and the row switches to Open. It isn't kept as a second copy.
  - If navigation becomes refused again, nothing reopens automatically; the user can request a fresh preview read.
  - A preview read that's still pending when the row becomes navigable is discarded on arrival.
- **Fallback:** an `unavailable` page (changed, invalid, unreadable, limit, unsupported), an older host (400) or a transport status shows the row's existing refusal reason, plus one line naming the preview status. No retained preview is shown.
- **Freshness:**
  - state is keyed to the card's `freshnessKey` (generation, receipt, pause, retry), the membership `selection` and the row `key`; any change discards it;
  - `onRefused` re-reads central Details (as M2);
  - a page naming another agent, member or selection is never shown.
- No writes, store hydration, `remoteProjectStore` updates or local canvas reads.

## What this does and doesn't deliver for #13

- **Delivers:** read-only, selected, fresh-labelled visibility of an omitted board's layout and where the agent sits on it.
- **Doesn't deliver:** opening that board in the canvas tab. Canvas-tab navigation stays refused while the host's snapshot omits the board, because the canvas tab is a read-write remote surface.
- So this contract **doesn't complete #13**. **Canvas-tab navigation to omitted boards stays OPEN** under the original parity objective. QA can assess this contract's proof and scope, but it can't waive that requirement as product acceptance. The preview is bounded, clearly partial progress.

## Follow-up: safe canvas-tab navigation design path (not in this slice)

This is kept so the objective isn't replaced by the preview. Each step needs its own contract and review after this one.

1. **Read-only canvas origin.** Add a third `dataOrigin` (`'selected-read'`) beside `'local' | 'remote'` (`canvas-store.ts:56`), with its own hydrate entry point. Don't reuse `hydrateFromRemote` (`:85`), which feeds an editable remote surface.
2. **Write paths closed by origin.** Every mutation path is guarded so `'selected-read'` neither **applies locally** nor forwards. The exact writer inventory must cover:
   - **local store mutations**: every canvas-store action that changes state, as declared at `canvas-store.ts:105-151` and implemented from `:1144` (for example `addCanvas`, `removeCanvas`, `renameCanvas`, `addView`, `removeView`, `moveView`, `resizeView`, `updateView`, `updateViewMetadata`, `moveViews`), plus undo and redo, paste and drop, and keyboard shortcuts;
   - **local autosave and persistence** (`main.ts:367-376` and every save or flush);
   - `remoteForward` (`main.ts:515-517`) and every call site.
   - A rough grep isn't an inventory. The exact list is part of that contract. **This path is unapproved.**
   - autosave (`:367-376`);
   - add, remove and rename of canvases;
   - drag, resize, edit, wire and pop-out.
   - The UI shows a read-only banner with the host observation time.
3. **Content stays the redacted projection.** The tab renders this contract's DTO (geometry plus labels, `Agent` for non-members) as placeholder widgets. Sticky notes, plugin widgets and zones render as labelled boxes with no content. No widget plugin code runs against host data. Showing real widget content would need its own exposure review, beyond the snapshot-parity argument.
4. **Jump provenance.**
   - `jumpToRemoteCanvas` (`agent-canvases.ts:146-200`) accepts a second admitted source: a current selected-read page bound to the same host, agent, member, selection, epoch, generation and receipt, checked again when the queued focus fires.
   - The store must hold that exact page object (as `remoteSource.snapshot` identity is checked today).
   - Any later snapshot containing the board takes over through the existing remote path; the selected-read state is discarded.
5. **Isolation.** The selected-read store instance never shares the Home store's local or other-host state (the current collision guard), never persists, and is dropped on host, project or generation change.
6. **Proof:**
   - every mutation path refused (spy on `sendRemoteCanvasMutation` and the saves);
   - focus on the member view;
   - takeover by a full snapshot;
   - revocation and generation reset;
   - colliding ids;
   - no widget plugin code executed with host data.

Hunk ownership would include the canvas plugin (`canvas-store.ts`, `main.ts` and the view components), outside the files this contract touches. That needs the canvas owner's coordination.

## Required proof (before PR)

- **Shared:** the query and page validators, including the own-key, binding, geometry, one-member and byte-cap rejections.
- **Host:** a known membership on a board omitted from the snapshot gives a recorded page.
  - Source replacement between pages, a selection mismatch, an unknown member and an over-500 board give `changed`, `changed` and `limit`.
  - A corrupt primary with a backup present gives `unreadable`, and the backup is never opened (spy).
  - A missing primary with a recovery key present gives `unreadable`.
  - Dispatcher or disposed gives `unsupported`. Authorization is checked before parse and after awaits. No sticky or plugin content leaves the host.
- **Route:** mixed or extra keys and raw ids give 400 before lookup. A refused peer gets the gate's refusal first. `member` is refused on membership queries, and `offset`/`projectOffset` on board queries.
- **Mixed versions (QA B-1):**
  - A **frozen old-client overview fixture**: a test-only copy of the `be0091d16` validators (`isRemoteAgentDetails` with its inventory validators, with the source blob sha256 recorded) must accept the new host's overview for a non-Dispatcher agent, a managed agent and a Dispatcher.
  - The new host's `inventorySources` equal the `be0091d16` list for each case.
  - A board query to a host without the reader (simulated older host) returns 400, and the client maps it to `unavailable`.
- **Dispatch and validators:**
  - source dispatch sends membership and board to their own readers, and other `canvases` sources give 400;
  - `isRemoteInventoryPage` judges a board page only by the board validator, never the managed one;
  - a board page in an overview without the membership source is rejected.
- **Premeasure:** 500 or fewer views with long labels that overflow the remaining budget give `unavailable: 'limit'` (200 with a page-only body), never `500`.
- **Client:**
  - the URL shape;
  - the agent, member and selection binding;
  - an older host's 400 giving `unavailable`;
  - O1 receipt binding;
  - capture controls for mutation and getter reads;
  - an `expectedAgentId`-style binding mutation must fail a test.
- **Renderer:**
  - the preview opens only for omission or absence refusals, never for navigable or host-refused rows;
  - it closes when the row becomes navigable, and a pending read is discarded;
  - non-member agent views show `Agent`, never a name;
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

- (a) Resolved by default: non-member agent views are labelled `Agent`. Showing names would need an exact existing permitted display projection to be identified and reviewed first.
- (b) No preview while valid snapshot navigation is available. The transition and fallback are defined above.
- (c) Whether the preview fulfills #13, or the canvas-tab navigation limitation remains (see "What this does and doesn't deliver").
