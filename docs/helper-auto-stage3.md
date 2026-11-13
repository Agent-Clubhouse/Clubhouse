# Qualified subscription pressure for fresh Auto helpers (#2888)

Auto now supplies qualified aggregate forecasts to the production policy. This runs only for a fresh `cli: auto` helper, under the existing start lock and existing Auto permission/settings checks. Explicit provider/model/effort choices and orchestrators never enter this path. The older per-helper interval proxy remains diagnostic only (`AUTO_USE_BURN_FORECASTS` still disables those legacy inputs).

## Measurement and double counting

A decision saves an immutable local pressure receipt: the latest quota sample timestamp/windows, the exact proposed subscription group, each member's mapped/canonical model, effort, difficulty, per-cell generation, explicit task-profile enum, start epoch and elapsed bucket. Pending atomic starts with confirmed identities count once. A reservation or live run without matching evidence makes the estimate unavailable; helper count is never converted into consumption. The optional `taskProfile` argument is an enum, never inferred from task text. Omitted means unspecified.

The target is **one whole-login subscription delta from that quota sample until the group has ended and a later quota observation arrives**. It includes remaining known work and an unknown parent/outside residual. It does not assign the residual to any helper. Partial burn already in the latest quota is not added again. Quota observations and usage counters are distinct units: no universal token-to-subscription coefficient exists here. The target conservatively includes residual activity after task completion and before the later observation; it is not a claim of attributable helper consumption.

Known extra runs invalidate a group's label; failed/cancelled/partial/unjoined/resumed or interrupted sessions do not become trusted training evidence. Missing final observations remain pending. Crossed resets, decreasing percentages and changed plan identity cannot produce naive positive differences. Overlap is supported by **exact group cohorts**, rather than summing per-helper whole-login estimates. An unseen group falls back.

## Qualification and risk policy (declared before activation)

Policy `aggregate-conformal-v1` uses observed weighted cohort means, seven-day half-life, thirty-day retention and at most 128 samples per qualification. It requires eight earlier observations and twenty chronological held-out residuals. A label's local arrival must precede the decision it trains; observation timestamp alone is insufficient. Residual calibration uses the first half of the held-out sequence; interval coverage is validated on the later half. The empirical finite-sample 90th-percentile absolute residual bounds the mean on [0,10000] basis points. This is an empirically checked prediction interval, not a distribution-free guarantee under drift.

Every decision rechecks all gates: effective sample size >=20, latest evidence <=24 hours old, held-out MAE <=100 bp, absolute bias <=50 bp, chronological validation coverage >=90%, interval width <=1000 bp and latest absolute error <=250 bp. Recency-weighted MAE must be no worse than the unweighted chronological comparator (ties retain the transparent policy). Horizon is bounded to 24 hours, group size to eight; no estimate may project a previously observed horizon across an imminent reset. All failures immediately remove forecast inputs and restore stage 1. Outside bursts can therefore roll back the next decision after they are observed. There is no exploration, training thread, new probe or paid prompt.

For balance, policy compares `latest weekly used + qualified mean remaining pressure`. For admission/reserves, any supported window's `latest used + qualified upper pressure >=95%` excludes that provider. Existing availability, quota, mapping and quality/effort constraints are checked first. Bounds can refuse a start; means cannot override quality or pick an independent model/effort. Unsupported model/other windows or unreadable coverage use stage 1.

## Identity, privacy and storage

Every affected mapping edit, including changing back or changing only effort, advances only that cell's durable generation; unrelated edits preserve its identity. Canonical identity comes from fresh authoritative cached model evidence; aliases without a resolved model and missing identities stay cold. Catalog evidence is not proof of actual execution: session/usage joins must still match.

Codex's existing `account/rateLimits/read` exposes a bounded plan class. Only that enum is retained locally, with a random process-local generation that changes on every observed class transition, including changing back. Unknown/stale/failed plan evidence is unavailable. The generation also changes after restart: audit history survives, but a different login cannot silently reuse its predecessor's estimates. Reset epochs additionally partition capacity. Claude currently supplies no authoritative plan class, so its production forecasts remain unavailable and its routing uses stage 1. Synthetic Claude-named replay cohorts are explicitly simulated support, not a claim that its live protocol supplies this field. An undetectable capacity change within an unchanged provider-reported class cannot be recognized before its first residual; this is a protocol limit, covered by conservative bands and drift rollback rather than an invented identity.

Receipts/outcomes live only in the existing consent-gated device-local decision ledger, using its thirty-day/500-inactive-entry retention and unresolved/live join rules. Each receipt has at most eight members, two windows, bounded identity strings and 128 qualification samples; unknown schema versions are cold. The existing delete/recording/export controls apply. No new telemetry attribute, cloud destination, content, path or account identifier is added. Export remains opt-in; local-only fan-out tests cover the adopted diagnostics.

## Chronological replay result

All numbers below are **simulated**, from `helper-pressure-replay.test.ts` and its deterministic fixture. Each scenario submits 750 tasks, including overlapping runs, partial quota reads, 44 failures and 25 cancellations. Budgets differ by measured subscription percentages, not assumed equal token capacity. Reset and plan changes invalidate cohorts; outside use is an unattributed whole-login burst. The two policies see the same workload/outcomes. There were zero refused tasks and zero simulated depleted subscriptions for either policy in these scenarios. These results are not live quota depletion or real task-quality measurements.

| Scenario | Stage-1 mean utilization spread (bp) | Stage-3 spread (bp) | Qualified starts | Longest provider admission gap, stage 1 → 3 (minutes) |
| --- | ---: | ---: | ---: | ---: |
| Equal budgets | 21.67 | 15.23 | 294 | 10 → 10 |
| Unequal budgets | 21.95 | 14.52 | 243 | 25 → 20 |
| Staggered reset | 129.19 | 127.90 | 134 | 165 → 165 |
| Outside burst | 885.06 | 863.55 | 256 | 25 → 20 |
| Plan upgrade | 21.95 | 19.55 | 63 | 25 → 20 |

Qualified held-out remaining-delta MAE/bias/coverage, by synthetic provider/model/profile (`recorded-model`, high effort, hard, implementation): equal budgets: 88 Claude-labelled / 85 Codex-labelled evaluated groups, 0/0 bp and 100% coverage each; unequal: 19/93 groups, 0/0 bp and 100%; staggered: 0/66 groups, unavailable / 0.0152/0.0152 bp and 100%; outside: 2/114 groups, 0/0 bp and 100% / 0.0088/0.0088 bp and 99.12%; upgrade: 0/43 groups, unavailable / 0/0 bp and 100%. Zero evaluated groups means unknown, never zero error. Excluded intervals and unmatched groups remain visible in the report shape and ledger.

A separate sixty-minute overlapping-run scenario exceeds the supported group coverage and retains stage-1 decisions. Targeted cases cover delayed/equal-time arrivals, missing quota/identity, same-model effort and changed-back mapping generations, reset crossings, partial usage, pending atomic reservations, outside bursts and interval-bound admission. An actual `planHelperStart`/`decideAutoPlan` test supplies qualified local evidence: the provider at 40% plus 8% remaining loses to the provider at 42% plus 1% remaining. This verifies production integration, not merely a standalone policy toggle.

Replay release thresholds are non-regression in accepted tasks, failures/cancellations and simulated depletion; provider admission gaps may increase by no more than one five-minute arrival interval, and mean spread by no more than 100 bp. Observed improvements above do not qualify unrelated live cohorts. Production qualification still requires each actual local cohort to pass its own stricter gates. Ordinary consented work is the only source of live evidence; no synthetic paid probes are authorized.

Reproduce with `npx vitest run src/main/services/helper-pressure-replay.test.ts src/main/services/helper-burn-pressure.test.ts src/main/services/helper-routing.test.ts --maxWorkers=2`.
