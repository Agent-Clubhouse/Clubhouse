# Independent QA: #3733 parity follow-ups

Reviewer: qa-details-local-composition. November 20, 2026.
Review target: `782e08cde8aefdbe30ad25f83654b29044cf73b3` on `origin/details-local-composition/3733-f1-parity`. It adds only evidence on top of the source `11fc59dbe6bb0ac35930e35b2329e2ed7eab8c85`.
Commits: `c2297c45b` (c229), `c55535821` (c555) and `11fc59dbe` (notes). I read source and artifacts only and ran nothing.

## Verdict

**APPROVE** the c229 and c555 changes and the checklist corrections as source.

**The tree is NOT green.** The full suite shows 28 failures, all inherited from the Mini base and passing on main. They must be fixed before any PR. Hosted CI and the live matrix have not been run.

## c229 (test only): no live facts while waking

- The view already sets `session` only when `details.running` is true (:117), and `clockActive` needs `details.running` and `status === 'running'` (:174).
- The new test checks that a waking host with a retained chat shows no effort row and no Running clock. Its positive control checks that the same chat shows both once the host reports running.
- The owner states that dropping the guard fails the test. There is no committed log for that claim, so it is unverified.

## c555: older-host fallback for real-chat Other machines

- The gate becomes `result.status === 'ok' || result.status === 'unavailable'`. All other conditions are unchanged: Dispatcher, connected, not needing pairing, snapshot available, positive receipt, not paused.
- **Authorization order:**
  - `handleAgentSettingsDetailsRoute` runs `requireMtls`, then `desktopDetailsAuthorized`, and returns 403 before any 404.
  - `readRemoteAgentDetails` checks `authorized()` before `agent_not_found` 404.
  - So on a current host, `unavailable` comes only after authorization. On an older host, the 404 is the router's.
- **Page-only 400 excluded:** the main client maps `page && res.status === 400` to `unavailable`, but the central read sends no page query. The other ways the renderer can produce `unavailable` (`!address`) imply `dispatcher === false`, so the gate is closed.
- **409 asymmetry:** the central read maps 409 to `error`, while the no-chat role read maps it to `unavailable`. On a current host both are post-authorization (inventory or role changed). The notes record the asymmetry. It is benign.
- Tests:
  - With an `unavailable` read, peers are shown under a positive receipt and withheld when the receipt is revoked.
  - A new epoch with no receipt stays withheld.
  - `forbidden`, `error`, `offline` and `rate_limited` withhold even with a positive receipt.
- "Reverting fails only the older-host test" is the owner's claim; no log is committed.

## Full-suite evidence (`evidence/3733-full-suite-11fc/`)

- All 11 committed copies match SHA256SUMS. The raw entries are host-local.
- `validated-head.txt` = `11fc59dbe`. `pre-status.txt` and `post-status.txt` are empty, meaning the tree was clean before and after the run.
- `lint.txt`: eslint exit 0 with 0 errors. `tsc.txt`: tsc exit 0.
- `full.txt`: 1476 files, 35641 tests: **28 failed**, 35499 passed, 114 skipped, exit 1. The failing files are:
  - `headless-integration`: 21
  - `headless-fallback`: 4
  - `annex-ephemeral-session`: 1
  - `annex-telemetry`: 1
  - `SettingsCard`: 1
- Classification over those 5 files:
  - main `69ef383ce`: 78 passed;
  - `b458b4c89`, `26ca06220`, `cb1c98c34` and `11fc59dbe`: 28 failed, 50 passed each;
  - **the failing test names are identical** at all four commits and match `full.txt`.
- So the failures entered with the Mini base and pass on main. Neither the composition nor these successors introduced them. They also existed at `a4edf7adf`, outside its focused set. They block green and any PR.

## Checklist

- Effort (#2): parity met. Local `SettingsCard:287` also shows only live-reported effort.
- Dispatcher card (#6): delivered.
- Subagents (#7): folded into #12.
- Canvases (#13): assessed.
- Waking (#16): delivered.

These corrections are source-referenced and reasonable. I spot-checked #2 and #16.

Remaining: #12 history, #13 navigation after board backfill (needs a freshness decision), #14 role paging, #17 live matrix, #18 hosted CI, plus the 28 inherited failures.
