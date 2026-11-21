# Independent QA: #3592 L1 recovery-start fix and shared dependency-store audit

Reviewer: qa-details-local-composition. November 21, 2026. I read source and artifacts only and ran nothing.

## #3592 L1: APPROVE

- **Head:** `130fe964bb8bd6504eef346348115c1626116392` (`origin/details-local-composition/3592-l1-recovery-start`, remote verified).
- **Source:** `397743bd9ff15b705f1cf8a1fca471bad4f24c78`, one commit on main `daa7dab5e`.
- **Docs-only tips:** `37cafcc70` adds the evidence, and `130fe964b` clarifies the README only. Source and `SHA256SUMS` are unchanged.

### Source (`group-project-remote-create.ts:223-242`)

- **Before:** `groupProjectHost.get(...).catch(() => null)` treated a failed lookup as an absent group. It then skipped `afterCreate` and saved the entry without `started:false`, so the start was lost permanently.
- **After:**
  - A thrown lookup is logged and **returns without saving**, so `started:false` stays and the next request, `startPending` or a restart retries.
  - A genuine `null` (the group is gone) still settles without `afterCreate`. That is unchanged and is not counted as a successful start.
  - The creation answer (`created` plus `groupProjectId`) is the existing receipt and is unaffected.
  - Pre-existing behaviour is kept: an `afterCreate` error is still logged and settled ("membership catches up on its next reconcile").
- **Exactly once:** every caller runs `start()` inside `serial('machine:…')` (`startPending` :246, and :286/:290/:444 in chain). So a retry can't double-start, and a settled entry returns early on `entry.started !== false`.

### Tests (3 new)

- A thrown lookup stays pending, then the next request starts the group **exactly once**.
- A thrown lookup stays pending, then a restart recovers it **exactly once**.
- A gone group is settled without starting and is never asked again.
- The original :338 "never again" case is retained.

### Evidence (`evidence/3592-l1-recovery-start/`)

- **Seals and head:** all 10 seals match. `validated-head` is `397743bd9`, with an empty pre-status.
- **Results:**

| Check | Result |
| --- | --- |
| Green | 3 files, **98 passed**, exit 0 |
| tsc | exit 0 |
| eslint | exit 0 |
| `red.txt` (main's null-coalescing restored, new tests kept) | the 2 "stays pending" cases fail, and "settles a group that is gone" passes (the null control) |
| Restore | byte-identical, with a clean post-status |

- **Retained context:**
  - the observed focused failure on `b28fbae69`;
  - the uncommitted diagnostic on `2836db383` (1 failed, restored byte-identical);
  - the store `.cache` before and after.
- **Not established:** what triggered the original parallel failure is **unknown**. The fix covers the defect that run exposed.

## Shared dependency-store audit: verified

- **Commit:** `33cfd9cf02896ea7757b951279a2baa635261ee1`, `docs/implementation-notes/3733-shared-dependency-store-audit.md`, docs-only on top of `2836db383`.
- **Window:** writes are possible from **23:29:13** onward, from the runs that include the sim suite through the store symlink.
- **Two committed "unchanged" claims,** both made before the window by runs that did not include the sim suite:
  - `a4edf7adf` composition notes at 21:13 (cache hash `30eb98fe`);
  - `5e3e21cfe` successor notes at 22:35.

  Both stand for their time.
- **No claim after 23:29:** I independently grepped the six later evidence packages (`3733-full-suite-11fc`, `3733-inherited-28-fixes`, `3733-ci-3749-run44868309476`, `3733-main-reconcile-6130`, `3733-main-535241`, `3733-main-daa7`). None contains an unchanged-store or cache claim.
- **My reports:** none asserts an unchanged store or cache. The a4edf7adf review only quoted the notes' environment claim, which predates the window. **No re-qualification of my verdicts is needed.**
- **Isolation from now on:** the per-entry dependency links that exclude `.cache` and `.vite` are adequate. Nothing was deleted.
