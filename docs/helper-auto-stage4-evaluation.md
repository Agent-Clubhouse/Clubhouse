# Device-local adaptive burn evaluation (#2889)

**Decision: do not ship or activate an adaptive predictor.** Retain measured stage 1 indefinitely and use stage 3 only when its exact local cohort qualifies. This evaluation ships a repeatable offline comparison, closed bounded evidence projection, failure fallback checks and canonical model-notice deduplication. It adds no runtime inference/training, cloud calls, prompt collection, probes, model migration or exploration.

## Candidates, provenance and chronological protocol

`helper-adaptive-evaluation.ts` compares three implementations in the same provider-window basis-point units:

| Candidate | Fit and uncertainty | Provenance and supported scope |
| --- | --- | --- |
| Transparent online cohort/quantile policy | Exact provider/model/effort/mapping/plan/reset/difficulty/profile and elapsed bucket; seven-day weighted mean and empirical quantiles | Earlier observed rows of that exact cohort only; minimum eight rows; no cross-subscription conversion |
| Versioned initial predictor with local calibration | `synthetic-initial-v1`: initial linear predictor fitted to the oldest eight synthetic observations of the exact cohort, then a local residual offset and 90% residual band | An evaluated candidate prior, **not a production shipped prior**. Training inputs are the checked-in synthetic fixture; elapsed milliseconds are converted to minutes as a numerical feature, and the response is remaining subscription-window basis points. It supports only those exact synthetic provider/plan/model versions, is explicitly nonportable and cold outside its training range. No real provider prior is claimed or shipped. |
| Compact device-local learned predictor | Two-parameter least-squares predictor of remaining basis points from elapsed progress; minimum 32 local cohort rows; earlier 2/3 fit, later 1/3 residual calibration; bounded output | Exact local cohort only. No neural runtime, cloud inference, tokens-to-quota coefficient, content features or learned quality/permission choices. Usage counters are explanatory data and are not used as a universal conversion. |

The input is a content-free local observation shape: schema version, random decision id, provider, mapped model/effort/generations, difficulty/profile enums, elapsed progress, optional bounded usage counter, window reset epoch, observed remaining subscription delta, final window usage, outcome, source and local arrival timestamp. No text, paths, account identifiers or secrets are fields.

Each scenario has 400 synthetic rows, sorted by decision time: first 240 train, final 160 test. **No held-out target enters a fit or uncertainty calibration.** A training label must have arrived strictly before the decision; delayed or equal-time labels cannot leak backwards. Plan/reset/mapping/model/effort/profile changes partition cohorts. All features exist at prediction time; total eventual duration/outcome is not a model input. Unknown/partial/foreign-version observations are dropped, never fabricated as zero.

This tests the hypotheses; it does not supply a real-login training corpus. `ADAPTIVE_MODEL_ENABLED` is false. There are zero ordinary-consented held-out samples and no demonstrated live quota-depletion or task-quality improvement, so none of these results authorizes activation.

## Numeric release and rollback policy

Before any future activation, require at least 100 ordinary-consented held-out observations for supported cohorts, >=10% MAE improvement over the transparent policy, >=90% interval coverage, no lower prediction availability per provider/model/profile, p95 prediction latency <=10 ms and a <=8 MiB feature/model resource budget. Require independent replay showing no worse actual depletion, failure/quality rates or provider starvation, with simulated results clearly separated from ordinary work. A versioned prior additionally needs a real disclosed training corpus, feature units, exact supported provider/plan/model versions and conservative cold-start uncertainty. This evaluation does not satisfy those requirements.

Any stale/missing/out-of-distribution identity, provider/plan drift, insufficient cohort, nonfinite/out-of-bounds prediction, inference failure or latency >10 ms immediately returns the non-ML policy. The executable `adaptiveFallback` accepts only a finite ordered [0,10000] stage-3 band with fresh, in-distribution, timely evidence; otherwise it returns stage 1. No adaptive inference is called by the production spawn path, so failed training cannot block a spawn. The existing stage-1 policy remains available indefinitely. Future activation requires a separate reviewed policy version; there is no hidden adaptive setting to enable.

## Held-out result (all simulated)

Values are remaining-window delta MAE in basis points, signed bias in basis points, and prediction-interval coverage. Stage 1 has **no burn forecast**, so its error/coverage are unavailable, rather than an invented zero. The transparent candidate represents the stage-3 model family, not a claim that these synthetic cohorts qualify a real user's stage-3 routing.

| Scenario | Transparent cohort: MAE / bias / coverage | Initial prior + local calibration | Local learned predictor |
| --- | --- | --- | --- |
| Stationary elapsed cohorts | 0 / 0 / 100% (160/160 evaluated) | 21.72 / 0.18 / 100% (160/160) | 21.20 / 0 / 100% (160/160) |
| Deliberately linear progress | 36.56 / 1.22 / 94.44% (144/160) | 0 / 0 / 100% (64/160; other elapsed values are out of support) | 0 / 0 / 100% (160/160) |
| Outside-use burst in test | 500 / 500 / 50% | 510.95 / 500.18 / 50% | 510.60 / 500 / 50% |
| Reset epoch changes | unavailable (0/160) | unavailable (0/160) | unavailable (0/160) |
| Plan upgrade | unavailable (0/160) | unavailable (0/160) | unavailable (0/160) |
| Sparse model cohorts | unavailable (0/160) | unavailable (0/160) | unavailable (0/160) |

Every scenario's fixed held-out outcome stream contains 146 completions, nine failures, five cancellations and one **simulated** depleted interval. These are factual labels shared by all candidates, not a claim that a different router would have prevented the depletion. No adaptive routing is shipped, so production task outcomes, quota depletion and provider admission fairness remain governed by stages 1/3. Counterfactual ML quota-depletion/quality benefit is unproven, which is a reason to reject activation. Per-exact-cohort metrics and unavailable counts are returned in `byCohort`; no pooling across providers/models/profiles hides unsupported cells.

The learned model wins the deliberately linear synthetic case but loses to the simpler cohort on stationary task profiles. All three fail the outside-drift calibration target. More model complexity is therefore unsupported by the evidence available here, even though a tiny learned model is technically feasible.

On this development host, a direct offline run measured p95 per-prediction wall time of 0.13 ms (cohort), 0.22 ms (initial prior) and 0.36 ms (learned) on the stationary fixture. These are local smoke measurements under shared machine load, not production latency guarantees. The complete stationary comparison consumed about 100.3 ms user CPU plus 3.0 ms system CPU (87.7 ms wall time, including all candidate predictions and report construction). Retained feature data was approximately 0.32 MiB UTF-16 JSON across the fixtures; this is the measured serialized feature footprint, not a claim about total process heap. The loops are bounded to 512 retained rows; the runtime/model state is a few scalars and bounded arrays. The offline evaluation is never scheduled in the main spawn path.

## Local storage, deletion, export and migration

No new persistent adaptive database is created because the model is rejected. The existing local decision ledger remains the source for ordinary consented work, using its recording consent, thirty-day/500-inactive-entry retention, active/unresolved joins and deletion controls. The offline projection separately retains at most 512 rows and 1 MiB, scans at most 2048 supplied rows, rejects observations older than thirty days and strips all unknown fields. Its schema is version 1; unknown versions are cold and require an explicit future migration, not reinterpretation as trained evidence. Reset/delete means clearing the supplied projection; no learned weights survive it. Exporting an evidence projection or evaluation report must be an explicit local user action; the application adds no automatic export or cloud destination.

## Catalog notices and mapping boundaries

Main already implements successful live authoritative handshake snapshots, a silent first baseline, combined deduplicated notices inviting Settings > Smart selection, durable seen/dismissed state, missing-mapped-model notices and failed/fallback/empty/older-read rejection. This change closes the alias gap: an alias renamed to a model id already known by authoritative resolved identity is not a new discovery. Seen canonical identities survive restart and temporary disappearance. A genuinely new concrete model id still produces one notice; neither notification nor dismissal changes any mapping/model/effort/session. The existing checked mapping-update path remains the only update path and resets affected calibration generations in stage 3. No-update leaves mappings untouched.

Coverage includes duplicate reads, rename/concrete aliases, stale/fallback/interrupted catalogs, temporary disappearance/reappearance, durable dismissal dedupe, and existing explicit mapping update/reset paths. There is no automatic migration on catalog discovery.

Reproduce with `npx vitest run src/main/services/helper-adaptive-evaluation.test.ts src/main/services/helper-model-catalog.test.ts src/main/services/helper-auto-policy.test.ts --maxWorkers=2`. The fixture and report schema are checked in so later ordinary-consented evaluation can repeat the same split and thresholds without changing the production default.
