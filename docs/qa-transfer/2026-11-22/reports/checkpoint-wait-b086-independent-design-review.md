# #3775 checkpoint fixture wait: bounded DESIGN APPROVE

**APPROVE the unimplemented `runTurn`-only substitution as suitable for bounded implementation:** emit start → await the existing **owned** `whenCheckpointsIdle()` → one explicit start-ref readiness assertion → original edit → emit end → await owned idle → one explicit same-turn end-ref assertion. No unsupported producer/ownership assumption prevents this sequence on exact30bf. This is not source acceptance, a demonstrated timeout fix, a check waiver or CI/landing authorization.

Reviewed [frozen b086 evidence and assessment](https://github.com/Agent-Clubhouse/Clubhouse/blob/b086335005cf8f9801170691d2ed870cc116b8f5/docs/evidence/3775-hosted-failure/checkpoint-assessment.md), manifest SHA256 `990630ad7b9b1f39f2eecc22d9eaebad3415492b86047eff88d27571cac7542e`. All18 artifact blobs were downloaded/rehashed. Five exact source objects were read at PR head30bf and verified byte-identical to63f. No source/test/compiler/lint/application/CI execution, new framework, account/login action or original-owner workspace change was performed by this reviewer.

## Why the wait is valid here

`checkpoint-tracker.ts:145–180` handles these calls synchronously. Start installs `turn.start` and `openTurns`, calls `track(...)` before returning, and that tracked promise waits for the start checkpoint and shared-neighbour marking. End captures/removes the open turn, then synchronously tracks a promise awaiting the start dependency, root/shared marking, end checkpoint and pruning. The test calls the actual handler directly via its existing wrapper, not a deferred bus. Therefore an immediate awaited idle call cannot miss already-emitted start/end work merely because it has not been registered yet.

`track`343–345 adds the promise synchronously. `whenCheckpointsIdle`349–351 repeatedly snapshots and awaits the in-flight set until it is empty, including tracked work admitted during those waits. It is a barrier for tracked background checkpoint promises, not for arbitrary future event emissions or whole-host quiescence. The fixture is serial and owns its event sequence; do not replace the direct event call with a later callback, timer or bus dispatch in this patch.

**Settlement is not success.** Idle uses `Promise.allSettled` and does not propagate individual work failures as a success/failure signal. Start/end checkpoint failures may already be caught/logged; `listCheckpointRefs` can turn a Git-read failure into an empty list. Thus each one-read readiness assertion is mandatory. Assert the requested `turnId` exists after start and that the same turn has an end after end; do not replace these with idle alone, a nonempty unrelated turn list, a logged error or a success-shaped fallback. A failed/readiness-absent result must fail the fixture; do not catch and continue into edit/revert. This does not newly prove shared-mark/prune success when production deliberately logs a failure, nor is that stronger error contract implied by the old polling test.

The new barrier is **stronger in completion ordering**, not automatically faster: a start waits for shared marking, and an end waits for full pruning, where the previous poll could see its ref before those tasks finished. Idle can also wait for other already-tracked work. It might wait longer or encounter the unchanged outer timeout. No historical polling count, saved milliseconds or guaranteed deadline improvement is established.

## Semantic and lifetime boundaries

Only `checkpoint-tracker.test.ts:89–95` (`runTurn`) is eligible. Keep both readiness predicates at the same start/edit/end boundaries. Keep exactly one owned `listTurns(agentId)` result per stage for the assertion. Preserve all actual revert/undo results, exact `one\n`/`two\n` bytes, undoable-state checks, subdirectory/shared/quietness assertions and real Git calls. The fixture's other `settle` callers remain: they test early-ref/mid-turn/shared/revert-running conditions. Do not remove or globally replace the helper or alter those independent race tests.

The end-before-start test253–265 already directly emits both events then uses the owned idle wrapper and validates end/shared state. Retain it unchanged; do not serialize away the race it tests. The proposed helper change does not suppress its direct overlap coverage.

Use the existing wrapped constant at test66 (`ownOperation(actualWhenIdle)`), not a new unowned call in the body. It captures the original fixture and returns the actual promise unchanged. Its settlement remains inventoried as direct work, while `ownedRegistration` retains the raw async body across Vitest timeout abandonment.

Producer idle does **not** certify native child close. Native callbacks may settle a checkpoint promise before its separately observed close receipt; the lifetime deliberately tracks raw/direct/event work plus callback **and** close. Keep setup104–127, captured directories/options, abort/failure freezing, `owner.close(actualWhenIdle,...)`140–165, late-admission/version checks, and `assertRetired` before the next setup. The close controller is intentionally unwrapped so it cannot await its own direct receipt. No early directory removal, alias/cache mutation, shortened retirement, substituted callback, native mock, setup relocation or cancellation is justified. Keep5000ms case and120,000ms native command deadlines unchanged.

## Actual blocker attribution and limits

Archived official JUnit has exactly one failed case in the Windows1 job: the real checkpoint revert/undo case, `Test timed out in 5000ms.`, reported testcase duration6.3991128s; checkpoint fixture10 pass/1 fail/0 skip. I independently parsed the retained original ZIP and matched both lifecycle packets to the original Windows raw log:

- abort: `phase=undo`, elapsed6194ms, raw/direct/child/callback/close pending each1, not closing/retired;
- later teardown: elapsed6398ms, all those counts0, retired=true, outcome retired.

The canonical saved commit object's SHA1 reconstructs `2d958bcc3071560a7d78b90c66342ce7d806ec64`; both archived Windows logs identify it. Its reviewed merge tree isbf2f. This establishes bounded artifact/checkout attribution, not a new PGP trust verification or a fresh reproduction. The 30 healthy Gitdiff cases and existing4f6 source/typing approval are separate; I did not reopen that review.

The lifecycle clock starts before six synchronous Git setup commands.6194ms is **not** undo duration, exclusive body time or proof that setup consumed the case's body timeout. The undo label spans `undoRevert`, result/byte assertions and the post-undo `listTurns`. Pending child/callback/close receipts cannot identify a command/PID or distinguish OS execution from delayed JS delivery. The204ms snapshot delta is not isolated cleanup or undo latency. Retirement supports inventoried settlement, not completed abandoned assertions or all-host quiescence.

Current `runTurn` can issue two readiness reads or up to200, with up to4 seconds of requested polling sleeps plus native command latency; actual counts in this episode are unknown. The phase already being undo means those loops returned. Removing possible earlier read churn is a source-supported fixture synchronization change, **not causal evidence about the outstanding undo-envelope work**. Unchanged source across63f/30bf is not a baseline run, a flake classification or proof of absent indirect resource effects.

## Exact implementation/proof gate

Freeze the minimal helper-only diff for review. It must preserve original predicates, sequence, all other tests and lifetime/native wrappers. A focused missing-readiness discriminator should fail before proceeding when an event/ref is absent; use a small disposable fixture overlay if needed, without mocking Git or adding a persistent framework. This distinguishes a true assertion from treating allSettled idle as successful checkpoint creation.

Run only the affected real-Git checkpoint fixture and appropriate changed-test-covering types/scoped lint through the normal gate (tests/lint min4, compiler min6, maxWorkers2 total); retain exact heads/input hashes/original output and any baseline failures. Do not use an unchanged root configuration that excludes tests as a claim that the changed test was typechecked. Preserve this hosted failure and unchanged deadlines. No repeated Gitdiff matrix, broad E2E or speculative production correction is requested.

After independent exact implementation/proof review, the owner may seek the already-scoped ordinary changed-head Windows observation under parent authority. A healthy local macOS result is not Windows deadline proof; a later green Windows sample does not retrospectively establish cause or a universal fix. The existing failed required check remains a landing hold until properly disposed through the normal process; no blind same-head rerun/manual dispatch or waiver follows from this design approval.

Prior4f6/residual actual full-fixture139FAIL/root-fd58 bridge remain unchanged. Details, private Q5, current-app/P8, phone, release and whole-duplex acceptance are outside this review. Private Q5 stays clean at079a/tree89e; immutable evidence and original owner work remain preserved.
