# #3592 L1: a lost remote-create recovery start

Branch `details-local-composition/3592-l1-recovery-start` from `main` `daa7dab5e`. Source commit `397743bd9ff15b705f1cf8a1fca471bad4f24c78`. Sanitized copies of output.

## Defect

In `group-project-remote-create.ts`, `start()` turned any `groupProjectHost.get` failure into `null` with `.catch(() => null)`. It then skipped `afterCreate` and still saved the answer as started. One transient lookup error therefore lost the membership start permanently. `get` runs `reconcile()` first.

## Evidence

- `observed-failure-focused-b28fbae69.txt`: the observed parallel-load failure. "a crash after the create…" fails at line 338 with `startedOn` for Studio `undefined`. That run was on the #3749 composition, where these files are identical to main.
- `diagnostic-uncommitted-on-2836db383.txt`: an uncommitted diagnostic. With one `get` rejection during the recovery start, the start is never made, even after more retries and a reload. Restored byte-identical.
- What triggered the failure in those parallel runs is **unknown**. The suite mocks `appLog`, so no stderr was left. The fix covers the lost-start class this signature fits. It is not proof of the original trigger.

## Fix

A thrown lookup returns without saving, so `started: false` stays and the next request, `startPending` or a restart retries. It is logged. A genuine `null` (the group is gone) keeps the existing terminal state: the start is settled without `afterCreate`. That is not a successful start.

## Proof on `397743bd9ff15b705f1cf8a1fca471bad4f24c78`

- `green.txt`: the remote-create sim and its 2 other importers. 3 files, 98 passed, exit 0. The existing "started once, then never again" case is retained.
- `red.txt`: main's null-coalescing `start()` restored with the new tests kept. The 2 pending cases fail and the gone-group case still passes. Restore byte-identical, post-restore status shown.
- `tsc.txt` exit 0. `lint.txt` (the 2 changed files) exit 0. `pre-status.txt` clean.

## Dependency isolation used for these runs

`node_modules` in this worktree is a real directory of per-entry symlinks into the shared dependency store, with `.cache` and `.vite` excluded. Writes to `node_modules/.cache` or `.vite` stay in the worktree. The store's `.cache` modification time and entry count were identical before and after the RED run (`store-cache-*.txt`). The store itself was not modified.
