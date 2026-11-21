# #3749 current-base update: `a2bb8647275d818666dc37bcacb21850726ea452`

Branch `details-local-composition/3733-main-535241-evidence`: `a2bb86472` plus this docs-only commit. QA approved the bounded `a2bb86472` update (`6e5de8ee8`). These are sanitized copies of surviving original output. Nothing here is reconstructed.

## Commits

- `52bbebb2122a56a85fce1722c851318741bcbc59`: merges `main` `53524110b` (#3752) into `748dca9f9`. The textual merge is clean. #3752's annex-client hunks touch only the control-route lifecycle.
- `a2bb8647275d818666dc37bcacb21850726ea452`:
  - `read-only-helper-work.ts` final fence uses `fs.realpathSync.native`, matching the native `fs.promises.realpath` root.
  - The card-display test root also uses the native realpath.
- Correction: an earlier message gave this head as `06d8b61dd`, which was written before readback and does not exist. Superseded.

## Why (run 44878841675 on `748dca9f9`)

The run had 32 passing checks. Windows unit 2/2 failed 5 tests: 4 in `read-only-helper-work` returning "Couldn't read helper work.", and 1 in `dispatcher-agent-card-display` with 0 bytes counted. See `ci-748dca9f9-windows-unit-2of2.failures.txt` and `junit-748dca9f9-windows-2of2-excerpt.txt`. Earlier failures on `748dca9f9` and `ead945230` stay recorded in `../3733-ci-3749-run44868309476/`.

Cause: **likely**, from source. The JUnit shows the runner's `os.tmpdir()` as the 8.3 form `C:\Users\RUNNER~1\AppData\Local\Temp`, but only via an unrelated marketplace test name. No log shows what the native and JS realpaths returned inside the failing helper-work cases. The source shows the fence comparing JS `realpathSync(cwd)` with a root from native `fs.promises.realpath`, and the native realpath expands 8.3 names. **Windows proof requires the hosted run on the new head.**

## Local results (surviving logs)

| File | Head | Command | Result |
| --- | --- | --- | --- |
| `validated-head-52bb.txt`, `pre-status-52bb.txt` | `52bbebb21` | `git rev-parse HEAD`, `git status --short` | Clean before |
| `tsc.txt` | `52bbebb21` | `tsc --noEmit -p .` | Exit 0 |
| `lint-scope.txt`, `lint.txt` | `52bbebb21` | `git diff --name-only 53524110b HEAD -- '*.ts' '*.tsx' \| xargs eslint` | Exit 0 |
| `focused.txt` | `52bbebb21` | `vitest run --no-cache --maxWorkers=3` with a fresh default-depth `TMPDIR` over 13 files (listed in the log) | 13 files, 1866 passed, exit 0. Status printed at the end is clean (post). |
| `win-followup-local.txt` | Working tree = `52bbebb21` plus the uncommitted change later committed as `a2bb86472` | `vitest` with a fresh `TMPDIR` over `read-only-helper-work`, `dispatcher-agent-card-display` and their importers | 4 files, 274 passed, exit 0 |

**Gaps**, stated rather than reconstructed:
- For `a2bb86472`, typecheck (exit 0) and ESLint on the two changed files (0 errors) were printed to the terminal only, and are not logged.
- The 274 run has no head file or pre/post status, because it ran before the commit.
- No full suite was run on `52bbebb21` or `a2bb86472`.

## Successor discriminator, not in this head

`ab1baddd9421f19662995957ba2594bfc2503d97`, on branch `details-local-composition/3733-helper-fence-discriminator`, adds a test that models the same folder in two realpath forms (must read) and an actually different native root (must refuse).

- `discriminator-ab1baddd9-with-fix.txt`: 17 passed.
- `discriminator-ab1baddd9-without-fix.txt`: the fence reverted to JS `realpathSync` fails only the new test (1 failed, 16 passed). The restore is byte-identical and its hash equals the committed blob. Post-restore status shows only the then-uncommitted test file.

This needs its own review before it joins any PR head.
