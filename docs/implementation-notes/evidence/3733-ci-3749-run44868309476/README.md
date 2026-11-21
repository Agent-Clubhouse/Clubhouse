# #3749 hosted CI failures (run 44868309476, head `ead945230`) and fixes

Branch `details-local-composition/3733-ci-agent-system`, based on `ead945230` (the frozen #3749 head). These are sanitized copies of output: ANSI codes are stripped, and path prefixes and the author email host are replaced.

## Hosted failures

The run had 30 passing checks, including all E2E jobs, and 3 failing unit shards. The `*.failures.txt` files are excerpts from each job log's "Failed Tests" section to the end. Each header records the full sanitized log's size and SHA-256. Full raw logs:

- ubuntu unit 2/2: https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44868309476/job/136736957641
- windows unit 1/2: https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44868309476/job/136736957624
- windows unit 2/2: https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44868309476/job/136736957566

## agent-system cascade (ubuntu and windows), fixed in `d1a2171c6`

- `agent-system-fresh-tmpdir-ead945230.txt`: the frozen head with a fresh, empty `TMPDIR`. 219 failed and 96 passed, the same as CI. With this Mac's existing `$TMPDIR/clubhouse-test-userData`, the file passes 315, which is why local runs were green.
- `agent-system-bisect*.txt`: `git bisect run`, using a fresh `TMPDIR` each step, from `ae56577af` (good) to `b458b4c89` (bad). First bad commit: `dab72fdbf`.
- Also observed but printed to the terminal only, not logged: with a fresh `TMPDIR`, excluding only the 6 new quick-display tests gave 309 passed and those 6 alone passed; main `69ef383ce` with a fresh `TMPDIR` gave 309 passed.
- `agent-system-fresh-tmpdir-fix.txt`: the fix head with a fresh `TMPDIR`: 315 passed, exit 0.

## Full suite with a fresh TMPDIR on `d1a2171c6`

- `full-suite-fresh-tmpdir-d1a2171c6.txt`: 35525 passed and 2 failed, both in `handoff-git-receive.test.ts`, with `RangeError: Invalid count value` from path-length padding. The fresh dir was under `/tmp`, which is shorter than the default macOS temp path. The same 2 cases fail on main `69ef383ce` with the same kind of `/tmp` dir. With a fresh dir at default depth, `handoff-git-receive` plus `agent-system` passed 333 on this head (terminal output only). This is an artefact of my temp-dir choice, not a defect.
- `full-suite-*-status.txt`, `full-suite-validated-head.txt`, `full-suite-load-before.txt`: a clean tree before and after.

## Windows-only fixtures, fixed in `b9be7e779` (not runnable locally)

The causes are read from the windows job logs: `git init` fails with `unable to access '\\.\nul'` (`os.devNull` used as a Git config file), the Claude project folder name is hardcoded for POSIX, an exact-string path comparison in a spy, and an executable-bit case that cannot exist on Windows. Locally, all 7 affected files pass 703 on macOS. Windows proof requires a hosted run.
