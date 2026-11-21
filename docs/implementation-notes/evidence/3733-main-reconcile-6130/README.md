# Main reconciliation for #3749: `ed13e3060`

`ed13e30604dedc24733af0a42daceea2b058316c` merges `main` `6130b2966` (#3748 wake readiness, #3750 upload lease) into the QA-approved CI-fix head `81cd9b4ef`. These are sanitized copies of output.

## Conflicts (both unions)

- `agent-config.ts`: the stack's `readAgentConnectionCacheForDisplay` and #3750's `readDurableRegistrationLease`. Against `81cd9b4ef` the merged file adds 110 lines and removes none (main's lease). Against main it adds 71 and removes none (the stack's getter).
- `annex-client.test.ts`: the stack's local snapshot receipt tests and #3748's resume freshness tests. Against main the diff also shows two replaced lines. Those are the stack's existing edits already in `81cd9b4ef` (a per-method Settings epoch `it.each`, and the role transport block inserted before it). Against `81cd9b4ef` one line differs: #3748 widens the `sockets` mock type.
- See `union-diff-vs-81cd9b4ef.txt` and `union-diff-vs-main-6130b2966.txt`.
- Auto-merged `annex-client.ts` keeps #3748's 5 `connectionAttempt` references, the clock-stop retry and the receipt-bound `invalidateSnapshotAdmission(sat, receipt)` at both 401/403 sites.

## Composition control (committed in `ed13e3060`)

`annex-client.test.ts`, "power-resume revalidation withdraws the receipt and fences an in-flight %s read until the new socket attests", for full, Canvas-page and role reads. After `resumeAllConnections`:

1. the receipt is withdrawn, and the public broadcast carries none
2. a late snapshot from the pre-sleep socket cannot re-attest
3. the in-flight read returns `offline`
4. only the new socket's snapshot mints a receipt, on a higher connection generation

- `mut-resume-effective.txt` is the **effective discriminator**. With `resumeAllConnections` revalidating only already-disconnected satellites (the pre-#3748 behaviour), all 3 cases fail: the stale receipt survives resume. The restore is byte-identical (hash equals the committed blob) and post-restore status is clean. This proves that #3748's retirement of connected satellites is what withdraws Details admission on wake.
- `mut-resume-ineffective-setstate.txt` is ineffective and earns **no discriminator credit**. Removing only the `setState` receipt clear still passes, because the disconnect path withdraws the receipt as well. That redundancy is expected.

## Checks on `ed13e3060`

- `full.txt`: `vitest run --no-cache --maxWorkers=4` with a fresh, empty `TMPDIR` at default macOS depth (`fresh-tmpdir*.txt`). 1464 files passed, 13 skipped. 35591 tests passed, 114 skipped, 0 failed. Exit 0.
- `lint.txt` (over `git diff --name-only 6130b2966 HEAD`): exit 0. `tsc.txt`: exit 0.
- `pre-status.txt` and `post-status.txt` are both clean.

## Limits

Windows fixtures are proven only by a hosted run. The earlier short-`/tmp` handoff failures stay recorded in `../3733-ci-3749-run44868309476/` with their main comparison. Results that were printed to the terminal only (703 on macOS, 309 controls, 333 at default depth) are not credited.

## Correction

The first version of this README (commit `29a75c916`) gave a wrong full SHA for the merge. The SHA was typed by hand. The correct value, from `git rev-parse`, is now above.
