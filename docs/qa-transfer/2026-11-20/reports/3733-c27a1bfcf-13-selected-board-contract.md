# Independent QA: #13 selected-board read contract

Reviewer: qa-details-local-composition, November 21, 2026.

- **Target:** `c27a1bfcf31cd358eb720936e36b0752a48918b7`, which matches `origin/details-local-composition/3733-selected-board-contract`. It is docs only, on `be0091d16` through `b5dcb1ca7`, adding `docs/implementation-notes/3733-selected-board-read-contract.md`.
- **Method:** source read on `be0091d16` only. Nothing was executed. No implementation, live or macOS credit.

## Verdict

**APPROVE WITH ONE REQUIRED CHANGE (B-1).** The authority, privacy, bounds, freshness and no-mutation design is sound. The preview is an honest partial answer to #13, with a stated residual limit.

## B-1 (required): advertising the new source breaks older clients' whole Details read

- `shared/remote-agent-details.ts:96`: `isRemoteAgentDetails` accepts `inventorySources` only if **every** entry is in the client's own `REMOTE_INVENTORY_SOURCES`. There is no tolerance for unknown sources.
- The contract offers the board source "only where Canvas membership is (`inventorySources`, `remote-agent-details.ts:99`)". If the host adds `selected-canvas-board` to the **advertised** overview list, every older desktop client, including current main `be0091d16`, rejects the **entire** remote Details overview as invalid. This is a mixed-version regression far wider than #13.
- **Fix:**
  - Don't add the board source to the advertised `inventorySources`.
  - The host accepts a board query when the membership source is offered. That means changing the `result.inventorySources.includes(query.source)` gate at `:101` to "board requires membership".
  - The new client attempts the board read only when membership is advertised, and maps an older host's `400` (`unsupported_inventory_page` or `invalid_details_query`) to `unavailable`. The contract already specifies that mapping.
  - The new client's page validator must accept a board page whose source isn't listed, provided membership is listed. This replaces the `!!v.inventorySources?.includes(v.inventoryPage.source)` binding at `:97` for this source only.
- **Control:** a new host's overview validated by an old client still passes, using a frozen fixture from the current main validator. The board page requested from an old host gives `unavailable`.

## Shared `isRemoteInventoryQuery` widening impact (checked)

- `remote-details-query.ts:19` sends `canvases` to `isRemoteInventoryQuery`. That's correct for both canvas sources.
- `selected-dispatcher-details.ts:49` (`isSelectedDispatcherActionsQuery`) additionally requires actions plus its source, so it's **unaffected**. Dispatcher role routes keep their per-card key sets.
- `readSelectedManagedPartsPage:15` uses it only as a guard and is reached only in the non-actions, non-canvases branch. Unaffected at runtime, but the type union widens.
- **Required in implementation:**
  - (i) dispatch at `remote-agent-details.ts:106` by **source**, not just card;
  - (ii) `readSelectedCanvasMembershipPage:43` (`isRemoteCanvasMembershipQuery`) must keep refusing a board query, and the board reader must refuse a membership query, with a test for each direction;
  - (iii) `isRemoteInventoryPage` must branch on the board source before its managed-page fallback. The fallback fails closed today, but the explicit branch is needed for acceptance;
  - (iv) the route's allowed-key list at `annex-server.ts:4095` gains `member` **only** for the board source. Membership, actions and managed queries carrying `member` stay `400`.

## Authority and privacy

- **Authority: AGREE.** It's the same `desktopDetailsAuthorized` gate (`:4077`), checked before parse and after every await, for the same principal. Paired desktops already receive **raw** whole-board JSON in untruncated snapshots: `readCanvasState` goes to `snapshot.canvasState` at `:1271-1278`, `:1417`, with omission only at `:1591`. That includes sticky content. So this read is a strict subset of existing exposure.
- **Redaction:** stricter than the snapshot, which is good. No sticky `content` or `color`, plugin ids, zone themes or contents, metadata, raw ids, wires or other boards. Labels go through `display(v,240)`.
- **Never** the mobile routes, `readCanvasState`, `readKey`, the backup, quarantine or restore. A corrupt primary with a backup gives `unreadable`, and a backup-open spy proves it. Correct, and it keeps #3762 separate.

### Open question (a): non-member agent labels

- **Recommendation:** derive non-member agent labels **only from the board's own stored view fields** (`displayName` or `title`, through `display()`), which the untruncated snapshot already exports raw to this principal. **Do not** perform a host agent-registry lookup by `view.agentId`.
  - A registry lookup would be a new projection. It would resolve names for ids the snapshot may not carry, such as helpers, quick agents or agents in other scopes, and it would show current names where the board recorded older ones.
  - If a view has no stored label, show the generic **"Agent"**.
- The selected member's own view may use the selected agent's Details name, since that is already in this response.
- Suffix the board labels with "as recorded on the board", or note it once.
- This matches your preference for generic "Agent" unless an exact permitted projection applies. The stored view label is that projection; the registry name isn't.

### Open question (b): agree

Don't offer the preview for boards that are already navigable.

## Layout, bounds and budget

- 500 views, unique hashed keys, exactly one member view, finite geometry and own-key exactness are good.
- **Note:** 500 views with 240-character labels (up to about 960 bytes each in UTF-8) plus keys and geometry can exceed the M1 budget. That would surface as `500 details_read_failed` rather than the typed `unavailable: 'limit'`.
  - **Recommend:** the producer pre-measures the projected page against the remaining budget and returns `limit`. The final M1 check stays as the backstop.
  - Add an over-budget board control that has 500 or fewer views but long labels.

## Client, freshness, focus and no-mutation

- **Client:** copy the query once before any await, then validate and freeze. Bind the agent, member and selection. O1 revokes only the receipt the read ran under. No cache, retry or snapshot write. **AGREE.**
- **Renderer:** state keyed to `freshnessKey`, selection and row key. `onRefused` re-reads central Details. Spies prove there's no `hydrateFromRemote`, `canvasMutation` or store setter. The canvas-tab jump stays refused. **AGREE.** Keeping fetched boards out of the read-write canvas tab is the right safety line.

## Preview versus the original #13 requirement

- #13, and local parity, means **opening the board in the canvas tab** and focusing the agent there.
- The preview gives a read-only layout with the member highlighted and focused **inside Details**. It is not canvas-tab navigation.
- **Honest classification after implementation:** #13 **Partial**. Read-only selected-board preview is delivered. **Canvas-tab navigation to omitted boards remains a retained limitation.** Closing it needs either snapshot policy (option D) or a reviewed hydration path for remote read-write boards, and neither is in this lane.
- Whether the preview suffices for full-parity acceptance is the user's call. It mustn't be claimed as navigation parity.

## Summary of required items before PR

- B-1: don't advertise; probe with older-host `unavailable`; old-client fixture control.
- Widening points (i) to (iv).
- Label rule (a).
- Pre-measured `limit`.
- Plus the contract's own proof list.
- lane3613 confirmation for the `annex-server` and `annex-client` hunks.
