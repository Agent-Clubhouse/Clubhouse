# Ordinary Validate phases and portable envelope

This cache-only followup uses the original fixed run census, deterministic sample, carried-forward execution deduplication and N/n weights. It makes **no GETs** and collects no release data. Scope is Validate `pull_request` plus `push` to `main`: 1,527 PR runs (47 sampled) and 694 main pushes (42 sampled). API metadata does not establish historical full-ci labels or selector outputs. Thus “ordinary” is an event/branch proxy; no expanded macOS portable-matrix executions appear in this PR/main sample. Other events and branches are excluded.

Epochs use creation before/from 2026-11-16 00:00 UTC. Rates include zero-job runs and all observed distinct attempts. They are estimates of elapsed job/step resources, not billing, cost, savings or causation. ± is an approximate stratified finite-population design standard error, using the same formula as [history methods](history-methods.md). Three samples per stratum provide weak tail coverage; a zero estimate/SE is not proof of population absence. Estimates conditioned on endpoints refer to selected populations.

## macOS phases

Seconds per **all census runs in the indicated event**, including paused and no-Mac runs; phases use cached step start/end intervals, skipped steps excluded. Checkout/node/npm exclude post-action cleanup, which is grouped with runner setup/cleanup. The residual is signed job elapsed minus timed-step sum; it preserves missing timing or overlap rather than inventing phase time. Per-run phase totals reconcile exactly to the original deduplicated job elapsed totals.

| Job / phase | PR seconds/run ± SE | Main push seconds/run ± SE |
|---|---:|---:|
| macos-unit: fixed-suite | 32.2 ± 5.4 | 22.8 ± 2.4 |
| macos-unit: related-tests | 172.0 ± 38.9 | 80.5 ± 31.3 |
| macos-unit: npm-install | 35.0 ± 4.9 | 33.3 ± 2.4 |
| macos-unit: checkout | 3.9 ± 0.4 | 2.9 ± 0.1 |
| macos-unit: node-setup | 6.9 ± 1.3 | 5.9 ± 0.4 |
| macos-unit: artifact-upload | 1.4 ± 0.2 | 0.8 ± 0.1 |
| macos-unit: runner-setup-cleanup | 3.9 ± 0.7 | 2.6 ± 0.2 |
| macos-unit: job-minus-observed-steps | 158.5 ± 138.2 | 1.3 ± 0.1 |
| **macos-unit: total elapsed** | **413.8 ± 138.6** | **150.0 ± 33.0** |
| macos-build-smoke: build-artifact | 24.9 ± 14.7 | 102.0 ± 45.0 |
| macos-build-smoke: smoke-tests | 5.6 ± 3.3 | 28.3 ± 11.2 |
| macos-build-smoke: npm-install | 3.9 ± 2.0 | 14.3 ± 6.8 |
| macos-build-smoke: checkout | 0.3 ± 0.1 | 0.9 ± 0.3 |
| macos-build-smoke: node-setup | 0.6 ± 0.3 | 2.0 ± 0.8 |
| macos-build-smoke: cache | 0.2 ± 0.1 | 0.5 ± 0.2 |
| macos-build-smoke: artifact-upload | 0.4 ± 0.2 | 2.1 ± 0.8 |
| macos-build-smoke: runner-setup-cleanup | 0.5 ± 0.3 | 1.5 ± 0.6 |
| macos-build-smoke: job-minus-observed-steps | 0.2 ± 0.1 | 0.5 ± 0.2 |
| **macos-build-smoke: total elapsed** | **36.4 ± 20.4** | **152.0 ± 64.9** |

The large PR unit residual is important: four cancelled jobs have positive elapsed time but **no cached steps**, at run IDs 41033762745, 41404745038, 41406385511 and 43508233681 (368, 808, 99 and 2,994 seconds respectively). It cannot be attributed to fixed tests, related tests, npm or queue time. The residual also includes small normal job/step timing gaps. Observed related-test time exceeds fixed-suite time, but does not explain the unobserved portion. Phase standard errors are correlated; do not add them to derive total uncertainty.

Before November 16, multiply PR phase rates above by 1,527/1,280 and push rates by 694/581 to obtain pre-epoch rates; the CSV records these directly with SE. From November 16, the sample has no executed ordinary Mac jobs (14 sampled runs per event), so all phase/resource estimates are zero and conditional phase/delay means are unavailable. This does not establish zero population execution.

## Linux/Windows resource envelope

These totals sum all deduplicated observed unit/component, build-app and E2E-family jobs, including cancelled elapsed time and reruns. E2E includes named Annex, Chat, Classic, Stable-mode and general E2E jobs. It excludes planning, lint/typecheck, SDK chunks, package smoke and other families, so it is a prioritization envelope rather than total CI usage. Parallel job seconds add as resources; they are not wall-clock feedback durations.

| OS / family | PR seconds/run ± SE | Main push seconds/run ± SE |
|---|---:|---:|
| linux: unit | 629.0 ± 16.5 | 468.5 ± 12.6 |
| linux: build | 325.6 ± 16.2 | 203.9 ± 22.5 |
| linux: e2e | 1181.7 ± 82.6 | 866.4 ± 78.6 |
| linux: unit-build-e2e | 2136.3 ± 97.6 | 1538.9 ± 96.2 |
| windows: unit | 968.9 ± 36.2 | 713.9 ± 9.3 |
| windows: build | 418.1 ± 22.3 | 262.7 ± 30.1 |
| windows: e2e | 1596.6 ± 111.9 | 1140.5 ± 101.5 |
| windows: unit-build-e2e | 2983.6 ± 147.3 | 2117.1 ± 129.2 |
| **Portable combined envelope** | **5119.9 ± 242.8** | **3655.9 ± 223.8** |

Combined SE is recomputed from whole-run sums, preserving cross-job covariance. Per-event/epoch resource rows, cancelled-only seconds and SE are in `data/history-phases.csv`.

## Feedback and ready-delay proxies

First failure is first failed-job completion from run creation, not first error inside a job. Portable success is the observed substantial successful portable-completion proxy defined in the original methods, with recovered attempts retained. Values below are **conditional mean seconds per run with the endpoint**, not every run.

| Event / epoch | First failed-job completion ± SE | Successful portable completion ± SE |
|---|---:|---:|
| pull_request: before-2026-11-16 | 592.7 ± 73.1 | 751.7 ± 36.2 |
| pull_request: from-2026-11-16 | 537.3 ± 35.1 | 1123.7 ± 166.8 |
| push: before-2026-11-16 | 771.3 ± 133.7 | 801.9 ± 45.6 |
| push: from-2026-11-16 | 1622.3 ± 400.6 | 1460.5 ± 247.9 |

Ready-delay proxy below is the **maximum job-created-to-start lag within a run/OS/family**, averaged conditionally over runs with that observation. It includes API timestamp semantics, dependency/gate waits, provisioning and possible reruns; it is not isolated runner queue time. Post-epoch Mac entries are unobserved.

| OS / family | PR before | PR from Nov 16 | Push before | Push from Nov 16 |
|---|---:|---:|---:|---:|
| macos: macos-unit | 191.6 ± 65.9 | unobserved | 458.7 ± 244.2 | unobserved |
| macos: macos-build-smoke | 169.0 ± 143.7 | unobserved | 311.9 ± 182.7 | unobserved |
| linux: unit | 1.8 ± 0.1 | 2.0 ± 0.0 | 2.0 ± 0.0 | 17.0 ± 14.3 |
| linux: build | 2.0 ± 0.2 | 1.9 ± 0.1 | 3.3 ± 1.3 | 11.7 ± 9.5 |
| linux: e2e | 25.2 ± 12.6 | 2.2 ± 0.2 | 3.3 ± 0.9 | 12.8 ± 9.2 |
| windows: unit | 2.8 ± 0.5 | 2.6 ± 0.3 | 2.0 ± 0.2 | 9.5 ± 7.3 |
| windows: build | 2.0 ± 0.2 | 1.9 ± 0.1 | 2.0 ± 0.0 | 16.8 ± 14.5 |
| windows: e2e | 27.1 ± 13.2 | 2.2 ± 0.2 | 2.6 ± 0.2 | 12.6 ± 9.1 |

The CSV also records first family start after the nearest previously completed successful `Plan the run` observation. This is an eligibility/dependency proxy only: the historical DAG is not reconstructed, and E2E can wait for build dependencies after plan completion. All-attempt timing may include manual rerun gaps. No capacity or causal inference follows from these lags or the epoch difference.

## Regeneration and evidence

Run from repository root, with the preserved original private cache:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 docs/ci-efficiency/history_ordinary_analysis.py \
  --cache /tmp/clubhouse-ci-history-20261123-cache
```

The script reads the original exported run/job/replay CSVs and cached job `steps`; it never calls `gh`, a network API or a hosted job. It uses only original deduplicated job IDs, asserts phase-to-job reconciliation for every sampled ordinary Mac run, and exports only aggregates. Raw runner identities and step commands/logs are not exported. Preserve the private cache for step-level reproduction; the committed aggregate CSV supports checking reported tables but does not replace raw step evidence. Repeated generation is byte-identical. The original sample has 89 PR/main runs; the followup produces 348 aggregate rows. Independent review remains deferred to the parent’s review process.
