# #3775: bounded runTurn producer-idle substitution

**Implementation/proof frozen for independent review, not acceptance or a timeout fix.** Source `adcb284b217030163574b2b094df2b482cdc8684`, tree `1f23b1350640314a18b3e9aee66de5711f3b49fc`, is based on held PR head `30bf4c2d11ad8027b1e408a423794bccbc52c9d5`. Only `checkpoint-tracker.test.ts` changes: **4 insertions / 2 deletions**, entirely within `runTurn`. There is no production or lifetime-helper change.

The [complete independent design approval](https://github.com/Agent-Clubhouse/Clubhouse/blob/5de7ec2cdbb561c8094df698da3a8f95a1c54801/docs/qa-transfer/2026-11-22/reports/checkpoint-wait-b086-independent-design-review.md), blob `87e7a79ebe1154658c9f2226a6fb61ff9a834dad`, permits direct start event, existing **owned** producer idle, one original requested-turn start predicate assertion, original edit, direct end event, owned idle, one original same-turn end predicate assertion.

## Exact semantic boundary

Both old predicates are unchanged; each stage uses exactly one owned `listTurns(agentId)` read. Other `settle` callers, direct end-before-start overlap test, setup, byte/revert/undo/undoable assertions, captured directories, abort evidence, raw/direct/event/native ownership, late-admission checks and retirement remain byte-identical outside the helper hunk. Case5000ms and native120000ms bounds are unchanged.

The handler registers tracked work synchronously before returning. Producer idle includes start/shared work and end/shared/pruning, but its `allSettled` is **not successful checkpoint creation**. The explicit requested-turn assertions remain mandatory. Idle is also **not native callback-and-close quiescence**; the existing unwrapped close controller still drains inventoried raw/direct/event/child/callback/close work before deleting captured directories and permitting the next fixture.

The stronger completion order can wait longer for shared marking/pruning. No observed polling count, saved milliseconds, causal fix, whole-host quiescence, Windows deadline guarantee or production correction is claimed.

## Original local execution

All six commands were admitted by `~/.clubhouse/orch/desktop-test-gate.sh lane-p2`; no refusal/retry, package install, full suite, E2E, Gitdiff rerun or CI dispatch occurred. Runtime was **darwin / Node v24.22.1 / Vitest4.1.12**.

| Attempt | Minimum | Exact scoped command after `--` | Actual outcome |
|---|---:|---|---|
| 01 | 4 | `npx vitest run --project main src/main/services/agent-runtime/checkpoint-tracker.test.ts -t "runTurn producer-idle readiness discriminator" --maxWorkers=1 --reporter=default --reporter=junit --outputFile.junit=node_modules/.cache/3775-checkpoint-idle/01-discriminator-original.xml` | **2PASS / 0FAIL / 11SKIP**, disposable real-Git overlay |
| 02 | 4 | Same selector/options, `02-readiness-mutant-original.xml` output | **0PASS / 2FAIL / 11SKIP**, expected assertion-removal mutant |
| 03 | 4 | Same file/project/options without `-t`, `03-fixture-original.xml` output | **11PASS / 0FAIL / 0SKIP** on exact source |
| 04 | 6 | `npx tsc --noEmit --pretty false --project node_modules/.cache/3775-checkpoint-idle/fixture-types.json --listFiles` | **FAIL1**, actual test-inclusive candidate graph |
| 05 | 4 | `npx eslint src/main/services/agent-runtime/checkpoint-tracker.test.ts --format json` | **0errors / 0warnings PASS** on exact source |
| 06 | 6 | Same compiler command/config/flags, exact baseline fixture bytes | **FAIL1**, complete diagnostic/input comparison below |

Original logs, XML, exits, source/config/graph receipts and disposable overlays are retained in `artifacts/`; `lossless-originals.json` binds the32 first packages and reconstructs compressed originals byte-identically. Raw logs and large compiler graph JSON use deterministic gzip. No failure output was overwritten. The final source is byte-identical to attempts03/04/05 after removing all overlays.

### Missing-readiness discriminator, not mocked Git

The disposable two-case overlay uses actual `checkpointRef`, actual native Git and real `.lock` files to deny writing only the requested start or end ref. An unrelated completed turn remains visible, so a generic nonempty/ended-turn check cannot substitute for the requested turn. Existing native observation wrappers still delegate to actual Git; only edit/continuation callbacks are spies.

After producer settlement, missing start rejects at the helper predicate **before edit or continuation**, with `one\n` preserved. Missing end has performed exactly the original edit but rejects **before continuation**, with `two\n` and the requested start preserved, requested end absent and unrelated completed end still present. The locks remain inside captured fixture directories until unchanged retirement.

Attempt02 removes only the two helper readiness assertions while retaining owned idle and one list read per stage. Both same discriminator cases fail specifically with `promise resolved "undefined" instead of rejecting`, not an outer timeout. Their existing teardown packets report retired with all inventoried pending counts zero. This proves those assertions are substantive; it is not a runtime comparison against the old polling implementation.

The overlay/import and mutant were removed before the single full affected fixture execution, compiler and lint. No new persistent runtime test framework or native mock was added. The exact disposable source/diffs and observed failures are preserved for review.

## Actual compiler failure and bounded baseline comparison

**The actual changed-test-covering compiler is NOT PASS.** Candidate and exact baseline each report:

```text
test/checkpoint-fixture-lifetime.ts(175,33): error TS7024: Function implicitly has return type 'any' because it does not have a return type annotation and is referenced directly or indirectly in one of its return expressions.
```

`fixture-types.json` extends unchanged root compiler options/include/exclude and explicitly lists the changed fixture in `files`. Explicit files are not suppressed by the inherited test-exclusion patterns. Both actual compiler `--listFiles` outputs include `checkpoint-tracker.test.ts`; no unchanged root-excludes-test PASS is used as a substitute.

Each graph contains **3958 ordered compiler inputs**. Complete file paths and content hashes match except the expected fixture source: candidate SHA256 `913d21b98b995c3867ec30a937e8819685e264f4c3989682dfc98b7ba59b1796`, baseline `949e96e414a05fe0001e7a1e79f9507541668f9ed2976bbcb4eec7e0d9045d44`. Baseline tracked source matches30bf; compiler command, flags, root/config bytes and all other3957 inputs are identical.

The full diagnostic message, TS code, file, line175, column33 and multiplicity match exactly, not merely the count. That helper is byte-identical and needs no line-shift mapping. There are **zero observed changed-test/new-graph diagnostics**, but the residual full actual graph remains **FAIL1**. No annotation repair, cast, compiler relaxation, clean reduced graph or success-shaped fallback was introduced. The existing reviewer must disposition this scoped nonregression explicitly; all-PASS typing acceptance is deferred.

Attempt04's failure stopped its command chain before lint. Attempt05 is the separately executed scoped lint, not credit for an unexecuted chained command. Attempt06 is compiler-only baseline evidence, not baseline runtime, Windows speed or timeout causation evidence.

## Held source, evidence and next gate

Fresh guards preserve actual main/base `63f140b2a0ba00e686fb727a931d6b340fc3ee7e`, PR #3775 OPEN/non-draft at30bf/UNSTABLE. Original automatic run44999624534 remains **FAILED**, independently archived at [b086](https://github.com/Agent-Clubhouse/Clubhouse/blob/b086335005cf8f9801170691d2ed870cc116b8f5/docs/evidence/3775-hosted-failure/README.md). Its native undo-envelope5000ms timeout, lifecycle6194 pending receipts and6398 retirement do not establish the specific child/await or exclusive phase duration. Cause remains unresolved.

The30 hosted Gitdiff passes and4f6 source approval, earlier full3-fixture139FAIL disposition/root-fd58 production bridge/391warning unmeasured baseline remain separate and unchanged. This fixture increment does not reopen them or claim overall CI/full-duplex acceptance.

Freeze this exact helper delta plus original proof for the **existing independent source reviewer**, including residual typing disposition. No same-PR update or ordinary new-head Windows observation has occurred; either requires the substantive next gate. No Details/Naming/producer/DTO/renderer/phone/security/grant/release/provider scope was changed.
