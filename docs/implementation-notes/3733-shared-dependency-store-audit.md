# Shared dependency store audit (addendum)

Recorded November 21, 2026. This audit is additive. Earlier notes and evidence are unchanged.

## What happened

Local runs used a symlink `node_modules -> ~/.clubhouse/orch/dependencies/bd9cc803…212d/node_modules`. `group-project-remote-create.sim.test.ts` creates temp folders under `process.cwd()/node_modules/.cache` (`gp-rc-*`), so those writes went into the shared store. The suite removes its `gp-rc-*` folders, but it left an **empty `node_modules/.cache` directory in the store**. It has not been deleted (as instructed).

Observed now:
- The store's `node_modules` modification time is `2026-11-21T00:04:05`.
- `node_modules/.cache` modification time is `2026-11-21T02:40:30`, with 0 entries.

Exactly which run created `.cache`, and what changed the store directory at 00:04:05, cannot be determined from the surviving logs.

## When it could have started

The sim suite runs only in full-suite runs and in runs that list it explicitly.
- Runs whose file lists exclude it: the 21:10 and 21:13 composition runs, the 22:29 and 22:35 successor runs, and the focused #14/F1 runs.
- Runs that include it, all through the store symlink:
  - full suites at 23:29:13 (`11fc59dbe`), 23:43:56 (`d702a2705`), 00:04:40 (`d1a2171c6`, fresh short `TMPDIR`) and on `ed13e3060` (fresh default-depth `TMPDIR`)
  - the 48-file `annex-identity` importer run (about 23:4x)
  - the focused 70-file run on `b28fbae69`
  - the isolated sim runs and the uncommitted diagnostic on 2026-11-21

So the store may have been modified from **23:29:13 onward**.

## Claims that must be requalified

Committed evidence containing a store or cache "unchanged" claim:

| Package | Exact wording | Run time | Status |
| --- | --- | --- | --- |
| `docs/implementation-notes/3733-local-role-canvas-composition.md` (`a4edf7adf`) | "Vitest ran with `--no-cache`, and the store's only cache file kept hash `30eb98fe` and its 06:40 timestamp." | 21:13 | Before 23:29. The sim suite was not in that run. The claim stands for its time. |
| `docs/implementation-notes/3733-local-successor.md` (`5e3e21cfe`) | "It was linked only for these runs, then removed, and its cache hash is unchanged." | 22:35 | Before 23:29. The sim suite was not in that run. The claim stands for its time. |

No committed evidence package after 23:29 makes an unchanged-store or cache-hash claim:
- `3733-full-suite-11fc/`, `3733-inherited-28-fixes/`, `3733-ci-3749-run44868309476/`, `3733-main-reconcile-6130/`, `3733-main-535241/` and `3733-main-daa7/` were checked with `git grep` for these phrases.

Messages to the parent before 23:29 said the store was unchanged. Those predate the window. No later message should be read as claiming an unchanged store.

**From 23:29:13 onward, the store is not claimed unchanged.** It now contains an empty `.cache` directory written by these runs.

## Isolation from now on

From the #3592 L1 work on, `node_modules` in this worktree is a real directory of per-entry symlinks into the store, excluding `.cache` and `.vite`. Writes to `node_modules/.cache` and `.vite` stay in the worktree. For the #3592 L1 RED run, the store's `.cache` modification time and entry count were identical before and after (`evidence/3592-l1-recovery-start/store-cache-*.txt` on that branch). Neither the store nor the admission gate was modified to achieve this.
