# Producer fixture overlap: bounded design disposition and separate Chat evidence gap

**Disposition: DESIGN READY for one fixture-local ownership/cleanup correction under the contract below. This is not source approval, permission for an unchanged-head rerun, a Windows cause determination, or landing readiness. Both hosted failures remain unwaived.**

The current defect is independently demonstrated, rather than inferred only from timeout attribution. A single coalesced cleanup promise is necessary but insufficient: actual body completion and explicit acknowledgment of asserted synthetic errors are separate requirements. The writer can implement the bounded successor without another design handshake; its exact source and finite proof still require review before a same-PR observation.

## Exact reviewed objects and verification

| Object | Exact identity / scope |
|---|---|
| Hosted custody | `16991dca76a7a6117a3c7e26232ecae5b86d89d0`, tree `ed465801b27f213fdc5590c2c6427d191917170f`; `docs/evidence/3613-real-handoff-producer/hosted-failure-45075711451/` |
| Hosted source | `76656abec9b5f9a0fb6f6cd12b74178efcbf7ae2`, tree `0526a2a05866a683981805b546365aaf3b98af69`; production src `505ff0699b01779e52338e06a239d7cc15a6d2b1` |
| Actual hosted checkout | `f2a25a9272bd1bc0b832393731525e354aba7144`, parents `50c474b48f57e0256661244bd29b9343ec112bc4` and `76656abec9b5f9a0fb6f6cd12b74178efcbf7ae2`, same tree `0526a2…` |
| Authorized overlap source | `c535d031ef94617c2364e745a9765c91c2a31726`, tree `e602a6b981ce7fabb60edf75a9d16744ad8195f8` |
| Overlap custody | `e2da738ce3db11a21c250333e7a80a1ffb8347c2`, tree `9062d142aa27e65520ea797f38e8520063a6cb61`; `docs/evidence/3613-real-handoff-producer/fixture-overlap-baseline/` |
| Proposed contract | BOTH `165-overlap-minimal-hunk-contract.txt.gz` and additive `167-overlap-contract-refinement.txt.gz` from that exact overlap custody |

I read the full original hosted README and owner handoff, the full overlap README and both contract archives, exact fixture source, original logs, all five archived JUnit inventories, and both Chat contexts/traces. I verified all **68** hosted and **42** overlap lossless archives against their compressed/raw lengths and hashes, respective **70/44-file** directory inventories, and all **33** checkout witnesses in the original hosted log. Independent JUnit enumeration totals **73,255 rows**. The exact-classname producer/coupled/skill ledger was checked independently; the earlier broad skill-substring attribution is not substituted for the corrected exact family ledger.

The new baseline adds exactly **47 lines / 2,401 bytes** to the one fixture. Removing that control reconstructs the COMPLETE original **66,098-byte** fixture, blob `b455b81fd8dc3561df4ddedec77eadf1dc193cff`, SHA256 `77d6ebe34cee0b16d824e116d7dc8a7d96289f94c14a69ba6d1556de0e1d5738`. The original **2,781-byte** wrapper/cleanup is independently unchanged. I verified its clean before/after head/tree/src and all **16** corresponding archived input hashes/bytes. These are the owner's source-bound launch/completion receipts, not an atomic dependency seal. No type/lint proof transfers to the added control.

Companion verification JSON and read-only verifiers accompany this report. The reviewer ran source/artifact analysis only: **no product test, compiler, lint, CI, login, installation or production edit**.

## What the actual evidence proves

At original `test/annex-v2/handoff-producer-admission.test.ts:80–159`, operations, releases, fixture, directory and retirement state are global. Each `cleanupFixture()` independently splices `operations` into its own local drain. Once the first invocation owns a pending batch, a second invocation sees the array empty and proceeds to stop/reset/restore/remove. Teardown closures read `fixture` and `dir` later. There is no shared cleanup lifecycle or immutable original owner.

The admitted local **164** run at exact `c535…` genuinely returned **1 FAIL / 58 SKIP**, **four AssertionError nodes**, exit 1, whole-case **1.360444417 s**. Its command uses the existing gate at minimum 4, one worker, and only the new overlap selector. The four failures show that overlapping cleanup (1) completes, (2) invokes the real forwarded stop, (3) deletes original userData, all before the real source-held preparation is released, and (4) returns success instead of the original caller Error. The first cleanup stays pending and preserves that Error after actual release. Actual preparation settlement is awaited; successful preparation is not claimed. No timeout, hook error or EBUSY caused this local negative. All 58 original declarations were skipped.

The original hosted Windows unit1 evidence also supports **actual late continuation contamination**. The count-1 control fails after a 5,000 ms testcase timeout, with EBUSY for original directory suffix `vpmoqm`. The following count-9 row contains the assertion at **329:53**, whose source is exclusively `if (count === 1)`, and includes the original count-1 rejection plus EBUSY under the following directory suffix `lRnu4C`; that following setup also reports missing `annex-identity.json` there. This is stronger than a generic possibility of contamination. It does **not** identify the first body's exclusive delay or establish the causal chain for all 57 failed producer cases. The original two pending-work packets do not distinguish explicit cleanup from hook cleanup or locate hold release/transfer boundaries.

Run `45075711451` remains **31 success / 4 skipped / 2 failed**. Windows unit1 producer has **57 failed / 1 passed** with **72 failure nodes**; 53 testcase timeout nodes are not 53 independent root causes. The separate Chat failure remains a real failed gate.

## Required implementation contract — one fixture, one immutable owner

### 1. Owner and admission

Create a fixture-local owner **before the first asynchronous setup step**. Its identity, exact allocated directory, original setup/fixture reference, actual operations, releases, diagnostic records, retirement/completion state and expected-error acknowledgments remain attached to that owner. The eventual original fixture can be assigned once; replacement globals cannot become its teardown target.

All relevant wrappers and asynchronous continuations capture that owner. They must not re-read a newer `fixture`, `dir`, operations list or trace after an await. The functional call forwards once with original arguments/result/error; diagnostics remain outside functional-error containment. Actual promises are registered before a caller can await them or lose its waiter.

A later `beforeEach` must wait for or visibly refuse an unfinished prior owner **before** `mkdtemp`, shared module/cache/mock reset, identity setup or other shared setup work. This is not merely a check before assigning `fixture`. Partial/failed asynchronous setup is owned through actual settlement too; a timed-out setup may not install a late wrapper or publish a new fixture after retirement. If actual work remains hung, subsequent fixture admission may remain visibly refused under the existing deadlines. No runner cancellation, timed-out waiter or output packet releases that ownership.

### 2. One core retirement execution

The first retirement request synchronously closes that owner's caller intake and installs its coalesced core completion promise/record **before the first await**. All overlapping explicit/hook retirement requests join it. No invocation can steal a spliced batch, re-run teardown, or declare success because another invocation owns the work.

The sole core drain deduplicates original promise identities, awaits all settlements, and continues through newly registered owned batches until quiescent. Retain every original rejection; do not fail fast. Do not equate a waiting wrapper's timeout with actual caller completion. Release callback failures are functional cleanup outcomes, not optional diagnostic noise.

Mandatory steps remain attempted despite earlier functional errors, using the captured original fixture/directory. Stop, grant-request reset, mocks/timers/cache restoration and storage removal occur once. Shared module-level teardown is safe only while this owner still excludes a later owner; capturing a module's singleton `stop` function alone does not make that function owner-specific. The admission/lifetime owner must remain retained until whole-owner completion even when the live `current()` fixture reference is intentionally cleared after core teardown to preserve the existing manual-cleanup assertions. Those two states must not be conflated. Clear a shared current-owner pointer only if it still denotes this owner and its corresponding lifetime has actually ended. A stale call after the old owner completes may only join its completed record; it cannot stop a new host, reset new mocks or remove a new directory.

### 3. Body completion is a separate boundary; avoid self-wait

A cleanup promise settling is **not** evidence that its async test callback, assertions and `finally` continuation have finished. The observed hosted continuation makes this distinction material.

Use a bounded fixture-local callback-entry registration to capture the actual underlying async callback promise for every callback that can still access this shared fixture after retirement. This can be a thin wrapper around this file's own callbacks using public APIs; do not patch Vitest internals or introduce a generic framework. Register the raw callback promise before exposing an awaitable wrapper, preserve its original fulfillment/rejection, and bind its callbacks to the original owner. A cancelled/timed-out runner wrapper is not a substitute.

Required ordering:

1. Explicit/manual cleanup closes intake, joins the sole core work drain and receives its outcome. **It never waits for its own body**; that body awaits cleanup.
2. Automatic hook retirement first accounts for/releases this owner's registered held test barriers, then joins core retirement. This must still work when manual retirement already owns the core promise. Manual retirement must not prematurely release a hold whose purpose is to observe the still-pending drain.
3. The hook separately waits for the original actual callback/continuation settlement, including its assertions/finally and explicit acknowledgments. Body completion must not await that hook; no body→hook→body cycle.
4. Only after core work, relevant setup/body continuations, hold release and mandatory teardown have actually settled may later fixture setup acquire the shared state. Hook deadline expiry does not make an unfinished owner complete.

A hook may need to release an owned barrier to unblock core/body settlement, so it must not wait for body completion before releasing those barriers. Release exactly the original owner's registered controls once, recording failures. A test-side release is idempotent. If some callback is unregistered, do not advertise whole-body quiescence or let its possible continuation silently cross a later owner's setup. The concrete local callback/hook encoding and absence of cycles require successor proof, not an assumption about Promise reaction order.

### 4. Completion records and explicit asserted-error acknowledgment

Do **not** make a shared raw-rejecting cleanup promise the hook's entire protocol. Existing controls intentionally create and assert one or nine original caller Error objects; blindly rethrowing the same asserted error again in `afterEach` creates a new artificial failure. Conversely, swallowing every shared rejection masks unexpected failures.

Keep immutable per-stage outcome records (actual work, barrier release, mandatory teardown, actual body) and a final owner completion record when all stages settle. Preserve provenance and the exact original error objects. A core drain record may settle before the body/hook record; do not falsely call that the owner's final completion or rewrite it later as success.

Manual and overlapping waiters must observe the same actual core outcome: original single Error identity, or an aggregate retaining every original reference/cause for multiple failures. No empty-drain success, diagnostic replacement error or lost teardown failure. A later hook-only release/body failure remains recorded and surfaced even if the manual core waiter has already returned.

Expected synthetic errors require **explicit registration plus asserted-reference acknowledgment**, separate from body completion. An acknowledgment operation must verify the actual recorded outcome against the exact registered expected Error references and provenance, reject extra/unexpected errors, and record acknowledgment only after successful identity/shape verification. A soft assertion's return, merely attempting an assertion, catching a promise, body fulfillment, matching an Error message/name, or a generic `expectedError=true` is insufficient. The helper may perform the strict reference check itself while retaining every original test assertion.

The hook reports all unacknowledged actual caller errors and every unexpected mandatory teardown/release error **after** mandatory accounting. It may suppress only the duplicate reporting of those exact already-asserted synthetic caller errors, not change the underlying completion record or actual outcomes. Body failures/timeouts remain failures independently. Acknowledgment neither completes work nor releases admission, and must not authorize swallowing arbitrary teardown faults. No blanket hook catch. If a control deliberately injects a teardown fault, any explicit expectation must validate that exact separate provenance/reference; it cannot approve unrelated cleanup failures.

This resolves the two independent protocol gaps in initial165/additive167 without pretending raw-promise handling status is ownership or acknowledgment.

### 5. Optional bounded first-case observations and truthful early settlement

Retain the existing diagnostic containment boundary: at most **8 rows / 3 fields / 80-character tool text**, nonthrowing pre-forward and completion observation. Any added first-case markers must use a closed small phase vocabulary and owner identifier, bounded scalar timing/status, and an explicit output cap; no arguments, task/file contents, absolute temporary paths or exception payloads.

Useful phases are actual source selection, actual hold release, transfer entry/settlement, explicit drain start, hook join, actual drain settlement and actual caller outcome. Distinguish hook/manual origin without an unbounded event stream. Clock, formatting or console failure cannot skip/multiply a native call, mask its original result/error, skip stop, or claim actual drain completion. Emission is optional observation, not durable delivery or exclusive phase timing.

At original held-preparation helper **276–286**, waiting only for `entered` can strand a control when its actual caller settles first. A narrowly scoped race may distinguish real source-entry from that original caller fulfillment/rejection. Register/own the actual promise first, retain its real value/error through cleanup, and visibly fail an unmet hold expectation. Do not invent `ready:true`, retry work, return a positive authorization, or let early wrapper settlement release actual ownership. No timeout increase.

## Finite required proof; not yet executed on a correction

The existing writer may batch the following into one coherent fixture-only successor and exact evidence package:

- Reuse the genuine c535/164 baseline. On the correction, repeat the matched real held-preparation/registered-rejection overlap control: both cleanup waiters stay pending while held, no stop/delete before release, one mandatory teardown, both waiters retain original single/nine error references. Preserve the old complete fixture/control reconstruction.
- Prove new batches and rejected actual operations still settle before teardown; unexpected caller and cleanup errors remain observable after every mandatory step. Prove explicit registered/asserted acknowledgment avoids duplicate hook reporting of expected errors while an unacknowledged/additional error still fails. No blanket error catch.
- Prove the manual body→cleanup relation does not deadlock. Hold the actual callback continuation **after** core cleanup but **before** callback completion; hook/next setup must not call that owner complete. Release it and prove ordinary later admission. Exercise automatic held-barrier release independently from manual observation. A deterministic expired-waiter control proves only its modeled boundary, not Vitest cancellation or a Windows timeout cause.
- Prove late owner-A cleanup/continuation cannot touch owner-B storage or shared singleton state. Next-owner admission must wait/refuse while A is unfinished. A late call after A completes joins A's record. Use bounded fixture/sentinel controls; do not start conflicting app hosts merely to demonstrate isolation.
- Retain current/early-settled actual caller liveness, original function/error forwarding, partial setup failure and nonthrowing diagnostic fault controls. Preserve all original grant/real Git/catalog/history/assertion/cleanup semantics and deadlines. No production, grant, global MCP, dependency, workflow, registry or generic framework edit.
- Bind exact successor head/tree/source hashes and actual complete changed-fixture compiler/lint outcomes to normal admitted commands. Preserve failures and source bridges honestly; no aggregate final count from source-specific runs, no transfer of baseline type/lint, no broad lower/native reruns. Independent exact source/proof review precedes a same-PR update and any ordinary new-head CI observation.

This finite successor is not proof of the original Windows body's first delay, native Windows cleanup safety, closure of all 57 failures, or removal of the separate Chat blocker.

## Separate Chat PDF failure: evidence and minimal next seam

Both original and configured retry trace/context pairs show the intended `outside/report.pdf` **File preview is open**, with **`(Read-only) Couldn't read this PDF.`**. Initial `local-file-preview` visibility at `e2e/chat-rich/file-chips.spec.ts:203` succeeds; `Page 1 of 2` at205 fails after about **20,002.301 / 20,005.645 ms**, called from222. The painted-canvas assertion206 is **not reached**. The failed test's 45.143 s JUnit lifecycle is not an exclusive PDF read duration. This is an explicit PDF error state, not evidence of a merely slow canvas or unopened preview.

Original trace SHA256 `427862a2a9e50163c40e150c3e36c5408f73f2f6c9dda22187830e4ceab44a42`; retry `3c8a5824aa42925263ba6e706def2dacb6833c9e90aa02fe879f777fc670b892`. Both contain test-step traces and attachments, not a retained underlying loader/open exception or browser network/console history establishing its cause. Earlier text-preview screenshot attachments do not prove the subsequent PDF canvas state.

The minimal read-only source anchor is `src/renderer/features/agents/chat/rich/PdfPreview.tsx`, exact76656 blob **`79966405700cc715a27990bdbf9694084381170a`**, SHA256 **`3c2202a460e11c26fca41974f7c1adce986cc900f467cc85a2386f7f430db51a`**. Its21–31 loader/open rejection branch produces this generic message; its37–41 render rejection has distinct “Couldn't draw this page” wording. Thus retained evidence points to the **loader/open rejection branch**, without distinguishing lazy module load from `openPdf(data)`, bytes, transport, decoder or the original exception. No Chat implementation fix is justified by that generic state alone.

The retained Chat log's later “Rich chat content is off” stderr tail belongs to a different process (4732), after the failed original/retry app processes (6748/1468) closed. It cannot be assigned to the failed PDF attempt. The source paths/config/lock/workflows are unchanged between50c and76656; that proves changed-path identity only, **not preexisting/flake status, absence of indirect causality, or a passing baseline**.

**Recommended next step:** the existing Chat owner may inspect retained attempt-specific renderer/child logs and the loader/open rejection seam for the original exception, module identity and exact PDF byte identity if those are already retained. If absent, record that precise gap and propose a separate bounded diagnostic before any further execution. No unchanged-head retry, guessed Chat patch, ownership transfer, or expansion into Chat implementation is approved by this report. Producer cleanup proof cannot waive this independent failed gate.

## Boundaries retained

Earlier4aa/e08/454 reviews retain their exact source-specific scope. The new overlap boundary does not retroactively extend the sequential cleanup approval. All original450682/ab853 and450757/16991 failures, original diagnostics and fixture baselines remain immutable. There is no aggregate final58 result, Windows cause/fix claim, Chat acceptance, full handoff/duplex, human/provider/runtime authority, content/apply/wake, or Q5 production acceptance here.

The private Q5 workspace remains unchanged on `auto-reset-policy-design/q5-framed-root-journal-wip` at `079a257acf38b168b529fb7745dae97f686b72b8`. This publication contains review/evidence analysis only on a separate named QA ref. No tests or source changes were performed by the reviewer.
