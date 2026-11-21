# #13 omitted-board navigation: options and freshness contract

Recorded November 21, 2026, against `main` `be0091d16` (tree `65fc29a44`). This is a design note only: no code, tests, live hosts or network reads. It builds on `3733-omitted-board-navigation-boundary.txt` (investigated at `532f2ee4b`), which still holds on `be00`.

## Current behavior (source)

- **Navigation gate:** `agent-canvases.ts:120-135` `remoteCanvasJumpUnavailable`.
  - It refuses unless the agent and project are on the same host, the host is connected with a snapshot available, and the current snapshot neither omits `canvasState` (or `appCanvasState` for app boards) nor lacks the exact board, view and agent membership.
  - `jumpToRemoteCanvas` (`:146`) re-checks the gate before focusing and when the queued jump fires (`:160`, `:185`).
- **Client backfill:** `annex-client.ts`.
  - When a snapshot omits `canvasState`, the client keeps the previous `canvasState` and `appCanvasState` (`:1172-1175`), then calls `fetchOmittedCanvases` (`:1203`, `:1377-1417`).
  - Per connection, that requests every project store and the app store from `/api/v1/mobile/canvas/:projectId` and `/api/v1/mobile/canvas`. `refetchOmittedCanvas` (`:1338-1371`) re-requests one store after a `stateOmitted` marker, and `fetchNewProjectCanvases` (`:1424-1460`) covers projects that appear later.
  - Results are merged into `sat.snapshot` only while the snapshot still omits canvases, and a full snapshot supersedes running fetches (`:1176-1178`).
  - The snapshot keeps `snapshotTruncated.omitted`, so the gate keeps refusing even after the backfill.
- **Membership evidence:** `selected-canvas-membership-page.ts` reads the selected agent's board memberships passively. Recovery keys are stat-only (`:23-36`). It returns names and ids, not board content or a content-read receipt.

## Options

| Option | What it would do | Assessment |
| --- | --- | --- |
| **A. Freshness rule over the client backfill** | Allow the jump when the board is present in backfilled state despite the omission marker. | **Excluded.** The backfill comes only from the mobile whole-store canvas routes. Those are recovery-capable (`readCanvasState` → plugin-storage `readKey` can quarantine corrupt JSON and fall back to a backup) and aren't selected-board reads. Treating them as navigation authority would equate broad sync with a selected read. The omission marker isn't a selected-board receipt, and later truncated snapshots can't attest freshness. Not used. |
| **B. New passive selected-board read on the Details surface** | A host route gated by `desktopDetailsAuthorized`, keyed by the host-selected agent plus `{scope, canvasId, viewId}` from a current membership page row. It reads primary canvas metadata passively and returns one bounded board projection the canvas plugin can hydrate for focus. | **Possible, but new read authority.** It touches `annex-server` (route), `annex-client` (request), preload/IPC, the canvas plugin's remote hydration and focus, and the membership reader. That needs explicit approval of the new authority and lane3613 hunk coordination for `annex-server` and `annex-client`. Proof obligations are below. |
| **C. Keep refusal (status quo)** | Omitted boards stay unavailable with the existing reasons ("The host omitted canvas data… open it on the host" or "not in the host's current shared snapshot"). | **No new authority.** The reasons are already shown and accessible (`CanvasMembershipList` `aria-describedby`). Membership names stay readable through the membership pages. |
| D. Change host snapshot truncation | Make the host keep selected boards in snapshots. | Out of scope: a snapshot-protocol and size-policy change that this read-only lane doesn't own. |

**Recommendation:** C now. Record #13 as a retained limitation, and pursue B only if the product owner wants navigation to omitted boards and approves a new passive selected-board read. A isn't pursued under the standing constraint.

## Freshness and authority contract for B (if approved)

1. **Authority:**
   - the same pinned desktop `desktopDetailsAuthorized` gate, checked before parse and again after every await;
   - no phone, controller or mobile grant;
   - the host selects the agent; no caller-chosen path, store or project outside the agent's strict target.
2. **Selection binding:**
   - the request names a membership row (`scope`, `canvasId`, `viewId`) for the host-selected agent;
   - the host re-reads membership in the same passive read and refuses (409) if the row isn't present;
   - no whole-store or other-board content.
3. **Passive read:**
   - primary metadata only, using the same stat-only recovery rule as `selected-canvas-membership-page.ts:23-36`;
   - never quarantine, rename or restore;
   - a corrupt or ambiguous primary is unavailable, not repaired.
4. **Bounds:**
   - one board, a byte cap at or below `REMOTE_DETAILS_MAX_BYTES`, and a views cap;
   - sticky-note and other content is redacted or omitted per the existing remote presentation rules;
   - an over-cap board fails closed.
5. **Currentness:**
   - final source, target and run receipts as for other Details pages;
   - client-side binding to the satellite epoch, `connectionGeneration` and `snapshotReceipt` at request time;
   - 401/403 revoke only the receipt the read ran under (O1);
   - a page from another host, project or agent is never shown.
6. **Hydration and focus:**
   - the fetched board is labelled with its own provenance (selected read, observed time) and never merged into `sat.snapshot.canvasState` as if it came from a snapshot;
   - the jump re-checks the same receipt, epoch and generation when the queued focus fires;
   - colliding local and other-host ids stay refused;
   - no save or flush path can write a fetched remote board back.
7. **Proof** (RED first, discriminating mutations):
   - known membership on an omitted board;
   - a later truncated snapshot;
   - replacement of the source between the membership read and the board read;
   - a selection change;
   - reconnect or new generation; revocation;
   - colliding ids; over-cap boards; corrupt primary with a backup present (must not read the backup);
   - an older host without the route giving unavailable.

## Coordination

`annex-client.ts` and `annex-server.ts` hunks for B can't be named until B is approved. When they can, they go through the parent relay to lane3613 with exact current ranges. Option C needs no hunks.
