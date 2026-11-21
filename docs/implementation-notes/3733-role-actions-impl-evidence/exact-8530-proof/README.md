# Exact-head proof for `8530a956f9b6ebe0076dd187b244e4691ab113b6`

This is one bounded, risk-targeted run on the exact head `8530a956f` (tree `1dc6b23803a34d9f1a7a5446839d7513d121ea8c`). The tree was clean before and after (`state-before.txt`, `state-after.txt`). It closes QA's E-1: the earlier `full-suite.txt` and the tsc/lint lines are owner claims made before the commit, not sealed exact-head proof. Those originals are unchanged; this run is the exact-head proof. It is not a full-suite repeat.

## What ran

`run.sh.txt` is the script exactly as executed, apart from path normalization.

- **vitest:** `--no-cache --maxWorkers=4`, fresh TMPDIR. Exit 0: 28 files, 1,788 tests (`vitest-raw.txt`, `argv-vitest.txt`).
- **tsc:** `tsc --noEmit` over the whole project, the existing `typecheck` script. Exit 0, empty output (`tsc-raw.txt`).
- **eslint:** the 8 touched product files and the 7 touched test files. Exit 0 with 0 errors; the warnings are existing ones (`eslint-raw.txt`).
- **Gate:** the load was measured before and after (in the state files). No installs; isolated per-entry `node_modules`.

Source identity: `hashes-before.txt` and `hashes-after.txt` list the working-tree sha256 and the `HEAD` blob sha256 for every touched product and test file. All rows match, and the before and after files are identical.

## Affected-suite scope (importer map)

| Touched product file | Tests in this run |
| --- | --- |
| `src/shared/selected-dispatcher-details.ts` | `src/shared/selected-dispatcher-details.test.ts`; importers `services/selected-dispatcher-details.test.ts`, `annex-server.test.ts`, `annex-client.test.ts`, `renderer/features/dispatcher/*` |
| `src/main/services/selected-dispatcher-details.ts` | `services/selected-dispatcher-details.test.ts`; route integration in `annex-server.test.ts` |
| (producer, unchanged; test added) | `src/main/services/remote-agent-details.test.ts` |
| `src/main/services/annex-server.ts` (route parse) | `src/main/services/annex-server.test.ts` |
| `src/main/services/annex-client.ts` (`requestDispatcherDetails`) | `src/main/services/annex-client.test.ts` |
| `src/main/ipc/annex-client-handlers.ts` (type only) | `src/main/ipc/annex-client-handlers.test.ts`; source scanners `group-project-person-author-boundary.test.ts`, `renderer/plugins/builtin/group-project/GroupProjectCanvasWidget.test.ts` |
| `src/preload/annexClient.ts` (type only) | `src/preload/index.test.ts` |
| `src/renderer/features/dispatcher/RemoteDispatcherActionsPages.tsx`, `RemoteDispatcherRoleDetails.tsx` | the whole `src/renderer/features/dispatcher` directory (17 files, including `RemoteDispatcherDetails.test.tsx` and `DispatcherView.test.tsx`); `DispatcherView` render paths `renderer/chrome/ChromeSidebar.test.tsx`, `ChromeBody.test.tsx` |

That makes 9 explicit files, 17 in the directory and 2 chrome files: 28, matching the run.

Not in scope: other modules that import `annex-client.ts` or `annex-server.ts` without exercising these hunks. Only the earlier pre-commit full suite covered them, and that's an owner claim, not exact-head proof.

## Portability

The committed copies are path-normalized: the worktree path becomes `<worktree>`, the TMPDIR root `<TMPDIR>`, and the home directory `<home>`. `raw-originals.sha256` holds the sha256 of each unnormalized original. Files without local paths are byte-identical to their originals. `SHA256SUMS` seals the committed copies.
