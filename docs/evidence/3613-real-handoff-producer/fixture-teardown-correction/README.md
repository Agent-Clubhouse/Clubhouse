# F1/F2 fixture-only successor under full e08 review

**Exact delta review pending. PR #3779 remains7d244; landing held.**

Source `6eaa947d4195510a39a4f8331aa904c7e86b6bfb`, tree
`879b992c16aadfd93cf48be46dbf94a1ce167cfc`, unchanged full src tree
`505ff0699b01779e52338e06a239d7cc15a6d2b1`.
The separate publication ref is
`refs/heads/lane-3613-p2-routes/handoff-producer-teardown-correction`.
Its actual publication commit/tip is reported after normal push/readback,
not inferred here before publication.

Bound to the complete immutable
[e08fa4e8c7753d9467db4829f723cd74eb5e9002 review](https://github.com/Agent-Clubhouse/Clubhouse/blob/e08fa4e8c7753d9467db4829f723cd74eb5e9002/docs/qa-transfer/2026-11-22/reports/producer-hosted-c165-independent-review.md):
107 lines/17131 bytes, blob `74ed6185885aacde7dc24c7dcf7b58f3bd9708f6`,
SHA256 `0666100ec986b33fa6d24d0d7fac3f529c330362bae4dad2149de0585682c31d`.
The full original report is archived, not replaced by preliminary findings.

Against immutable6fa, only `test/annex-v2/handoff-producer-admission.test.ts`
changes: **217 insertions/15 deletions**. The52 existing testcase bodies
from the held-preparation case through EOF are byte-identical:45893 bytes,
SHA256 `a1f8664ae4f3f29a453d2ebea37c3ab44ba77830d3327ba13564c7a4fe4d714a`.
All production, skill fixture, existing assertions/deadlines, phone,
grant/gate/shared-lease/workflow and protected UI bytes remain unchanged.
No product/generic drain, new framework or observer was introduced.

## F1: all-settlement ownership and truthful errors

Each owned batch is drained with `Promise.allSettled`; original promise
identities are deduplicated across batches without repeating execution.
Newly registered batches are also drained. Caller-facing fulfillment and
rejection are forwarded unchanged. Retained caller failures cannot skip
host stop, request reset, mock/timer restoration, config cache cleanup,
fixture retirement or exact temporary storage removal. Individual teardown
errors are also retained while the remaining mandatory steps run.
Only after that work does cleanup throw the original single rejection, or
an Error whose `errors` references retain all original failures.

This remains private fixture caller-work accounting, not cancellation of
arbitrary timed-out test continuations, product standalone-preparation
draining, or a change to real producer-owned continuations/partial saves.

Run146 executes unchanged c165 owned-wrapper/cleanup code with a genuinely
registered, granted callTool handler rejection plus a real preparation held
inside the actual source callback. It fails3 cases/17 AssertionError nodes:
the F1 case shows premature settlement and skipped mandatory cleanup;
the other two are F2 construction/emission faults. The rejecting call's
original Error is still observed by its caller. No dummy rejected counter
or false permission predicate substitutes for actual pending work.

Final single- and nine-rejection controls verify every original caller
Error identity after real held preparation settles and mandatory teardown
finishes. The nine real calls use actual registered grant declarations and
the real evaluator; they are not fabricated operation-array entries.

## F2: bounded optional metadata, including before forwarding

Optional metadata collection is contained before actual call invocation,
at completion/rejection trace updates, and around teardown snapshot/build/
clock/emission. Actual call invocation, result return and rejection throw
remain outside that diagnostic containment. No functional failure is
converted to a successful diagnostic fallback.

Both retained trace and emitted snapshot have an explicit eight-row cap.
Output has exactly three fields (`tool`, `state`, `ageMs`), with tool names
capped at80 characters. Metadata eviction does not evict owned promises.
The nine-call current control plus actual held preparation reaches the
row limit, uses names longer than80, and observes the emitted eight rows,
exact three-field shape and80-character truncation.

Run151 leaves the original c165 pre-forward metadata body byte-identical.
An injected clock throw demonstrates that the actual preparation is
never forwarded, no source callback runs and no catalog is written:
1 genuine failed case/3 AssertionError nodes, not a timeout.
Final matched control observes that same diagnostic fault but the actual
source callback runs exactly once and real preparation/catalog succeed.

Teardown clock and logger faults are forced in an isolated synchronous
Windows diagnostic branch while actual preparation is held. The platform
descriptor and fault spy are restored before asynchronous functional work
resumes. Controls witness the injected fault, barrier release, actual drain,
real host stop/request reset/storage removal and truthful preparation result.
The ordinary bounded-output and current/history-queue controls also pass.
This simulation is not native Windows execution or hosted acceptance.

An additional early-settlement control uses a real seeded offer and actual
standing grant changed to Off. The real call settles before the unreachable
history hold, preserving the explicit fixture error and unchanged history/
catalog. No private permission result or deadline change is used.

## Original source-specific command ledger

All seven original commands have matching clean head/tree/src and sixteen
relevant file hashes before/after. Fourteen tracked entries match their
corresponding Git source; cached config/collector entries remain cached
observations. Full commands, raw START/END/logs/exits and complete XML
names/classes/failure nodes are archived.

| Run | Exact executed source | Original result |
| --- | --- | --- |
| 146 | 81c40696132e2b32382121fcaee107f86b4c8af7 | 3 FAIL /52 SKIP /55 declarations;17 AssertionError nodes |
| 147 | c655bb63cb42f61b7d0cc10e6a28a4e18473132c | 5 PASS /50 SKIP /55; interim teardown-only source |
| 148 | c655bb63cb42f61b7d0cc10e6a28a4e18473132c | compiler exit2;1 unavailable AggregateError diagnostic;3959 inputs |
| 151 | 0007940501bba9b9fd341e6e1e8f5b16388bbb8d | 1 FAIL /57 SKIP /58;3 pre-forward AssertionError nodes |
| 153 | 6eaa947d4195510a39a4f8331aa904c7e86b6bfb | 8 PASS /50 SKIP /58 |
| 154 | same exact6eaa | compiler exit0;0 diagnostics;3959 ordered listFiles inputs |
| 155 | same exact6eaa | lint exit0;1 complete fixture /0 errors /0 warnings |

Run148's original failure is preserved. The correction uses the repository's
existing `Object.assign(new Error(...), metadata)` pattern to retain multiple
causes, without changing compiler libs/target or casting around the error.

Vitest is gated `desktop-test-gate.sh lane-p2 4`, one worker, default+JUnit
reporters.153 selects only the six named control families above: two
rejection variants, two teardown diagnostic faults, pre-forward clock,
early settlement, existing held preparation and existing current history
queue. No full58-case or unchanged broader producer/native/lower suite ran.

Compiler uses gate6:
`npx tsc --project node_modules/.cache/native-handoff-ingress/133-producer-hosted-correction-tsconfig.json --noEmit --listFiles --pretty false`.
The unweakened archived config retains the full production src graph and
three complete producer/coupled-tools/prepare-skill fixtures. Its3959-input
inventory was captured **after execution**:2471 tracked byte hashes verified
to exact6eaa Git and1488 dependency hashes observed. This is not a pre/atomic
or full dynamic-runtime executable seal.

Lint uses gate4:
`npx eslint test/annex-v2/handoff-producer-admission.test.ts --format json --output-file node_modules/.cache/native-handoff-ingress/155-fixture-teardown-lint-original.json`.
The skill fixture is unchanged from reviewed6fa; its prior accepted
source-specific execution/type bridges are reused, not repeated.

The packet contains57 verified gzip archives/four raw XMLs/226 testcase
rows across their own executions. This archive-row total is not a final
runtime test count. Only153's eight selected passes belong to final6eaa;
147's five passes stay atc655. Compiler154 and lint155 belong to final6eaa.
No aggregate final58-case, full-handoff or transferred runtime claim.

## Immutable bridges and remaining boundary

Archived146 original owned-wrapper+cleanup:1584 bytes, SHA256
`e3689e20f4d04ea1920357f5868aa4aa3001efd5fe4340b647e25059b36db609`,
byte-identical to c165/6fa. Archived151 original before-forward metadata:
836 bytes, SHA256
`bd296c16234fe989b353dc79e94aaf95f57b899769d006bd43be177ebcc0dbc6`,
also byte-identical. Full source variants, deltas and unchanged old52 bodies
are archived for exact source attribution, not a lower/native rerun.

c165/6fa, prior454/90fa/b6/2d363 reviews, all original failures, and the
original automatic45068217103 attempt1 FAILURE remain immutable.
The original terminal evidence stays atab853; actual captured PR head7d244/
main50c474 are unchanged. The Windows first5000ms body timeout phase and
closure of its36 producer failures/EBUSY remain **UNKNOWN**.

Existing exact successor review is required before a same-PR update.
No new PR, CI watcher, manual dispatch, blind rerun, grant/timeout/workflow
change, native/live-human/bridge/provider/apply/wake/two-host/duplex
acceptance or landing occurred.
