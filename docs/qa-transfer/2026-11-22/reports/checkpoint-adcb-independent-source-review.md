# #3775 checkpoint helper: APPROVE scoped same-PR update and observation

**APPROVE exact source `adcb284b217030163574b2b094df2b482cdc8684` / tree `1f23b1350640314a18b3e9aee66de5711f3b49fc`, carried by evidence `a9e3717944a75425dd6feacb5a32848cae110d83` / tree `9eac5a872e38ab7510d81e82e2d5ed0ed1030e48`, for the SAME PR #3775 update and one ordinary new-head Windows observation after normal fresh-main/head/clean/pushed guards.** No remaining bounded source or readiness-proof blocker was found. This is not landing/check-waiver authority, Windows deadline success, historical cause or a guaranteed timeout fix.

Reviewed only the helper/proof delta against [5de7 design](https://github.com/Agent-Clubhouse/Clubhouse/blob/5de7ec2cdbb561c8094df698da3a8f95a1c54801/docs/qa-transfer/2026-11-22/reports/checkpoint-wait-b086-independent-design-review.md). Gitdiff source review was not reopened. No test/compiler/lint/application/CI run, source edit, new framework, install or original-owner workspace change was performed by this reviewer; gh was used for GitHub operations.

## Source and lifetime

The complete tracked delta from held30bf is **one file,4 additions/2 removals**, entirely in `runTurn`89–97. Both original requested-turn predicates are unchanged. Each stage now awaits the existing owned `whenCheckpointsIdle` then performs exactly one owned `listTurns(agentId)` read and asserts that predicate. The original edit remains between completed start and end.

All other fixture code is byte-identical: other `settle` callers, direct end-before-start overlap, shared/quietness/subdirectory behavior, actual revert/undo result and exact byte/undoable assertions, synchronous setup, captured directories/options, abort/failure evidence, raw/direct/event/native wrappers, late admissions and retirement. All production/lifetime/config/deadline code is unchanged. The source/test/config bytes remain identical at the containinga9 evidence commit.

The accepted producer trace remains applicable: actual handler registration is synchronous before return; start includes checkpoint/shared work, end includes start dependency/shared/end/pruning. `allSettled` is settlement, **not successful checkpoint creation**, so the explicit same-turn assertions are substantive. Producer idle is not native callback-and-close quiescence; the existing owned wrapper and unwrapped close controller retain their separate raw/direct/event/child/callback/close accounting. No cleanup boundary is shortened and no raw promise is replaced.5000ms case and120000ms native command bounds remain unchanged.

## Real-Git readiness discriminator

I reconstructed both disposable overlays from the exactadcb fixture and matched their full preserved source/input SHA256 values. The overlay adds actual `checkpointRef`/native Git `.lock` setup only inside the captured temporary repository. Existing child-process wrappers still delegate to actual native Git. Edit/continuation spies are observation controls, not Git mocks.

01 executes2 pass/0 fail/11 intentional skips. An unrelated completed turn is actually present. Missing requested start rejects at the assertion before edit/continuation and leaves `one\n`; missing requested end performs the original edit once but rejects before continuation, preserving `two\n`, the requested start, absent requested end and unrelated complete end. Thus generic “some completed turn exists” cannot replace the required identity check.

02 retains the same owned idle and one read per stage, removing only the two readiness assertions. Both cases fail specifically with **promise resolved instead of rejecting**, not a timeout. Later guard assertions in those failed cases are not credited after the first failed rejection expectation. Their independently parsed teardown packets still show retired with every inventoried pending count0. This discriminator proves the assertions prevent false success; it is not a speed or old-polling runtime comparison.

The overlays/import/control cases are absent from the shipped fixture. Restored03 executes all11 original real-Git cases PASS/0 skip, including the exact revert/undo case and the independent direct overlap/race. Scoped05 lint is0 errors/0 warnings and a separately executed command, not credit for lint skipped by an earlier failing chain.

## Explicit compiler disposition

**Accept the independently verified zero-regression comparison as sufficient scoped typing evidence for this test-only update and ordinary new-head observation. The actual changed-test-inclusive compiler remains FAIL1 on both candidate and exact baseline. Neither is compiler PASS.** This is a different graph from the earlier Annex139-error fixture graph; no139→1 improvement or transfer is claimed.

The134-byte config extends the unchanged root config and explicitly lists `checkpoint-tracker.test.ts` in `files`. It adds no compiler option override. I checked the original04/06 `--listFiles` outputs against their complete captured ordered graph records: each contains **3958 inputs**, with the changed test explicitly present exactly once despite the root test-exclusion glob. This is actual changed-test coverage, not an unchanged root-excludes-tests substitute.

The ordered paths are identical. All **3957 other full input records** (path/byte length/SHA256) match; the only difference is the expected fixture source:

- candidate `913d21b98b995c3867ec30a937e8819685e264f4c3989682dfc98b7ba59b1796`;
- exact30bf baseline `949e96e414a05fe0001e7a1e79f9507541668f9ed2976bbcb4eec7e0d9045d44`.

Both original compiler commands, config/root bytes and captured ordered graphs match. Baseline06 is the exact baseline fixture bytes restored while HEAD remainsadcb, **not a baseline-head runtime execution**. The captured compiler graph hashes were independently compared; this review did not recompile or claim an atomic seal of the compiler executable/whole host.

The sole original diagnostic matches in full file, line175, column33, codeTS7024, message and multiplicity:

`test/checkpoint-fixture-lifetime.ts(175,33): error TS7024: Function implicitly has return type 'any' because it does not have a return type annotation and is referenced directly or indirectly in one of its return expressions.`

That helper's complete bytes are unchanged and match the captured graph identity. No line-shift mapping is needed; there are zero observed changed-test/new-graph diagnostics. Both exits remain2. No annotation repair, cast, relaxed option, reduced graph or success-shaped fallback was introduced. This narrowly supported baseline debt does not block the helper-only update; it remains visible and is not repaired or erased by this verdict.

## Binding and remaining gate

Manifest SHA256 is `505ef32dfcc497a189c84c55fe986438bc83e42dd44500f8ebf20968baf0f16d`. All34 committed artifact blobs,32 first lossless packages,12 declared source/config input identities, both exact overlays and six command outcomes were checked. Actual JUnit counts/primary messages and teardown packets were parsed; gzip originals reconstruct byte-identically. Source/overlay/launch/restoration receipts are preserved; no atomic whole-environment/runtime/transitive execution seal is invented.

The unchanged source and lifetime semantics make the bounded synchronization change suitable, with healthy local execution and meaningful negative proof. Waiting for complete shared/pruning/global tracked work can still take longer. Local darwin/Node24.22.1/Vitest4.1.12 results do not establish Windows speed, a universal deadline guarantee or why the original undo envelope timed out.

Original44999624534/b086 failure remains real, preserved and a landing hold until the normal changed-head check process is completed. No blind same-head rerun/manual dispatch or extra diagnostic framework is requested. The parent-authorized ordinary new-head observation must report its actual checkout/head and checkpoint result; a green sample will not retrospectively prove cause. Any new source or hosted failure needs its bounded disposition.

The4f6 Gitdiff approval, its actual139FAIL/nonregression/root-fd58 bridge and unmeasured391-warning baseline remain separate and unchanged. No Details/Naming/producer/DTO/renderer/phone/current-app/P8/full-duplex/release acceptance follows. Private Q5 remains clean at079a/tree89e; no source work resumed.
