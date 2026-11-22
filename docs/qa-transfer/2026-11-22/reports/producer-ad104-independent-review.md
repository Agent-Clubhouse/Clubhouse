# Real handoff producer ad104: independent source/evidence review

**BLOCK / CHANGES REQUESTED.** Two source-derived admission-fence races remain. Neither is a reviewer-executed counterexample or an observed product incident. The exact candidate is not PR-ready. Preserve ad104/ef992 and its original results; correct these private seams in one successor, retain finite semantic controls, then obtain exact-delta review. No broad lower/native rerun is requested.

Reviewed by auto-reset-policy-design, 2026-11-22, against the full accepted [2d363 design](https://github.com/Agent-Clubhouse/Clubhouse/blob/2d363a2c592133155979ddd599d17453aa578404/docs/qa-transfer/2026-11-22/reports/producer-664eff-boundary-review.md). Source/archive/XML/receipt inspection only: no reviewer product tests, compiler, lint, CI or live action. Private Q5 remains untouched; Details/Naming and accepted native/lower proof are preserved.

## Exact freeze and scope

| Object | Verified identity |
|---|---|
| Implementation source | `ad104a538772156af463f3750783fbf4cd99c39c`, tree `ce7bd1ed851cd28cdb52af76c9f5f63b14bdb446` |
| Entire src identity bridge | `src` tree `e9da1ee8179d0592e897365f7f84824fdc687d1c`, equal `f05d72834653dbb1314c5083e3b6f82d8dd31f41:src` |
| Published candidate | `ef99265da9faddddf522c2c294745d86d593d78d`, tree `7a44b77cf3eed75ddcec1d8b3fd027855fe29d89`, parent ad104 |
| Actual candidate ref | `refs/heads/lane-3613-p2-routes/handoff-usable-path=ef99265...`, gh readback verified |
| Correct boundary publication | `refs/heads/lane-3613-p2-routes/handoff-producer-boundary=664effcd1d6d10858c0c7904983628a0393a0780`, gh readback verified |
| Base | `50c474b48f57e0256661244bd29b9343ec112bc4` |

The advertised boundary's old local branch label and original404 observation remain historically accurate; the separate durable boundary ref is now actually verified. No owner concurrence or ref was invented.

Packet: `docs/evidence/3613-real-handoff-producer/candidate/README.md`, SHA256 `c847815fe5cfd95e2f7f0f7c2d7511c4c98d9820b690620319ac6eeea64ce336`; manifest SHA256 `7d2d7ffc58cd1112ee92e7741ec10c871f743b4132df7952a5b1651cad7069d8`.

All9 selected base/source blob identities and the complete selected patch independently match Git (1099 insertions/52 deletions). Six private production files, the coupled tool fixture, complete new producer fixture and route documentation are the selected implementation delta. The added baseline/candidate evidence is distinct from runtime source. Phone fixture, native ingress/control evidence and lower reverse/synchronization trees are base/source/proof-identical. No grant engine, generic MCP registry/gate, shared persistence helper, worker, provider, renderer or protected Q5/Details/Naming production edit is present.

## Findings

| # | Severity | File | Lines at ad104 | Vulnerability | Confidence |
|---|---|---|---|---|---|
| CP1 | Medium | `src/main/services/handoff-service.ts`; `src/main/services/clubhouse-mcp/handoff-permissions.ts`; `src/main/services/handoff-host.ts` | service106–110; permissions27–31; host352–390 | Positive consumed-approval/context is checked before another awaited producer verification, while the final synchronous fence does not cover approval invalidation/context changes in that later window. | High, source-derived; not executed by reviewer |
| CP2 | Medium | `src/main/services/handoff-host.ts` |301–305,315–324,379–390 | Verification copies the latest source revision into the verified revision even if a notification appended that revision's still-pending observation after the promise being awaited was captured. It can certify work it did not await. | High for ordering invariant; concrete host interleaving proof pending |

### CP1: approval can become invalid after the positive result, before admission

At service106 the actual serialized history callback awaits full `authorize`. Its handoff helper verifies canonical expected recipient and uses the original call arguments, current grant evaluator, original consumed context, and (for fresh Ask) captured `callApprovalVersion`. That is a useful correction of the earlier queued-before-authorization Ask case.

But service107 then awaits `admission.verify()`, which performs further source/project/config reads. Only after that does it call `check`, test the already resolved Boolean, and call `admit` before the marker/catalog work. The producer's synchronous `check` tests host/retirement, filtered standing offer-grant stamp, target/source stamps, directory anchors, selected entry and source observation revision. It does not test the consumed approval version or the exact consumed context. Standing Ask can remain unchanged while `dropCallApprovalsFor` increments the original approval version. The same gap can affect an Ask context field such as caller runtime that is intentionally benign for a fresh standing Allow.

Finite schedule: consume an actual isolated same-call Ask approval; let the queued full positive helper return true; hold one real later source verification await; invalidate the consumed approval while keeping standing Ask, source, recipient and host otherwise unchanged; release that await. The cached `authorized=true` and current producer checks do not reject that specific change, so the code can admit and reach first write with invalid consumed approval. This is a source counter-schedule, not an executed result in the packet.

Existing case410–422 drops the approval while the earlier history transaction is held, **before** this positive helper executes. Existing case373–396 exercises an actual handoff grant off→allow notification during positive authorization, which the producer's grant stamp/listeners catch. Neither tests approval-only invalidation after the positive result, nor its distinct final-context dependency. Run86's actual old consumed-approval failure and87's green therefore do not close this later gap.

Required correction: make the final synchronous pre-first-write admission fence carry and validate the exact original approval/context dependencies through **all** subsequent awaits. A standing fresh Allow must not become dependent on an approval version; general gate/forget-only must not become cancellation. Keep original args/key and no new consumption, prompt, live grant or generic registry/gate rewrite. An async recheck followed by another unguarded await only moves the race. An appropriate sealed/captured proof plus a synchronous final continuity check is acceptable; exact implementation must show why it covers version and relevant context changes.

Required proof: original ad104 red with a held actual post-positive verification await, exact same-call Ask approval drop, no marker/binding/history/notice/new POST; corrected green; matching still-current Ask and fresh Allow/forget-only controls. Include a changed-context control if the fix claims more than approval-version coverage. Preserve the genuine original and avoid an artificial mock that merely substitutes a false authorization result.

### CP2: pending source observations can be marked verified

`observe(work)` increments `sourceRevision` and replaces `this.observations` with a promise that includes `work`. `verify()` awaits `this.observations` at entry and again after fresh source/config lookups, then unconditionally writes `verifiedRevision=this.sourceRevision` at389. The revision copied is not the revision of the promise actually awaited.

A concrete relevant interleaving is possible when the final awaited observation promise is captured, then a config/project notification appends another asynchronous lookup before the verifier's continuation executes. The new lookup may still be pending when the continuation resumes. Earlier `current`/`rows` can still be the old valid source; original directories and quick registration may remain. Copying the now-incremented revision makes the final equality check succeed even though that revision's identity/membership result has not settled. Holding the appended lookup through service108 isolates the issue; later retirement cannot undo an already admitted marker/catalog/history workflow.

| Step | Relevant state |
|---|---|
| Verification awaits captured P(R) after reading source/config | P(R) is the work covered by that await |
| A notification appends still-pending P(R+1) | `sourceRevision=R+1`; P(R+1) includes the new config/project lookup |
| P(R)'s verifier continuation resumes | It writes `verifiedRevision=R+1` without awaiting P(R+1) |
| Final check/admit runs while new lookup remains held | Revisions falsely agree; sync anchors do not establish current project membership/config identity |

This is specifically the pending newly appended observation window; if its callback finishes and retires the owner before final admission, the existing retirement guard works. Likewise, a notification occurring after verifiedRevision is assigned is caught by the equality check. Neither fact justifies blessing a pending revision in the window above.

Required correction: pair a captured observation promise with the revision it actually validates. Do not advance `verifiedRevision` to any newly appended revision unless its own observation settled and the relevant source read is coherent with it. Safely refuse on an unstable revision or perform a finite stability/reverify loop with honest refusal at its bound. Preserve benign-event liveness; avoid arbitrary infinite retry, busy polling, or ignoring a pending lookup just because it may later prove cosmetic. Do not admit and wait for the observation only at owner disposal.

Required proof: deterministically append a real config/project observation between the final wait snapshot and resume, keep its actual lookup pending through the proposed final fence, then resolve an incompatible original source/membership. Assert no offer-specific effects and retain unchanged/current plus benign-observation completion controls. A direct assertion of the private counter alone is not the end-to-end admission proof. Use the existing isolated real source/store callbacks and held dependencies; no reviewer rerun is requested.

## Other inspected implementation boundaries

These are source observations and bounded evidence, **not partial product acceptance overriding CP1/CP2**:

- The tool clones original args and enters the handoff call context before its module await. The original approval version is captured synchronously in that context. `offerCallerHandoff` captures/registers a host producer before ready/source/preparation waits, retains the exact host/machine, and calls the captured coordinator. No later host recapture is used to select a replacement.
- Full positive authorization is moved into the actual history transaction after duplicate/capacity checks. Expected recipient is computed from immutable record.to and compared to the helper's resolved target. This closes the demonstrated earlier alias mismatch, subject to CP1's later-await continuity issue. No negative grant/target stamp substitutes for full positive authority.
- Exact preparation selection carries its catalog ID, original owner/source/mode/summary; final selection assertion and `bindPreparedHandoff(record, selected)` do not fall back to another equal-summary entry. Existing standalone preparation still uses its own source lookup and per-owner ordering. Implicit preparation waits the separate prior operation, then performs its own captured-source/requested-mode work or refuses after stop.
- `admit` is synchronous and precedes the coordinator callback's first marker/catalog write. Once admitted, `bind` uses the fixed selection without a post-admission liveness veto. The independent marker, catalog and history queues are not presented as a transaction. History publication occurs after its save; known prewrite failure and injected rename-then-throw retain truthful partial/ambiguous outcomes and original IDs. No new automatic fresh offer invocation/retry is introduced.
- The producer grant stamp filters to handoff.offer; generic call-gate closure/forget is not explicitly rechecked as cancellation. Quick caller untrack is sticky via auth notification; durable original-source identity can survive removal of its live runtime, with config identity/anchor verification. Cosmetic metadata and unrelated bindings have targeted controls. These controls do not justify ignoring actual changed domain grants or source identity.
- A producer's references start at1 and a launched POST obtains an additional idempotently released reference. Its final release disposes listeners and waits observations before removing the producer/completing settled. Stop/replacement guards now include producers. Existing sync POST ownership is combined with producer ownership, and actual post completion releases the extra hold independently of waiter timeout. After committed history, a retired producer's immediate `trySync` is skipped/failed conservatively while retained history remains available for later normal policy.
- Committed history still feeds existing normal notice eligibility, not an attempt-specific final-sink guarantee. This slice does not claim all legacy/local work globally drains or that generic MCP closure cancels a running call. No runtime-coordinator/ledger/provider generation or Q5 delivery guarantee is introduced.

## Independently checked packet and honest proof attribution

All61 gzip artifacts match manifest compressed/raw SHA256 values and sizes and decompress losslessly. All14 XML runs and357 actual testcase rows match exact names/classes/statuses/full failure nodes; raw guarded command START/END/exit/one-worker observations match. All selected source blobs and the archived full patch match Git. The five local-only semantic mutants are direct children of f05 in local object evidence; each published full mutated file and complete patch matches that object, and their six failures are assertions. The mutant refs themselves are not claimed as remotely published; the immutable packet preserves their bytes.

| Run | Exact source association in packet | Independently confirmed PASS/FAIL/SKIP |
|---|---|---|
|84 | e1f47fce8 |6/0/15 |
|86 | ff4ee53e1 |16/1/4 — genuine earlier consumed Ask red |
|87 | a20ba0cb2 |4/0/19 |
|88 |85b0f87b8 |3/0/22 |
|89 |e3140b4af |0/1/25 — introduced cosmetic target-window red |
|90 |f05d72834 |2/0/24 |
|93–97 | five archived mutants off f05 |0/1/25,0/2/24,0/1/25,0/1/25,0/1/25 |
|98 |a8f0d3517 |0/2/26 — invalid branch input/unsupported refusal expectations |
|99 |5e497b1a6 |0/1/27 — valid branch input, still unsupported refusal expectation |
|100 |20243bb21 |3/0/26 — corrected source/mode serial preparation and prior-read stop assertions |

The full src tree bridge from f05 to ad104 is exact, including the coupled src fixture; later desktop-fixture corrections and documentation are separate. Original98/99 failures are not security findings or relabeled successes. Their corrected expectations in100 do not establish an unseen production repair. No sum of these runs is an aggregate final-ad104 runtime pass, and the mutants do not address CP1/CP2's newly identified later windows.

Original compiler79 at eaf759 remains actual FAIL exit2/146 diagnostics;81 at365dea remains FAIL exit2/2. Successful83,85,91 and101 have zero archived TS diagnostics and actual exit0 on their own sources. **Final101 belongs ad104**. Its archived config extends unchanged root tsconfig, adds only noEmit/unchanged src include and the two complete changed fixtures; no target/lib/exclude weakening. I independently reconstructed2465 production roots plus both complete fixture roots=2467, consistent with owner readback103. Final101 does not contain a listFiles/ordered full input hash inventory; root-count/config readback is an after-execution observation, not an atomic read/executable/content seal. Source/command associations in this packet rely on owner manifest/ancestry/freeze assertions and archived patches, not an invented embedded atomic source seal. Do not retro-seal these old receipts. New successor receipts should bind actual clean source/head/tree/relevant hashes before/after admitted commands without broad repetition of unchanged proof.

Final102 ad104 scoped lint and92 f05 each have exactly8 files/0 errors/0 warnings in the actual JSON and raw exit0 logs. These are separate from historical native FAIL166 and71/247 warning dispositions; no old failure or global compiler/lint claim is transferred. The complete coupled fixture is typed, but its newly adapted mock remains a mock and is not real authority assembly acceptance.

Collector v1's incorrect failure-exit assumption and full original failure are retained; corrected packaging accepts actual exit2 and roundtrips existing artifacts without product validation reruns. Baseline source/count/type/Ask fixture corrections and the raw grant-retirement counterexample remain in the inherited baseline packet with original attributions. The caller registration and synthetic exact-call approval are isolated fixtures; public-key/member metadata and held transport are not real native TLS/bridge nonce/provider/live-human authority. Git/catalog/history are real within the fixture. No worker/apply/wake, two-host, whole-handoff/full-duplex acceptance follows.

## Required successor and retained boundaries

Resolve CP1 and CP2 together in the already cleared private seams, with genuine original-source discriminator failures and corrected narrow controls. Preserve ad104/ef992, all61 originals,86/89/98/99/type/collector failures and protected trees. A finite current/benign control must still complete; a forged false return, private state rewrite, timeout or unmatched selector is not a semantic red. No new generic framework, shared-store transaction, grant change or global gate rule is warranted.

Return the exact successor source/proof hashes, concrete changed-hunk bridges and raw admitted test/types/lint receipts for independent delta review before PR. Previously observed unchanged controls can retain their exact limited source associations; do not call them a new combined final-head result. Ordinary new-head hosted checks and final fresh main/head/clean/duplicate/landing guards remain later gates. No reviewer execution, broad local/native/lower rerun or live approval workaround is requested.
