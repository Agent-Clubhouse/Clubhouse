# #3720 piece1: captured launch admission

Candidate source: `annex-wake-readiness/3720-launch-admission` at **`4e9c3db4cbc98d2ac8513d42cbe87a96dedebf4b`**, based on main `be0091d1676764b0e3300898ab0ad1f135f88a46`. This evidence-only branch retains identical source/tests. Contract freeze `38cbdaa9fff26aa28630ad14b5db9c13359d39f1` and QA `a3bd96ac4f3218b1bcb764fdb0e1b298e6185fa9` are preserved; no frozen ref was rewritten.

The only production change is 10 additive lines in launch-gate.ts: an opaque generation rotates on every close, and a captured predicate requires open-at-capture, the same generation and current-open. Reopen cannot revive an old capture. It is an observation, not cancellation, draining, a settings grant or runtime authority. Existing launches/work gates, waiters, shutdown ordering and policy stay unchanged. **No Annex consumer or runtime-readiness integration is implemented in this piece.**

## Observed proof

All commands, HEADs, source hashes/diffs, actual exits and full outputs are in `evidence/`. The code head above was tested unchanged; mutated runs record their actual dirty source separately.

| Check | Observed result |
| --- | --- |
| Test-only head `c2746d5744449612123d49c5e63925cd0515cf57` | 11 failures/9 passes: new API absent. This is not an executed existing Annex bug reproduction. |
| Candidate and byte-restored candidate | 20/20 pass in two files. |
| No close rotation mutant | 6 assertion failures/14 passes, including late success/failure effects after real coordinator cancellation. |
| Reset generation on reopen mutant | 6 assertion failures/14 passes. |
| Missing open-at-capture latch mutant | 1 assertion failure/19 passes. |
| Full TypeScript `--noEmit` | Exit0 on candidate head. |
| ESLint production/test files changed | Exit0, max-warnings0 on candidate head. |

The coordinator is real `runAppShutdown`; agent drivers/flushing side effects are mocked. Tests exercise close-before-quit-begin, failed guarded update/cancel/reopen, held success/failure callbacks and fresh requests. Effect callbacks in the tests are stubs, not actual Annex starts/stops. Actual Annex consumption/readiness and its teardown matrix remain acceptance work for later pieces. Repeated-close tests assert observable capture invalidation; unconditional rotation on an already-closed gate is also directly visible in source, not independently observable as a second allocation through the public predicate.

Admission was remeasured:16 CPUs, load2.66 before tests and2.15 before sequential type/lint, with ample free memory. Cached lock SHA256 `bd9cc80304b81d317f2ffb295d9af5abbc484bf8efb64fc8d7f118e1288c212d` matches and all1176 non-optional installed package versions match. No install or shared dependency-cache write. Vitest uses one worker, no file parallelism, runner config loading, task-local `.cache/3720-launch` and disabled Node compile cache. Original output paths are preserved; commands/config generation are checkout-relative.

To reproduce with the already-matched dependencies, run `python3 docs/implementation-notes/3720-launch-admission/prepare-local-config.py`, then use the exact argv in the receipts. `run-proof.py` preserves actual outputs; `run-mutants.py` mutates only the task source file and restores its exact bytes in finally. The captured config text matches the hash in receipts. No live CLI/agent/app restart, install, grant/link/power change, release or Mini probe occurred.

## Remaining implementation controls

N1: a failed recovery completion will expose the already-created next ready ticket in its typed result/status; never auto-submit it. N2: a confirmed emergency replacement after a strict UNKNOWN-base reread becomes the known actual base/receipt for later emergency composition; public currentness stays degraded, and any new uncertainty returns to strict reread. N3: submit must always resolve a typed result, including transport/validation failures, with no unhandled rejection. N4: a safe-envelope local version other than1 must have a schema_invalid fixture; missing required envelope keys remain invalid_envelope. These choices are recorded for later pieces, not implemented by this utility.

Independent exact-source QA is required before PR. Hosted current-head CI is still pending. The separately reviewed runtime-readiness seam is required before any server/settings/client integration; void applyNetworkSettings is not success evidence. Full #3720 acceptance, old/new naming compatibility and release are not claimed here.
