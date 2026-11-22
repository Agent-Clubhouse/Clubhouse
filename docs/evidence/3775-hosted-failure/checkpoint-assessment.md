# Bounded read-only checkpoint fixture assessment

**No source/deadline change or execution performed. No production/native root defect established.** This assesses the actual44999624534 undo-envelope timeout, not the earlier unrelated Windows timeout or a full-duplex acceptance condition.

## Evidence and boundaries inspected

One continuous source trace: the failing test and its setup/cleanup; existing `CheckpointFixtureLifetime`; tracker event/revert/undo/idle paths; native checkpoint command/ref/revert paths. Official raw/JUnit already provide the frozen undo6194ms and retired6398ms packets. No new helper, framework, connection, provider/login change or application/test/compiler/lint/CI run was used.

At actual30bf:

- `checkpoint-tracker.test.ts:104-127` constructs the lifetime, captures the directory/options and abort listener, resets fixture state, performs six synchronous real Git setup commands and marks setup complete. This cost lies inside lifecycle elapsed, not a measured isolated body budget.
- Lines196-217 perform `runTurn`, actual revert with exact result/`one\n`/undoable assertions, then actual undo with exact result/`two\n`/no-undoable assertion.
- Lines140-163 await captured raw/direct/event work and both child callback/close receipts before removing only captured paths. The original failure remains frozen even if a late raw continuation changes phase. Observed retirement completes, not a reported leak/cleanup failure.
- Lifetime phase updates record a label/completion flag only; no phase-origin/child identity. The abort packet cannot distinguish `undoRevert` from the post-undo `listTurns`.
- `checkpoints.ts:67-84` runs actual `execFile('git',...)` with unchanged120,000ms native command bound. Revert/undo safety retains before/after snapshots, path protection and rollback; this assessment does not propose cutting that production work or its error behavior.

## Concrete removable fixture cost, not causal proof

`runTurn` at test lines89-94 polls `listTurns` after each start/end event through `settle` lines96-101. Each check invokes tracker `turnRefs` and native `listCheckpointRefs` (`checkpoints.ts:566-591`), including `git for-each-ref`. Each loop permits100 attempts and20ms sleeps; two stages can issue up to200 metadata reads and approximately4s of requested polling sleep, **plus native command latency**. The actual attempt/sleep count in this failed episode is unavailable.

The observed undo phase means those readiness loops had already returned. The primary signature is the outer5000ms timeout, not `settle`'s separate `timed out waiting for checkpoints` error. This proposal removes possible earlier accumulated fixture cost; it does not identify or repair the pending undo-envelope child.

The production event listener installs tracked start/end work before returning. `whenCheckpointsIdle` (`checkpoint-tracker.ts:349-351`) already awaits the actual tracked work to settle; start includes checkpoint/shared marking, end includes checkpoint/pruning. The fixture already wraps this primitive with `ownOperation` at line67. No new synchronization subsystem is needed.

**Smallest conditional proposal:** in `runTurn` only, replace each repeated readiness poll with the existing owned `whenCheckpointsIdle()` followed by one explicit `listTurns` readiness assertion. Keep the edit between completed start/end, and retain every substantive revert/undo/result/exact-byte/undoable assertion. Keep default5000ms, native120,000ms, ownership/raw wrappers, captured setup/cleanup, phase inventory, real Git and all production code unchanged.

Illustrative waiting sequence, **not applied**:

```text
emit turn_started
await existing owned whenCheckpointsIdle
assert one listTurns read contains that turn
perform the original edit
emit turn_ended
await existing owned whenCheckpointsIdle
assert one listTurns read contains that turn's end
```

This removes avoidable readiness-read churn and retains an explicit failed assertion if readiness is absent; no silent default or success-shaped substitute. It changes fixture polling tolerance, not production retry policy. Waiting for complete end/prune work may wait longer than seeing only an end ref, so **no speed/deadline guarantee or historical causal claim follows from the source alone**.

Do not instead delete post-undo state assertions, mock native Git, move unowned preparation past a timeout boundary, shorten retirement, skip production backup/safety snapshots, or raise/disable a deadline. Those are not supported corrections to the observed episode.

## Ownership provenance and finite review question

Published lineage: #3402 (`v1-checkpoint-ci-fix/3401-deadline`, merged `0f6d7f2174613c3c96740996fa52450af57b7c0e`) deliberately split the original cumulative real-Git scenario while retaining5000ms, actual Git and assertions. #3405 (`v1-ci-3404-owner/3404-fixtures`, merged `9cbaca6c92c91783fc9883176b0606a9832fa48c`) retained native custom-promisify/callback/close lifetime accounting. Both are published by `masra91`; this establishes provenance, **not a live agent's current ownership/reservation or new connection authority**. No original-owner workspace or held WIP was changed.

Existing independent review can answer the bounded source question now: **is the existing producer-idle plus single-read readiness substitution appropriate without weakening this fixture's semantic/lifetime assertions?** If approved/authorized, future proof should be only the affected real-Git fixture/necessary scoped typing+lint and an authorized ordinary changed-head Windows observation at unchanged deadlines, preserving this original failure. Local macOS success would not itself be Windows deadline proof.

No exact slow child, per-phase cost or native production defect is currently proven. If the substitution is not supportable, retain that precise unresolved cause; do not default to repeated healthy samples or a lengthy diagnostic framework without a new, concrete answerable question.
