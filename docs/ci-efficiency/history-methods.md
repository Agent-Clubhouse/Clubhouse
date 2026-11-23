# Actions history: 2026-10-25 through 2026-11-23

This is an empirical run-created cohort, not a billing report or a causal comparison. The inclusive UTC window is **2026-10-25 00:00:00 through 2026-11-23 23:29:00** (30 calendar dates, 29 days 23 hours 29 minutes). Job state is observed when fetched after that cutoff. It is not a reconstruction of status at cutoff, and executions may finish outside the creation window. Deleted or inaccessible runs cannot be counted.

## Reproduction and API scope

Run `python3 docs/ci-efficiency/history_analysis.py` with authenticated `gh` access to `Agent-Clubhouse/Clubhouse`. Only GETs are made; no logs, workflow dispatches, workflow edits or hosted jobs are used. The script uses at most four concurrent job-read requests and caps uncached GETs at 600 per invocation. It fails on API errors, exhausted budget or missing offline data. Network retries are not automatic. Before collecting, core rate allowance was observed as 5,000 remaining; the cached rate-limit response is also retained. Multiple cached invocations do not reset the server's actual limit.

Private cache defaults to `/tmp/clubhouse-ci-history-20261123-cache`. Endpoint strings map to SHA256-named JSON files; `manifest.json` maps endpoints to paths. These raw responses stay outside git. Exported CSVs omit actor identities, logs, commit messages, SHA values and runner host identities. They contain run/job IDs, branch names, job labels and timestamps for auditability.

Once cached, regenerate using:

```sh
python3 docs/ci-efficiency/history_analysis.py --offline
```

All exported CSVs should be byte-identical on repeated offline runs. `history-summary.json` includes invocation-level GET counts, so a network invocation and an offline invocation can differ in that field. Public API state may change on a fresh fetch; preserve the cache to reproduce this snapshot. No raw cache is committed, so a fresh independent fetch verifies methods rather than reproducing the exact observation snapshot. Persisted CSV rows support independent recomputation of totals.

## Census and sample

Run metadata is paginated at 100 rows per page separately for each UTC date. The script rejects slices reaching GitHub's 1,000-result limit and verifies each page series against `total_count`; a larger cohort requires smaller slices. `history-slices.csv` records date coverage. Run IDs deduplicate across responses. The census retains cancelled and incomplete runs and the latest observed `run_attempt` count, not just successful completed runs.

Jobs are a deterministic stratified sample of runs. Strata are workflow display name, event, seven-day index from the window start, and latest conclusion (or status when no conclusion). Sort each stratum by SHA256 of `ci-history-v1:<run-id>` and take at most three runs. The strata table records population N, sample n and weight N/n. Every selected run contributes all pages of every attempt up to its census-observed attempt count. This oversamples small workflows and rare outcomes intentionally. Unweighted sampled shares are not population shares.

For each selected run, the total of its unique observed job durations is weighted by N/n. Summing produces stratified estimates for the full run-created cohort. Whole-run sampling preserves jobs within a run together; `estimated_jobs` can be fractional. Estimates by workflow/event/branch/day/job name/OS use the same weights. Every dimension table includes estimated seconds divided by all census runs; workflow/event/branch/day tables additionally divide by the corresponding group's census run count. OS and job-name rows use the whole census denominator because the census alone cannot reveal which runs would execute that job or OS.

Three runs per stratum give limited precision for long-tailed runtimes and job incidence. No confidence interval is claimed. Many tiny strata are exact censuses; large Validate strata are estimates. Branch-level estimates can be particularly sparse: unsampled branches have no sampled-job row. Use census branch counts to see the full branch population.

## Attempts, skipped jobs and platform evidence

The attempt-specific jobs endpoint can repeat carried-forward successful jobs under different IDs. Deduplicate **within each run** on job name, start, end, private runner identity, status and conclusion. Distinct starts or ends remain separate executions. The exported `reported_attempt` is the earliest sampled attempt listing the execution, not a guarantee of its execution-attempt identity. `history-carried-forward.csv` lists removed duplicate observations.

`history-dedup-proof.csv` is a concrete regression check for run 44159641801: seven carried-forward rows in attempt 2 are excluded, including the unchanged x64 macOS build. The new arm64 build and Publish execution remain. Assertions fail if this fixture changes. Jobs lacking timestamps cannot establish distinct zero-time execution identity reliably; their counts are observations, not proof of runner use.

OS is classified from runner labels only: macOS, Windows, Ubuntu/Linux, otherwise unknown. Job names do not establish OS. All skipped jobs get a separate `skipped` category and zero execution seconds, even if the API supplies synthetic timestamps. This prevents skipped macOS-named jobs from being counted as Mac executions. Jobs without complete timing stay in counts and expose missing-duration counts, rather than contributing invented time. Active jobs therefore make duration totals incomplete at observation time.

## Timing, failures and interpretation limits

Job execution seconds are completed-at minus started-at, clipped at zero. They are elapsed runner execution observations, not GitHub's rounded billable minutes, hardware-adjusted usage, pricing or cost. Labels do not establish paid versus included capacity. Concurrent jobs sum separately.

`created_to_start_s` is a scheduling-lag proxy: it can include dependency waits, approval gates, concurrency handling, provisioning and timestamps with different semantics. It does not isolate runner queue time or prove capacity saturation. Weighted p50/p90 and observed maxima are provided by OS. The repository's configured concurrency does not establish actual plan capacity, and a single-repository sample cannot observe shared-organization demand.

`history-sampled-runs.csv` records observed job span, longest completed job, and run-created-to-first-job-start. The job span across all observed attempts includes gaps and manual rerun delays. It is not a DAG critical path. Latest run `updated_at` minus `created_at` in the census is lifecycle span, not execution duration. Without the historical workflow DAG, cross-run dependencies, runner capacity and gate state, no exact critical path or queue attribution is claimed.

Census outcome counts are latest observed run outcomes. `rerun_runs` and summed observed attempts measure rerun signal, not a failure cause; recovered prior failures are not visible from latest run conclusion alone. Sample job failure/cancellation counts and their estimates retain execution-level outcomes across observed attempts. Cancelled jobs can have nonzero execution time. External causes, wasted work and savings cannot be inferred from cancellation alone.

Independent review is requested through the parent agent. Self-checks and the concrete rerun fixture support this dataset; independent acceptance remains deferred until that review is supplied.

## Validate selector replay and uncertainty

`python3 docs/ci-efficiency/history_validate_analysis.py` reads the exported census/jobs CSVs without network access. It writes `history-validate-replay.csv` (one row per sampled Validate run with public head SHA), `history-validate-families.csv` (one row per run/reported-attempt/OS/family), and `history-validate-estimates.csv`. The replay SHA supports historical `git diff`; the dataset does not resolve PR merge bases or assert that a changed-path selector would have produced the same result.

The secondary table separates pull requests and pushes, with epochs before and from **2026-11-16 00:00 UTC**, assigned by run creation. This boundary is descriptive, not a verified exact deployment instant. It does not control for workload, changes, CI configuration, reruns, shared capacity or selection effects. Calendar-day estimates are especially sparse.

For totals, design variance is `sum_h N_h² (1 - n_h/N_h) s_h² / n_h`, treating the deterministic SHA selection as a stratified simple random sample. Census strata contribute zero sampling variance. Domain estimates for event/epoch include zeros for sampled runs outside that domain. Execution means divide estimated domain totals by exact domain census counts. Conditional timing means divide estimated elapsed-time totals by estimated counts of runs with that observed endpoint; their standard errors use linearized residuals. These are approximate design standard errors, not prediction intervals or guarantees of coverage with three observations per stratum. A zero estimate and zero estimated SE can reflect no sampled positive observations; they do not prove zero population usage. Bias from missing/deleted data or timestamp semantics is outside the SE.

A first actionable failure proxy is the earliest **failed job completion**, minus run creation, across observed attempts. It includes scheduling/dependency time and is later than an error that was already visible inside a running job; step-level first failure is not measured. Successful portable completion requires observed positive-duration unit/component jobs on both Linux and Windows, and all latest visible non-skipped Linux/Windows jobs successful. Unresolved unknown-OS portable-family cancellations prevent classification as complete. Earlier failed attempts superseded by a later execution with the same exact job name do not prevent recovery. This measures completion of observed portable work, not proof that every intended historical matrix job existed or ran. It can be available even when a macOS job failed. Timing columns across all attempts include manual rerun gaps.

OS first-start/last-complete and longest-job fields support an observed critical-branch or runner-release proxy only. Completion is a timestamp, not proof that a runner slot was immediately reusable. Job family groups are based on names and remain available with the full names for audit. `reported_attempt` retains the carried-forward caveat above. Cancelled execution seconds sum elapsed time of cancelled jobs only; they do not label that work unnecessary or claim it could have been saved.

## Verification evidence

`PYTHONDONTWRITEBYTECODE=1 python3 docs/ci-efficiency/history_verify.py` regenerates both analyses offline and verifies byte-identical exported files; census ID uniqueness and date bounds; strata population/sample counts; skipped-job zero durations; independent weighted Mac totals; event-specific Validate Mac totals; and the seven-row carried-forward regression fixture. This snapshot passes those checks. The verifier intentionally pins census counts to this snapshot; a new date window requires deliberate updates. A later core-rate check observed 4,722 remaining of 5,000; this is shared credential state, not an attribution of all intervening requests to this task. The export uses 227 distinct cached endpoints. No general repository tests or hosted jobs are needed for these documentation/data-only additions.
