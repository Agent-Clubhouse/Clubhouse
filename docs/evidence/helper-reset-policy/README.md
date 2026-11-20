# Reset-policy isolated replay evidence

Task `t_mwojop1n`; design branch `auto-reset-policy-design/standby`, source base `ae56577af786b0db79f21d137d0b334a5f7847dc`. See [proposal](../../helper-auto-reset-proposal.md) for assumptions, limits, user choices and deferred implementation review. No production code/configuration changes or live provider activity.

All values below are **synthetic percentages of the simulated plan A**, never measured provider savings. Same requests, outcomes and simulated capacity across policies. A starts at 40% and resets at 24h; B starts at 40% and resets at 144h. Each task consumes 2.5 simulated units over one hour; serial arrivals, hourly ticks, current rounded quota readings. High demand asks hourly, low demand every six hours. No arrivals after the first reset. Absent demand asks for zero tasks; no work is generated.

| Policy | High: requested / accepted / refused | A unused at reset, high | Low: requested / accepted / refused | A unused, low | Absent: requested / accepted / refused; A unused |
| --- | --- | ---: | --- | ---: | --- |
| Existing weekly_used | 24 / 24 / 0 | 30% | 4 / 4 / 0 | 55% | 0 / 0 / 0; 60% |
| Existing reset_schedule | 24 / 24 / 0 | 20% | 4 / 4 / 0 | 50% | 0 / 0 / 0; 60% |
| Reserve-aware cycle, old tiers | 24 / 24 / 0 | 20% | 4 / 4 / 0 | 50% | 0 / 0 / 0; 60% |
| Raw pace deficit, keep 10% | 24 / 24 / 0 | 10% | 4 / 4 / 0 | 50% | 0 / 0 / 0; 60% |
| Bounded 24/48h urgency, keep 10% | 24 / 24 / 0 | 10% | 4 / 4 / 0 | 50% | 0 / 0 / 0; 60% |
| Bounded urgency, explicit keep 5% inside 24h | 24 / 24 / 0 | 5% | 4 / 4 / 0 | 50% | 0 / 0 / 0; 60% |

All table cases have zero simulated depletion. Non-relaxed research comparators have an assumed prior whole-login rate of 25 bp/h; the relaxed comparator uses calendar-only unknown-rate urgency. No forecast was fitted from live activity or attributed to helpers. The table does not evaluate task quality, dollars, equal real subscription capacity or live reset behavior.

Final pre-commit validation: **47 tests / 3 files passed**, 221ms, gated at 2026-11-20T05:46:53Z, plus scoped lint and TypeScript compilation. Source-content SHA-256 values in `results.json` identify both research artifacts and unchanged runtime/comparator files. These are targeted checks, not a full application build, broad test run or independent review.

The cold-forecast concurrency case is intentionally adverse: at an observed 89%, four simultaneous 1%-of-plan starts all pass a 90% admission stop and finish at 93%. This is evidence **against** promising a physical remaining balance. The aggregate-bound case rejects at `8800 + 200 >= 9000 bp`; a supplied upper bound of 199 bp permits admission, and unknown coverage is not labeled a zero-burn prediction. The existing aggregate-pressure suite separately exercises cohort formation, qualification, inflight/pending identities and once-only accounting; the new isolated fixture does not reimplement that machinery.

Evidence files:

- `results.json`: exact machine-readable table extracted from the replay output, with source hashes for linkage.
- `replay.txt`: final focused run, including gate receipt, individual test names and table report.
- `initial-run-tool-transcript.txt`: first 36-test run, copied faithfully from the tool transcript; that first invocation did not redirect output.
- `second-replay.txt`: original captured 37-test run before final validation hardening/report fields; retained rather than overwritten.
- `lint.txt`, `typecheck.txt`: scoped validation of the three fixture/test TypeScript files, including transitive dependencies for the compiler.
- `typecheck-initial-failure.txt`: original compiler failure for an implicit `any[]` on the empty-window negative fixture; fixed with an explicit window-array type. No production defect was involved.
- `admission-refusals.txt`: retained gate refusals. No bypass, slot reservation or retry sooner than 60 seconds.

Commands use the existing root dependency tree without installation. Actual gate parser takes `owner minGB -- command...`; no `--cmd` shell shortcut was used. Tests/lint request 4 GiB, compiler 6 GiB. Every Vitest command uses `--maxWorkers=2`; the single-slot gate owns admission and host measurement. The initial Vite warning concerns the existing config's planned native-loader behavior and did not fail tests.

```sh
/Users/masonallen/.clubhouse/orch/desktop-test-gate.sh auto-reset-policy-design 4 -- node /Users/masonallen/source/Clubhouse/node_modules/vitest/vitest.mjs run --project main src/main/services/helper-reset-replay.test.ts src/main/services/helper-auto-replay.test.ts src/main/services/helper-burn-pressure.test.ts --maxWorkers=2 --disableConsoleIntercept --reporter=verbose
/Users/masonallen/.clubhouse/orch/desktop-test-gate.sh auto-reset-policy-design 4 -- node /Users/masonallen/source/Clubhouse/node_modules/eslint/bin/eslint.js src/main/services/__fixtures__/helper-auto-replay.ts src/main/services/__fixtures__/helper-reset-replay.ts src/main/services/helper-reset-replay.test.ts
/Users/masonallen/.clubhouse/orch/desktop-test-gate.sh auto-reset-policy-design 6 -- node /Users/masonallen/source/Clubhouse/node_modules/typescript/bin/tsc --noEmit --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck --noImplicitAny src/main/services/__fixtures__/helper-auto-replay.ts src/main/services/__fixtures__/helper-reset-replay.ts src/main/services/helper-reset-replay.test.ts
```

Independent product/policy/settings-concurrency/privacy review remains **deferred**, with no production acceptance implied by passing isolated tests. Exact committed-head verification and its external receipt are reported in the task handoff; any subsequent change to source needs a new check.
