# Observed Actions history findings

The fixed 30-date run-created census contains **2,343 runs**. Validate accounts for 2,254: 1,294 latest successes, 317 failures, 631 cancellations and 12 skipped runs; 177 runs have multiple attempts (2,485 attempts total). The deterministic jobs sample covers 181 runs and 3,278 unique job executions/observations after 37 carried-forward duplicates are removed. See [methods](history-methods.md) for observation timing, sampling and limitations.

The weighted macOS estimate for this cohort is **263.69 elapsed job-hours**, of which Validate contributes 254.98h. Mac unit jobs contribute 205.55h and Mac build/E2E smoke jobs 49.37h. Release accounts for 8.72h in this general sample; the separate focused release census is the appropriate source for detailed release conclusions. These are sampled elapsed execution estimates, not billed minutes or costs.

| Validate event | Census runs | Sampled runs | Mac seconds per census run ± design SE | Cancelled Mac seconds per census run ± design SE | First failed-job completion seconds ± SE* | Successful portable completion seconds ± SE* |
|---|---:|---:|---:|---:|---:|---:|
| pull_request | 1,527 | 47 | 450.3 ± 140.4 | 185.2 ± 131.6 | 577.8 ± 54.8 | 793.9 ± 38.7 |
| push | 694 | 42 | 302.1 ± 92.7 | 0.0 ± 0.0 | 924.6 ± 139.2 | 931.7 ± 61.2 |

*Timing means are conditional on the observed endpoint, measured from run creation. PR failure and portable-success endpoint counts are 22 and 16 sampled runs; push counts are 15 and 16. They are distinct selected populations, not a paired speed comparison. Standard errors do not capture configuration changes, unobserved rare outcomes or missing API data.

Before November 16, estimated Mac seconds per PR/push run are 537.2 ± 167.5 / 360.8 ± 110.8. From November 16 the sample observes zero Mac execution in both events (14 sampled PR runs, 14 sampled push runs). A zero sample estimate is not a complete execution census or proof of absence. Epoch splits and all OS cancelled resources are in `data/history-validate-estimates.csv`.

The 38 unknown-OS job observations are cancelled unresolved-matrix placeholders with zero observed execution seconds; they provide no positive evidence of runner execution or platform.

Across the full cohort, weighted Mac execution p50/p90 are 336/861 seconds. Created-to-start p50/p90 are 3/754 seconds (observed maximum 4,284 seconds); this proxy includes gates and dependency waits and cannot isolate runner queue time. The dataset cannot establish shared plan capacity, exact DAG critical paths, causation or savings.

For selector replay, join `data/history-validate-replay.csv` to `data/history-validate-families.csv` by run ID. The former provides public head SHA, event, attempts, weights and timeline endpoints. The latter provides attempt/OS/family durations and conclusions. Full exported job rows retain exact names and timestamps. Reproduce both scripts offline from the persisted CSVs/cache as described in methods.
