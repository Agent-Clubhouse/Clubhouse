# Independent QA: #3733 checklist audit and #13 navigation options

Reviewer: qa-details-local-composition, November 21, 2026.

- **Target:** `35c818a2f5875765e6922bb8db3cb9a955020776`, which matches `origin/details-local-composition/3733-checklist-audit-be00`. It is a single docs-only commit on top of `be0091d16`, adding `3733-checklist-audit-be00.md` and `3733-omitted-board-navigation-options.md`.
- **Method:** I read only source on `be0091d16` and ran nothing.

## Classifications: spot-checked against source

- **Item 6 (Changes): "Partial", CONFIRMED.**
  - `read-only-repository-changes.ts:134` runs rename detection only when `query.scope !== 'branch'`, so branch-scope renames appear as a delete plus an add, with no note.
  - Mode `120000` is excluded from content at `:102` and forced to `unsafe` evidence at `:203`. The link's own metadata is never shown, while local shows the link destination's metadata but not the target's contents.
  - Both gaps remain **open**, and this is not a "follow the symlink" requirement.
- **Item 7b (#13): "Open", CONFIRMED.** The gate is in `src/renderer/features/agents/details/agent-canvases.ts:120-135` (the doc abbreviates the path). It refuses on omitted `canvasState`/`appCanvasState`, or when the board is absent from the current snapshot.
- **Item 4: CORRECTION. It should be "Open", not "Unknown".**
  - The doc says the 2000-event reference "doesn't resolve on be00". It does: `src/renderer/stores/remoteChatBackend.ts:58-64` requests at most 2000 transcript events (`Math.min(tail ?? 2000, 2000)`).
  - Together with `CHAT_DETAILS_LIST_LIMIT = 64` and the absence of any continuation, the checklist gap at `finite-local-delta:33-35` is still present in source.
  - Classify item 4 as **Open**, using the checklist's discriminators (more than 2000 events, more than 64 children, a child outside the tail, a resumed history).
- **Issue-state note:** gh now reports #3733 as **OPEN**, which agrees with the doc's "later reopened".
- I didn't check the remaining "Closed in source" rows line by line in this pass. They need independent review if they will be used for closure.

## #13 options

- **A is excluded: AGREE.** The client backfill (`annex-client.ts`) uses the whole-store `/api/v1/mobile/canvas[/:projectId]` routes. `handleMobileCanvasRoute` calls `readCanvasState`, which can recover by quarantining or restoring a backup. The omission marker is not a selected-board receipt.
- **The mobile exclusion is CORRECT.** Recovery-backed whole-store reads must not become navigation authority.

### Is Option B new authority or expanded access? (assessed)

- **Existing access, from source:**
  - `/api/v1/mobile/canvas` and `/:projectId` (`annex-server.ts:3600`, routes at `:4841-4842`) have **no per-route authorization**. Any peer that passes `authenticatePeer` reaches them, phones included, which is broader than desktop-only.
  - They return **whole canvas stores** for every project and the app.
  - The paired desktop client already pulls this content automatically (`fetchOmittedCanvases`). Untruncated snapshots already carry `canvasState`.
  - So the paired desktop controller **already receives board content** for every board under the existing pairing.
- **Option B is therefore not a grant expansion.**
  - B would add a narrower read: one board, bound to a membership row of the host-selected agent, behind `desktopDetailsAuthorized`. That gate (`:4077`) requires a desktop peer, re-authorization and no pending or mobile session, which is stricter than the mobile routes.
  - It needs no new principal, capability or data class, so it doesn't require a user scope or access decision on access grounds.
  - It is still a **new route** with a new read surface. It needs ordinary design and source review, writer clearance, and lane3613 coordination for the `annex-server` and `annex-client` hunks.
- **The real decision is product and effort, not access.** It is whether full parity requires navigation to omitted boards, which per the clarified acceptance it plausibly does (navigation is an applicable local capability). Keeping the refusal (Option C) is a temporary safety posture, not parity completion.
- **Recommendation:** retitle B as "new passive selected-board route under the existing desktop Details authority (no access expansion)". Keep its freshness contract (items 1-7), which I consider sound. In particular:
  - passive stat-only reads with no quarantine and never reading the backup;
  - membership re-read binding;
  - provenance labelling and no merge into `sat.snapshot`;
  - O1 receipt revocation;
  - a re-check on queued focus;
  - no write-back.
- **Observation, outside #13 scope, recorded for the owner:** the existing mobile canvas routes, reached automatically by the desktop backfill, can trigger host-side quarantine or restore during what the user sees as a read. This is pre-existing behaviour, not introduced here. It may deserve its own issue under the standing "investigate, then file" practice.

## Verdict

- The audit doc is accurate except item 4, which should be Open. The Changes gaps are confirmed.
- The #13 analysis is sound, but B is mischaracterized as new authority: it is a narrower route under existing access. It still needs a product decision, writer clearance and lane coordination before implementation.
- There is no completion or closure credit, and no live or macOS acceptance.
