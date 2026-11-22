# Producer hosted fixture c165: independent bounded delta review

**BLOCK / CHANGES REQUESTED.** The real agreement-scope correction and held-preparation ownership discriminator are valid within their stated source-specific limits. Two teardown/diagnostic failure paths remain in the changed producer fixture. Resolve them in one narrow fixture successor before the proposed same-PR ordinary new-head observation. No production approval is reopened, no hosted cause/fix is inferred, and no reviewer execution is requested.

Reviewed independently by auto-reset-policy-design on2026-11-22. Source/Git/archive/XML/receipt/graph inspection only: no reviewer product tests, compiler/transpiler, lint, CI, source edit or broad lower/native rereview. Private Q5/Details/Naming work and prior454/90fa/b6 reviews remain preserved.

## Exact freeze and scope

| Object | Immutable identity |
|---|---|
| Fixture source |`c1659088c68bd665fc1da0c61873729fcb9a85ee` |
| Source tree / src tree |`7ef23b3be3767f3c41227190be819295e41e4671` / `505ff0699b01779e52338e06a239d7cc15a6d2b1` |
| Published proof |`6fa27a5a7f7b497a779df831b008489741390658`, tree `263709d563430a9df9725cd5d2c3ddba361603fc`, parent c165 |
| Actual remote correction ref |`refs/heads/lane-3613-p2-routes/handoff-producer-hosted-correction=6fa27a...` |
| Reviewed original PR source |`7d244fcd153df00668ecac3d0709cece054801e3` |
| Preserved production verdict |[454 exact e90/7d244 scoped approval](https://github.com/Agent-Clubhouse/Clubhouse/blob/45495858a176a5971494cef2cfc5ae67ffbf9b18/docs/qa-transfer/2026-11-22/reports/producer-recipient-e90-independent-review.md) |

The actual full7d244→c165 difference is exactly two fixtures/117 insertions/25 deletions: `src/main/services/prepare-handoff-skill.test.ts` and `test/annex-v2/handoff-producer-admission.test.ts`. All production files remain reviewed7d244 bytes, including each intermediate source's production tree outside the skill fixture. Original protected fixture/evidence trees are unchanged; proof6fa adds only its hosted-fixture-correction evidence directory. Actual gh readback matches proof commit/tree/parent/ref.

Packet `docs/evidence/3613-real-handoff-producer/hosted-fixture-correction/README.md` SHA256 `cf92a03a6c6c089cb52b4ee7b3b59a14003213650de519ff2c7983ed107ba5c1`; manifest SHA256 `6173c6b8ac7fea8acaef4ac0118b93cccd494e51352c86e54f448503369bbc60`. README blob is the assigned `060d1bfe55de498c441df32c16dad53bf590f1c5`.

## Findings

| # | Severity | File | Lines atc165 | Defect | Confidence |
|---|---|---|---|---|---|
| F1 | Medium |`test/annex-v2/handoff-producer-admission.test.ts` |97–105,108–121,especially114 |A tracked caller rejection makes the spliced `Promise.all` batch reject before every other actual operation settles and skips the mandatory host/mock/cache/storage teardown. |High source-derived; no reviewer-executed counterexample/incident |
| F2 | Low |same |95,110–112, before113–121 |Windows diagnostic construction/emission is not contained; a diagnostic exception can itself bypass barrier release and the entire ownership drain/cleanup. |High conditional source failure; no observed native logger failure claimed |

### F1 — rejection forwarding is correct, retirement drain is not rejection-safe

The new callTool wrapper invokes the captured actual function once, returns its successful result, and propagates its rejection unchanged while marking the trace failed. It owns the returned caller promise in `operations`. That is appropriate forwarding, but it exposes a gap in cleanup's error handling.

`while (operations.length) await Promise.all(operations.splice(0))` removes the entire current batch before waiting it. If one promise rejects, cleanup throws immediately. Other actual work in that batch can remain pending even though the array is now empty, and lines115–121 never run. This also occurs when a test deliberately and correctly observes/handles a rejecting call: the same rejected promise is still retained for teardown. Duplicate references do not rerun work, but they do not turn Promise.all into an all-settlement drain.

The concrete unsupported path is one actual rejecting owned call plus a second real held preparation/operation. Retirement must release barriers, continue waiting all owned work and run mandatory host/mock/cache/storage cleanup before reporting the original rejection. The current algorithm cannot guarantee those outcomes. This finding does not assert that such a raw rejection caused the original Windows timeout/EBUSY cluster.

**Required narrow correction:** drain all settled outcomes in each owned batch while retaining rejection information. Continue accounting for any newly registered owned batch; ensure mandatory teardown runs despite an earlier rejected caller. Preserve the original caller-facing result/rejection and do not swallow a real failure into success. If cleanup reports the retained error, do so after the relevant actual work and required cleanup, with original error identity/cause retained rather than an unrelated observer error. No global/product drain or new framework is needed.

**Required focused proof:** genuine originalc165 failure with one genuinely rejecting actual caller operation and one actual callback-held preparation; observe teardown still pending/storage present while the latter is held, then release it and verify required cleanup occurred and the original rejection remained observable. Preserve a successful current/held preparation control, rejection forwarding and early-settlement behavior. An already rejected dummy counter with no real pending operation is not the full ownership discriminator. No reviewer execution or broader producer/native matrix is requested.

### F2 — diagnostics must not own cleanup success

On Windows with pending work, `console.error(...toolWork.map(...Date.now...))` executes before any barrier release or drain and without try/catch/finally containment. A throw from diagnostic construction or emission becomes the cleanup result, preventing the functional teardown below. Node/Vitest logging behavior in normal successful output does not prove that this diagnostic cannot fail; the new trace is observational and must not become a prerequisite for releasing real fixture work.

The trace also samples the diagnostic clock at95 before forwarding the actual call; observational failure must not mask or multiply that original invocation. The required containment should cover that metadata construction as well as teardown output.

The payload is metadata rather than file content, but currently serializes the full accumulated trace array. The source gives no explicit output cap. The current selected tests are finite; this is not an observed unbounded allocation or sensitive-data incident. Keep a concrete small row/field/length limit when making the output best-effort so future fault controls or repeated calls do not turn it into a new failure source.

**Required narrow correction:** contain diagnostic snapshot/build/clock/emission failures so they cannot mask the original operation result or skip barrier release, actual drain, stop, restoration or storage cleanup. Retain bounded pending-tool/age metadata and original deadlines; no additional observer framework or speculative body-phase tracing is needed. Do not catch/suppress the functional owned operation's failure as if it were only a logging error.

**Required focused proof:** force the diagnostic path and a construction/emission failure in a disposable isolated fixture control, while actual caller work is held. Verify release/drain/stop/cleanup still execute and the original operation result/rejection remains truthful. Preserve an ordinary bounded diagnostic/current cleanup control. Simulation is not native Windows acceptance, and no native failure/5000ms phase is asserted here.

## Scope/authority fixture correction inspected

The skill fixture now exercises actual durable primary records, caller-gate entries, actual registry/config/arg-target/grant implementations and an isolated standing Allow policy. Passive mocked lifecycle subscription ports are modeled explicitly. They let the real producer owner initialize/dispose; they do not establish watcher integration or live grant changes.

The script still invokes captured registered real handlers directly (`call` invokes `handler('sender',args)`). It is not newly promoted into a generic public callTool/bridge/human-approval proof. The original fake successful permission result and agreement-wrapper bypass are removed. The real handoff argument scope, fresh domain evaluator, original-recipient binding and final continuity run against those isolated fixture inputs. Durable configs/caller-gate entries should not be described as a newly exercised real CLI/bridge identity; no live model/provider/human is present.

The original five skill testcase bodies/assertions/deadlines are byte-identical after removing the one added no-scope negative from the comparison. That negative uses the same actual prepared source, intentionally bypasses the wrapper, and requires an error, empty actual history and byte-identical catalog. It is an intentional invalid-scope control, not a replacement `false` permission result. The diagnostic host-call logging spy used to expose the intermediate exception is absent from finalc165. Existing Vitest config has `mockReset:true` and `restoreMocks:true`; no new cross-case scope bypass is silently retained after the negative case.

132 first exposes the missing passive binding listener in the old fixture.135 has the valid modeled ports/real authority implementations but retains the agreement bypass, and genuinely refuses at original-recipient binding with `HandoffAuthorizationChanged`.136 removes that bypass/fake positive and passes six skill cases at its own a0 source. The new rejection/diagnostic findings do not invalidate that scoped correction.

## Owned caller-work and early-settlement changes inspected

The producer fixture now observes only its designated caller's actual `callTool` promises; other callers are forwarded as before. It refuses starting new designated-caller work while fixture retirement is active, releases fixture-owned barriers, drains registered operations and then performs existing host/cache/mock/storage teardown. This does not cancel arbitrary timed-out test continuations or invent product MCP running-call semantics. The missing failure-path guarantees are exactly F1/F2.

`queuedOffer` now races the two real hold barriers with actual call settlement. If the call resolves early, it fails with an explicit early-settlement error rather than waiting forever for unreachable callbacks; an actual rejection propagates as a rejection of that race. The settled result is diagnostic fixture data, not a new product result. The race does not retry, alter authority or raise a deadline. In the positive path its matching barrier is still the real preceding history transaction.

139 extracts the original cleanup into a function and starts one real preparation whose actual source callback is held. It observes the cleanup turn for25ms under the unchanged default5000ms test deadline. Its three actual AssertionErrors show premature cleanup completion, disappeared fixture storage while preparation is held, and subsequent real preparation error. It is not a timeout-only red.140's correction passes the new held-preparation case and existing current-sender/history-queue case, atdd508. That passing fulfillment control does not exercise a rejected operation or failed diagnostics, hence does not close F1/F2.

All prior producer testcase bodies from the first existing current-sender case onward are byte-identical; existing assertions/deadlines are preserved. The new teardown case is additional, not a weakened old assertion or timeout change.

## Exact execution and erased-type bridge disposition

The nine original source-associated commands, exits, compiler diagnostics and XML records are verified independently; these are not an aggregate finalc165 runtime result:

| Run | Source | Actual result |
|---|---|---|
|132 |3e82ffa1c |1FAIL/4SKIP, one failure node; missing modeled binding listener |
|135 |71b929176 |1FAIL/4SKIP, one failure node; real no-original-scope refusal |
|136 |a0b564ed4 |6PASS; complete skill fixture including no-scope negative |
|139 |330ff8954 |1FAIL/51SKIP; three AssertionError nodes, actual premature cleanup |
|140 |dd508e392 |2PASS/50SKIP; held actual preparation and current history queue |
|141 |dd508e392 |compiler exit2/four actual fixture diagnostics,3959 inputs |
|142 |a923690f3 |compiler exit2/one actual fixture return diagnostic,3959 inputs |
|143 |exactc165 |compiler exit0/zero diagnostics,3959 inputs |
|144 |exactc165 |lint exit0, two complete fixtures/zero errors/zero warnings |

Final producer fixture bytes equaldd508's executed bytes. Final skill fixture differs froma0/dd508 by erased type import/annotations only. I independently removed exactly those introduced type-only declarations and recovered the original a0/dd508 source byte-for-byte. The archived TypeScript5.9.3 script/receipt separately records identical15874-byte emitted skill JavaScript, SHA256 `fb4c0ed5fb859f2786acf487cf67c700630aeefafc0a926239892fdde2dc52c9`. Its source heads/options and equality check are consistent with that source bridge. The reviewer did not execute another compiler/transpiler; the emitted hash is the owner's archived transform observation, not a newly executed reviewer result or Vitest-transform identity.

Thus136's six runtime passes remain ata0 and140's two remain atdd508. Neither is relabeled as an aggregate final52-case run or finalc165 execution. Final143/144 really belong toc165; original141/142 failures remain unchanged rather than silently transferred to an old baseline or labeled PASS.

## Archive, source receipts and compiler graph verification

All77 committed gzip archives match compressed/raw lengths and SHA256 values and roundtrip losslessly. Five raw XMLs and their full row derivations match120 testcase rows, including names/classes/results and full failure-node serialization. Rows, executed cases and failure nodes remain distinct. All archived full source variants and selected intermediate deltas match Git. The complete original454 review archive matches its published16134-byte report exactly.

All nine before/after pairs have matching actual clean head/tree/src-tree and16 relevant hashes, raw gated START/END/exits and exact commands. Fourteen entries are tracked source/config/doc bytes matched to corresponding Git trees; cached config/receipt-script observations remain cached bytes, not new committed source. These observations are not an exclusive filesystem lock or atomic executable/all-input read seal.

143 has3959 ordered raw listFiles entries matching the after-execution inventory. All2471 tracked byte hashes independently match frozen c165 Git;1488 dependency hashes remain owner-observed after execution. The unweakened config extends root tsconfig and explicitly includes three **complete** producer, coupled handoff-tools and skill fixtures, with full src include and only noEmit added. There is no target/lib/exclude relaxation or reduced legacy mock graph. Final144 actual full JSON contains exactly the two changed fixtures/0errors/0warnings. No old compiler or lint scope is substituted and no prior101/other graph is retrosealed.

## Original hosted failure and remaining next step

Original Validate45068217103 at7d244 remains actual FAILURE,31successful/4skipped/2failed. Its preserved ab853 packet remains the authority for the original logs/checkouts/JUnits. The current packet preserves the13405-byte Windows log excerpt and full-log SHA association; late catalog ENOENT after fixture removal and the first producer current-history-queue timeout are observations, not an exclusive body-phase duration. This fixture ownership counterexample supports a real local defect, but does **not** prove the first5000ms body phase, slow-Git/path root cause, or closure of all36 Windows producer failures/EBUSY nodes. Original checkout collector's eleven matches do not prove every failed UNKNOWN STEP unit witness was extracted. No flake, Windows cause or hosted-fix claim is accepted.

Preserve c165/6fa, all source-specific originals and production approvals. Resolve F1/F2 together with a rejection-safe actual-work drain and contained bounded diagnostics, plus matched original-source/current/fault controls and exact pre/post source receipts. Return one frozen narrow delta for independent review; no broad unchanged producer/native/lower rerun is requested.

Only after that source/evidence verdict and ordinary fresh guards should the owner update the same PR for one ordinary automatic new-head observation. No blind rerun, manual dispatch, timeout/grant/workflow change, new framework or product drain is needed. Cause/fix/hosted/landing acceptance, full native/human/bridge/provider/content/apply/wake/two-host/full-handoff/duplex and protected Q5/UI/Details/Naming remain outside this review.
