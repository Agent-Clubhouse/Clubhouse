# #3775: single automatic hosted failure, landing held

**Real required-check failure; cause unresolved.** PR #3775 remains at reviewed `30bf4c2d11ad8027b1e408a423794bccbc52c9d5`, source `fb21d4cca635ccdbb109acfb5f249ba291d00293`. No rerun/manual dispatch, deadline/source/config change, new diagnostic framework, release, Details switch or full-duplex claim. This packet is on a separate evidence-only ref, not a new PR head.

## Actual execution and composition

- Sole automatic Validate run [44999624534](https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44999624534), attempt1, `pull_request`, exact head30bf; terminal **FAILURE**, updated `2026-11-22T08:06:50Z`.
- Actual jobs: **32SUCCESS / 4SKIP / 1FAIL**. Failed job [137138153724](https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44999624534/job/137138153724), Windows unit/component shard1/2. Sibling Windows shard2/2 job `137138153702` succeeds.
- Both official Windows raw logs identify actual checkout `2d958bcc3071560a7d78b90c66342ce7d806ec64`, ordered parents `63f140b2a0ba00e686fb727a931d6b340fc3ee7e` and30bf. Tree `bf2f0e9f284e9acb107ac6454a23081a0099cf56` is exactly reviewed composition. Windows Node `22.23.4`.
- The canonical checkout commit payload is retained in `artifacts/checkout-original.commit`; its Git commit-object SHA-1 independently reconstructs2d958. This preserves the checkout even if the transient pull merge ref later moves.
- Its canonical signature-continuation whitespace is preserved, not reformatted: the first unscoped staging `git diff --check` returned2 on that raw payload. Manual-document checks are scoped separately; this packaging result is not a source/test failure or a claim that all raw artifacts are whitespace-clean.
- Fresh PR/main snapshot: OPEN/non-draft, head30bf/base63f, MERGEABLE but **UNSTABLE**; actual main remains63f. Landing held on the real failed check, not waived by scoped cases passing.

## Official Windows JUnit attribution

| Shard | Artifact | PASS | FAIL | SKIP | Gitdiff scoped cases |
| --- | --- | ---: | ---: | ---: | --- |
|1/2|`14745761003`, `test-results-windows-latest-1`|19389|1|93|1 adapter PASS|
|2/2|`14745064507`, `test-results-windows-latest-2`|16751|0|176|26 control +3 actual target PASS|

Thus the **30 named Gitdiff cases execute PASS/0FAIL/0SKIP on Windows at the actual reviewed PR checkout**, not transferred from earlier local heads. The adapter takes0.2596373s; actual target exact9MiB /32MiB /+1 cases take0.2802141 /0.691477 /0.4607494s; raw `/content` query exact32MiB case takes0.2793416s. All other exact cap/caller/method/path/query/no-bulk and held cancel/revoke/replacement named cases are included in the original attribution JSON. This is the existing fixture/producer-mocked scope, not native Git/TLS-control/full-duplex or timeout-cause proof.

Original archive/member identities:

- Shard1 ZIP:612,579bytes, SHA-256 `f5a80a3e1f81bc99c6811777eee25c6966bf8a49d4169c42bf9378da20181b62`; original `test-results.xml`:6,798,076bytes, SHA-256 `bbb81498d8a7caf8bf0291de6b00dd4e7f58bdc4b9abebef0a06d897a94b0bd9`.
- Shard2 ZIP:562,663bytes, SHA-256 `4e7f025e2e047eb8603f023438bcacf9c7a86b5fa72138dbdc2b7272e8342b26`; original `test-results.xml`:15,916,194bytes, SHA-256 `c30f1d453c324bd5428fc101b482b67fd0bba88100203cb19e45ecd0519a2045`.

## Exact checkpoint failure and existing phase receipts

The only failed case is `checkpoint-tracker.test.ts`:

`checkpoint tracker > reverts a completed turn and undoes the revert with exact bytes and undoable state`

Primary signature: **`Test timed out in 5000ms.`** JUnit reports6.3991128s; stack names `test/dispatcher-work-owner.ts:165:29` and test line196. The complete checkpoint fixture is10PASS/1FAIL/0SKIP (11cases).

Existing failure/retirement packets are independently extracted from the official raw log **and JUnit** and equal:

```json
{"reason":"abort","phase":"undo","phaseComplete":false,"elapsedMs":6194,"rawPending":1,"directPending":1,"childPending":1,"callbackPending":1,"closePending":1,"accountingKnown":true,"closing":false,"retired":false,"teardownOutcome":"not-started"}
{"reason":"teardown","phase":"teardown","phaseComplete":true,"elapsedMs":6398,"rawPending":0,"directPending":0,"childPending":0,"callbackPending":0,"closePending":0,"accountingKnown":true,"closing":true,"retired":true,"teardownOutcome":"retired"}
```

These are already-present fixed metadata, not new instrumentation. They identify an unfinished **undo envelope** and later complete inventoried retirement. They do **not** identify the pending command/PID or prove an OS process was still running rather than awaiting JS callback/close delivery.

### Duration and lifecycle limits

- `elapsedMs` starts at fixture construction **before synchronous setup**, including six native Git setup commands. It is not an undo duration, exclusive body duration or measured Git-child duration.
- Phase `undo` spans `undoRevert`, result/byte assertions and the later `listTurns` assertion. A single pending direct/child receipt cannot distinguish those awaits.
- No phase-start times, child command/PID/start/end timeline, polling-attempt count, scheduling/load/RSS or separate hook/body timing was recorded. JUnit6.3991128s is its reported testcase duration, not a replacement measurement of the unchanged5000ms deadline.
- The204ms between the two rounded lifecycle snapshots includes late raw/direct work and retirement; it is **not isolated teardown or undo timing**.
- Retirement verifies inventoried raw/direct/event/child callback+close settlement before captured deletion and next setup. It is not all-host quiescence, and does not credit abandoned post-timeout assertions: raw receipts also release on rejection.

Native Git's existing per-command upper bound is120,000ms, distinct from the fixture5000ms deadline. Neither bound changed. No native timeout/error message or concrete cleanup failure is established by this episode.

## Source/ownership assessment and disposition

The failing test, tracker, checkpoint operations and existing lifetime/raw-registration helpers are byte-identical at63f and30bf; exact blobs/hashes are in `source-phase-attribution-original.json`. **Unchanged source is not a baseline execution or causal proof**, and does not establish a flake, an Annex/Gitdiff cause or absence of indirect resource effects.

[Bounded read-only assessment](checkpoint-assessment.md) identifies one source-supported removable fixture cost: repeated native ref polling in `runTurn`, for which the already-owned production event-idle primitive exists. It is a **proposal**, not an implemented change or demonstrated timeout fix. No production defect is established and no generic instrumentation loop is proposed.

The accepted [4f6 independent Gitdiff source/nonregression disposition](https://github.com/Agent-Clubhouse/Clubhouse/blob/4f6ae1adf61dfb5ea6f81e83f8ad85dc02b0e595/docs/qa-transfer/2026-11-22/reports/gitdiff-fb21-independent-source-review.md) remains separate: full actual fixture compiler **FAIL139**, zero mapped new diagnostics; root03fd58 unchanged-production bridge; local30-case source attribution;391 lint warnings with **unmeasured baseline**. No existing review/proof is relabeled or reopened.

`manifest.json` seals official originals, lossless raw archives, exact XML attribution, source/checkout identities and these limitations. Original uncompressed private copies remain. Next disposition belongs to existing independent review: evaluate the narrow fixture-wait substitution or retain the precise unresolved cause. No merge/check waiver, new CI or source edit is inferred from healthy Gitdiff cases.
