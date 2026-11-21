# Evidence for the local #3733 role and Canvas composition

Captured November 20, 2026 on the local desktop. These are copies of the raw command output. Only path prefixes were changed: `<worktree>`, `<deps-store>` (the shared dependency store `~/.clubhouse/orch/dependencies/bd9cc803…212d/node_modules`) and `<home>`. `SHA256SUMS` lists the raw host-local files and these copies.

| File | Command | Tree |
| --- | --- | --- |
| `tests.txt` | Focused file list passed to Vitest | n/a |
| `focused-1.log` | `vitest run --no-cache --maxWorkers=4 $(cat tests.txt)` | `cb1c98c34` plus the uncommitted view fix and new tests, before the inherited-assertion updates. 2 failed, 1716 passed. |
| `focused-2.log` | Same command | `cd5fbb3a65c97dee357f310711333f90ad11bf13`, clean tree. 1718 passed. |
| `validated-head` | `git rev-parse HEAD` written just before the typecheck | `cd5fbb3a6` |
| `tsc.log` | `time tsc --noEmit -p .` | `cd5fbb3a6`. Exit 0. |
| `tsc-files.txt` | `tsc --noEmit -p . --listFilesOnly` | `cd5fbb3a6`. Shows resolution stays in the worktree and the dependency store. |
| `lint.log` | `git diff --name-only 69ef383ce HEAD -- '*.ts' '*.tsx' \| xargs eslint` | `cd5fbb3a6`. 31 errors, 784 warnings. |
| `errfiles.txt` | Files with lint errors, from an earlier `grep -B1` extraction | Incomplete: lists 22 of the 24 files. Kept unchanged as it was first committed. |
| `errfiles-raw.txt` | Every file with an `error` line in `lint.log`, extracted with awk | 24 files, all byte-identical to `b4a47c3c0` at `a4edf7adf`. |
| `errfiles-vs-main.txt` | Each of the 24 files compared with `main` `69ef383ce` | 21 new and 3 modified relative to main. |

Vitest's non-TTY default reporter prints only failures and the summary, so per-test names are not in the logs. The frozen review commit `a4edf7adff8529e3be35820356079b272fbe4a44` differs from `cd5fbb3a6` only by adding `docs/implementation-notes/3733-local-role-canvas-composition.md`. `git diff --name-status cd5fbb3a6 a4edf7adf` shows that single `A` line, and the `ls-tree` listings of both commits match once that path is excluded.

## Corrections

- The first push (`5b6538f9c`) left out the four `.log` files because `.gitignore` ignores `*.log`. They are now added with `git add -f`, byte-for-byte as first sanitized. The `SHA256SUMS` entries for them are unchanged.
- The error files number 24, not 22. The earlier extraction missed `src/main/services/agent-config.ts` and `src/main/services/read-only-repository-changes.ts`. The total of 31 errors (20 `no-control-regex`, 10 `@typescript-eslint/no-unused-vars`, 1 `@typescript-eslint/no-unused-expressions`) comes straight from `lint.log`.
- The errors were inherited within the #3733 stack only: every error file matches the Canvas parent. They are not inherited from `main`, where 21 of the files do not exist and 3 differ. Hosted lint will block until the successor lint fix lands.
