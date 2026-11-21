# Full-suite evidence for `11fc59dbe`

These are copies of raw output with path prefixes replaced. `SHA256SUMS` lists the raw host-local files and these copies.

| File | Command | Result |
| --- | --- | --- |
| `validated-head.txt`, `pre-status.txt`, `post-status.txt` | `git rev-parse HEAD` and `git status --short` before and after the run | `11fc59dbe`, clean before and after |
| `lint-scope.txt`, `lint.txt` | `git diff --name-only 69ef383ce HEAD -- '*.ts' '*.tsx' \| xargs eslint` | Exit 0, 0 errors |
| `tsc.txt` | `time tsc --noEmit -p .` | Exit 0 |
| `full.txt` | `time vitest run --no-cache --maxWorkers=4` (full suite) | 1476 files: 5 failed, 1458 passed, 13 skipped. 35641 tests: 28 failed, 35499 passed, 114 skipped. Exit 1. |
| `classify-<sha>.txt` | `vitest run --no-cache --maxWorkers=3` on the 5 failing files only, in a temporary detached worktree at each commit | `69ef383ce` (main): 78 passed. `b458b4c89` (Mini base), `26ca06220`, `cb1c98c34` and `11fc59dbe`: the same 28 failed. |

The 28 failures are inherited from the Mini stack and pass on main: `headless-integration` (21), `headless-fallback` (4), `annex-ephemeral-session` (1), `annex-telemetry` route templates (1) and `SettingsCard` remote edge case (1). The composition merges and successors did not introduce them.
