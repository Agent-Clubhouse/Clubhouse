# AR1 / AR2 research successor

Task `t_mwojop1n`, branch `auto-reset-policy-design/reset-aware-reserves`, predecessor `2bafbbbd13ac832aa6b323cd813cd8412f32ac79`. Original commit, standby ref, results and receipts remain preserved. Independent review of the predecessor requested changes; this successor is submitted for review, not independently accepted. No production implementation, defaults, UI, live provider starts, installation, PR, push or merge.

## AR1: urgent peers compared through the old tier barrier

`baseline.txt` is the actual gated failing discriminator against the original selector, before changing it: both verified peers reset in 24 hours, assumed rate zero, retained reserve 10%, forecasts explicitly enabled. Supplied forecast inputs are A used8200/mean100/upper100 and B used2000/mean6800/upper6900 bp, with matching admission evidence. Both pass the90% ceiling (8300 and8900). Comparable scores are A8300 < B8800, but the original tier-first comparator chose B. The new expectation A failed: 1 failed / 16 intentionally unselected. This baseline had the newly added discriminator in an uncommitted worktree; it is **not** retroactively sealed as a clean committed-head run.

The correction is confined to the research fixture. After eligibility, reserve/window checks, verified urgency promotion and equal band/reset selection, only already-admitted low peers are projected to the same comparison tier as headroom peers. The existing selector still checks comparable mean coverage and uses pressure, tie band, load and deterministic rotation. `near_limit` and other states are not rewritten. Original quota-tier labels are restored in the receipt; the low label does not silently regain ordering precedence within the promoted peer set. No input mean/bound is fabricated or newly qualified. Legacy/cycle and nonurgent paths retain their tier ordering.

Controls cover complete versus partial/absent means, forecast-disabled input, nonurgent and legacy paths, tied-pressure load/rotation, unverified/unknown/near-limit states, upper-bound reserve refusal and short-window refusal. The existing aggregate-pressure suite continues to own qualification/cohort/accounting behavior. `corrected.txt` records the first correction run: 51 tests / 3 focused files passed, before later explanatory comments and the extra near-limit control. The final committed-head sealed runs bind the submitted source and results; no claim of exact-head proof is made for this pre-commit log.

## Matched reserve comparisons

`results.json` adds four bounded-policy rows per demand: normal/relaxed with the same **fixed assumed25bp/hour**, and separately normal/relaxed with **unknown rate**. Original six rows are retained alongside the two new matched controls; the successor has24 rows across three demand levels.

| Demand | Rate input to both policies | Requested / accepted / refused, both | A unused, keep10% → explicit keep5% inside24h |
| --- | --- | --- | --- |
| High | Fixed assumed25bp/hour | 24 / 24 / 0 | 10% →5% |
| High | Unknown | 24 / 24 / 0 | 10% →5% |
| Low | Fixed assumed25bp/hour | 4 / 4 / 0 | 50% →50% |
| Low | Unknown | 4 / 4 / 0 | 50% →50% |
| Absent | Fixed assumed25bp/hour | 0 / 0 / 0 | 60% →60% |
| Absent | Unknown | 0 / 0 / 0 | 60% →60% |

All are synthetic, using the same original abstract plans, reset offsets, one-hour tasks/ticks and zero-lag rounded quota readings. Fixed rates stay constant as routing changes; they are **assumptions**, not output of `observedRate`, not closed-loop observations and not a validated future forecast. Separate `observedRate` tests check past-only extraction, reset/identity transitions and unavailable evidence. Table percentages are not measured provider savings, cost or interchangeable token capacity. The89→93% cold-forecast overshoot remains tested and explicitly limits reserve guarantees.

Near-reset starts whose work/forecast horizon crosses reset epochs remain **deferred integration coverage**. The hourly table ends every task at or before its first reset and requests no later starts. It proves neither cross-epoch admission nor accounting/completion; no zeroed new-window quota may be invented from a passed deadline.

## AR2: original ES2022 scoped pass did not prove root ES2020 compatibility

The original `../typecheck.txt` explicitly used `--target ES2022` and remains unchanged. Review initially reported a source-derived concern, not a reviewer-executed compiler failure. The owner then ran the root project configuration, preserving `target: ES2020` and overriding only `typeRoots` to the existing dependency tree because this worktree has no local installation. `ar2-project-baseline.txt` is the actual gated result, exit2: TS2550 at `helper-reset-replay.ts:19` for `rows.at(-1)`, plus unrelated unresolved SDK/ProseMirror/Azure-path and associated diagnostics. This was an uncommitted AR1 draft before the AR2 indexing change, not a sealed run of the exact original commit.

Replace the one new fixture call with `rows[rows.length - 1]`. Shared target, lib, dependencies and root `tsconfig.json` remain unchanged. Full-project validation is environment-blocked and is **not green**. No installs, shared dependency modifications or suppression of those unrelated diagnostics are performed, and no duplicate full-project run is claimed.

`tsconfig.scoped.json` faithfully extends the root config: same ES2020 target and default libraries, module/resolution, strictness flags, path/base settings, JSX and skipLibCheck. It overrides only `noEmit` and the location of existing `@types`. Explicit `files` select the two replay fixtures plus the changed research test (intentionally included even though ordinary root test globs exclude tests); `include: []` avoids the unrelated application dependency graph. Transitive imports still receive the inherited compiler options. It proves this selected research graph under project ES2020 settings, not a full application typecheck. `project-scoped-typecheck.txt` records the first actual successful gated run. `lint.txt` records scoped ESLint. Any final submitted-source run is separately sealed below.

## Exact successor validation contract

`sealed-validation.py` runs **inside** `desktop-test-gate.sh`, before launching the selected test/compiler/lint command. It refuses an unclean/uncommitted worktree or report/source hash mismatch, prints and stores exact HEAD/tree/status/source hashes before and after the command, records exact argv/exit status and raw combined output plus SHA-256, and fails if source/head/tree/cleanliness changes. It writes only to an external evidence directory. Each receipt binds `results.json` and its expected source hashes as well as the command. These are before/after seals, not continuous file monitoring or independent review. Gate START/END output is retained outside the inner raw-output file as well.

The original adjacent receipt is retained as the owner's launch assertion. It is **not retro-sealed**. Pre-commit baseline/correction/typecheck logs here are explicitly unsealed development evidence. Final receipts name the exact clean successor commit and are delivered to QA under `/Users/masonallen/.clubhouse/orch/evidence/auto-reset-policy-design/<successor>/`; their content must show matching before/after head, tree and source hashes, `sealValid: true`, `exitCode: 0`, and the expected test/report results.

Admit final runs one at a time, with min4GiB for tests/lint, min6GiB for compiler, maxWorkers2 and >=60s retries for gate75. No reservation or bypass. Use the checked-in wrapper as the admitted command, e.g.:

```sh
/Users/masonallen/.clubhouse/orch/desktop-test-gate.sh auto-reset-policy-design 4 -- python3 docs/evidence/helper-reset-policy/ar1/sealed-validation.py --output-stem /absolute/external/successor/tests -- node /Users/masonallen/source/Clubhouse/node_modules/vitest/vitest.mjs run --project main src/main/services/helper-reset-replay.test.ts src/main/services/helper-auto-replay.test.ts src/main/services/helper-burn-pressure.test.ts --maxWorkers=2 --disableConsoleIntercept --reporter=verbose
/Users/masonallen/.clubhouse/orch/desktop-test-gate.sh auto-reset-policy-design 6 -- python3 docs/evidence/helper-reset-policy/ar1/sealed-validation.py --output-stem /absolute/external/successor/types -- node /Users/masonallen/source/Clubhouse/node_modules/typescript/bin/tsc --project docs/evidence/helper-reset-policy/ar1/tsconfig.scoped.json
```

Product settings/range/unknown-capacity choices, concurrency/settings/epoch integration and independent privacy/policy review remain deferred. These corrections authorize no production behavior or rollout.
