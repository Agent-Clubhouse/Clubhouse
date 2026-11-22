# Producer fences275df: independent combined CP1/CP2 delta review

**BLOCK / CHANGES REQUESTED for one remaining CP1 context dependency.** CP2 is resolved by this exact successor. CP1's demonstrated dropped-approval-version and caller-runtime-context windows are resolved, with genuine matched red/green evidence. The new final predicate does not yet fence the local recipient project metadata captured in its resolved target map. This source-derived residual prevents combined PR readiness; it is not an executed reviewer counterexample or an observed incident.

Independent auto-reset-policy-design review, 2026-11-22, limited to the exact correction against the full [b6aa review](https://github.com/Agent-Clubhouse/Clubhouse/blob/b6aa456b1f3ea7b90d6ebfe74d36ca475fb682e3/docs/qa-transfer/2026-11-22/reports/producer-ad104-independent-review.md). No reviewer product/test/compiler/lint/CI execution, source edit or broad lower/native rereview occurred. Private Q5 remains clean at079a257acf38b168b529fb7745dae97f686b72b8/tree89e942aabd42c8ec93fe47794f2eef95b0b61980. Details/Naming and original evidence remain untouched.

## Exact successor and source bridges

| Object | Immutable identity |
|---|---|
| Original implementation / candidate | ad104a538772156af463f3750783fbf4cd99c39c / ef99265da9faddddf522c2c294745d86d593d78d |
| Successor source | `275df2b3c8e5fa81cc066d0b308edb6c59d9df61` |
| Source tree / src tree | `507f18b6f9125e2c6eccefb9dee0c054649a32f9` / `52a10102d89a86af93f6b3ef6f64ac6a2adc384f` |
| Published proof | `f1c128853165a088698a06b875cd294ebac12472`, tree `b4f1352065abf40b292fe86c638590506679b16c`, parent275df |
| Actual correction ref | `refs/heads/lane-3613-p2-routes/handoff-producer-fences=f1c128...`, gh readback matches |
| Preserved original candidate ref | `refs/heads/lane-3613-p2-routes/handoff-usable-path=ef99265...`, gh readback matches |
| Original-production red / benign fixture refinement | c2a6d24fa1b381ac23e825dc31ccd06bd061af9e /970e22dd4b99a2a3ce8654505675366067ce2d38 |

Packet: `docs/evidence/3613-real-handoff-producer/fence-correction/README.md`, SHA256 `26e0c26b22e2124869949421e0150f39ff21cca1a954a26ed7f64ce5b21a2331`; manifest SHA256 `607fbb638abd9855e523d0594d4e93bce20de240adee8931ae20e088f4ad2146`.

Full ef992→275df difference is exactly4 files/192 insertions/11 deletions: private `clubhouse-mcp/handoff-permissions.ts`, private `handoff-host.ts`, the complete producer fixture, and directly related route documentation. All four original/successor full files/blobs/sizes/hashes and complete selected/production-plus-doc/genuine-baseline/refinement patches independently match Git. Original red and benign-refinement src trees match ef992/ad104/f05 exactly; final fixture bytes equal the benign-refinement fixture. The complete archived b6 review matches the immutable published review blob exactly.

Other producer source and generic grants/registry/gates/stores, original61-archive candidate tree, baseline tree, phone fixture tree and accepted native/lower reverse/sync trees are byte/tree-identical. No historical source/execution approval is transferred from that fact.

## Disposition of the two reported races

**CP2 RESOLVED at this exact source.** `handoff-host.ts:379–391` captures both observation promise and revision at verification entry, awaits the captured promise, keeps the real source/config reads and final observation wait, and records only the captured revision. An appended revision can no longer be blessed as verified. Even if new work settles before admission, a changed revision causes conservative refusal rather than certifying old reads. There is no unbounded retry loop or new global gate cancellation. Work appended before verification can settle and complete; a refused late-benign operation leaves the next current call usable. The actual observation lifetime/disposal remains owned through settlement.

**CP1 version and caller-context subcases RESOLVED.** The real positive helper still performs full original-argument resolution/current grant evaluation/canonical recipient correspondence/exact consumed scope. On successful offer authorization, its private original agreement scope now holds a synchronous continuity predicate. `admit` invokes it after all verification awaits, immediately before setting admittedId and entering the unchanged first marker/catalog callback. The predicate checks original approval version and current caller/policy context for Ask. Missing/wrong scope cannot return success. Fresh Allow skips approval-version/caller-context dependence, as intended; current Ask and forget-only Ask retain liveness. No reconsumption, new prompt, serialized capability or extra positive authority is introduced.

**Remaining CP1-R1: resolved recipient metadata in the context is stale.** The new predicate recomputes `grantApprovalContext` using the same closed-over `targets` map produced before the later source verification. Reusing original targets protects identity from recapture, but does not prove that the original target's authority-relevant metadata is still current. The original producer owner has no effective continuity observation for a local recipient's project outside the sender source project. The requirement is to validate the original target's unchanged subject facts, not silently authorize a replacement target or rerun permission against a different recipient.

## Remaining finding

| # | Severity | File | Lines at275df | Vulnerability | Confidence |
|---|---|---|---|---|---|
| CP1-R1 | Medium | `clubhouse-mcp/handoff-permissions.ts`; `handoff-host.ts` | permissions22,30–34; host118–127,283–295,315–324,328–349,393–397 | Final context continuity closes over old resolved local recipient.projectPath; owner caches targetProject and observes sender source identity only, so a later original-recipient project change can evade the final fence and retain an old project-scoped authorization/approval. | High source-derived dependency finding; concrete isolated reproduction pending |

Necessary unchanged surrounding anchors are `tool-registry.ts:47–55` (context contains resolved target objects), `handoff-host.ts:57–73` (local recipient lookup derives its current registered project), and `shared/agent-grants.ts:213–226` (project-target grants materially depend on target.projectPath). This is not a cosmetic field. `peerTarget` includes the local recipient's current projectPath in the actual positive target. The changed final predicate's cached Map cannot notice that field later changing because it supplies the same old object to every context recomputation.

Finite counter-schedule, not an executed result in this packet:

1. Sender is in registered projectA, intended local recipient ID is in an already registered different projectB. Required connection and cross-project setting are valid. Standing handoff.offer policy and consumed same-call Ask context cover the original recipient/projectB (or a standing Allow is specifically scoped toB).
2. The actual queued positive helper resolves recipient/projectB, validates the original canonical recipient ID and returns approved. Hold the real subsequent source verification await, as in the new fixture helper.
3. Move that same recipient ID's registered project fromB to an existing projectC, preserving sender/sourceA, connection, original arguments, standing policy and handoff host. Keep it uniquely resolvable, avoiding ambiguous duplicate config rows. The old project directory can remain on disk.
4. A fresh original-recipient target resolution would now produce projectPathC and a different Ask context, or fail the old project-scoped grant. But `offerCurrent` recomputes context with cached projectPathB. For fresh Allow it short-circuits context altogether. The owner target stamp uses cached targetProjectB/cross-project Boolean, and its config callback ignores projects other than sourceA. Its projects callback only verifies sender source membership; the move can use existing project rows without changing the project list.
5. On source verification release, original sourceA and directory/selection/host checks still pass, so final admission can bind/history-commit using the old project scope. The generic MCP gate is irrelevant to this schedule.

The existing canonical recipient-ID comparison is valuable but does not distinguish this project-context change. Conversely, simply re-resolving and granting a new recipient would violate original-target binding and is not the correction.

**Required correction:** carry a race-free continuity witness for the original local recipient's authority-relevant project/identity facts through final admission. Capture/validate the actual facts used by the positive target and observe relevant config/registration/project changes; any asynchronous observation must use the corrected CP2 stable-revision rule. The final check must refer to the same original recipient, not recapture a new alias, mint a new grant or consume another approval. Cover project-scoped standing Allow as well as consumed Ask, while retaining fresh Allow's freedom from approval-version/cosmetic caller-runtime dependence. No generic registry/grant-store/gate or new shared framework is needed. The owner may choose the narrow private interface/order; disclose the exact successor hunks and assumptions.

**Required finite proof:** genuine275df red using real project/config/target resolution, isolated project-scoped grant/consumed approval and the actual held post-positive verification callback; move recipientB→C while senderA and its domain state stay current; confirm before release that fresh target metadata/project scope is different. The original call must refuse before marker/catalog binding/history/federation publication/new POST. Corrected green plus unchanged recipient, unrelated/benign target metadata and Ask/standing-Allow controls should preserve liveness. Retain the exact original/result/phase receipts. This is a narrow residual of CP1's all-context-dependencies requirement, not a request for worker/provider/native/full-duplex expansion or another broad proof matrix.

## Actual red/green controls inspected

All three XMLs,111 complete rows and22 failure nodes were independently parsed with full attributes, names, classes, status, skipped entries and failure texts. Nodes are not testcase counts.

| Run | Actual source and counts | Credit |
|---|---|---|
|111 | c2a6d24fa,4PASS/4FAIL/29SKIP | Original-production CP1 approval/version and caller-runtime-context reds plus CP2 pending incompatible and pending-benign reds;22 AssertionError nodes across4 failed testcases. |
|112 |970e22dd4,1PASS/36SKIP | Refined stable benign observation appended before verification begins; separate fixture revision. |
|113 | exact275df,8PASS/29SKIP | Four matched corrections plus current Ask, fresh Allow with changed approval/context, forget-only Ask and stable benign liveness. |

The CP1 callback spy invokes the actual positive helper and forwards its result; it then holds the actual caller source callback after that helper completed. It does not substitute false authorization. In the failed red cases the remote fixture observes actual marker/binding/history/publication/POST effects with seven soft assertion nodes each; those are genuine original-source discriminator failures. Successor negative controls assert all those effects absent, while current/Allow/forget-only controls actually bind, publish and attempt the fixture transport.

CP2 dispatches fixture notification input to the real registered onAgentConfigChanged callback, holds its actual async config lookup, forwards original `check` while counting visits through the hold, and subsequently writes incompatible or benign config to actual fixture agents.json before release. It does not mutate private revisions/counters. The successor conservatively refuses both late pending revisions; the pending-benign control additionally proves a fresh call works after settlement. The separate settled-benign timing refinement112 differs from111 and is not relabeled as an unchanged execution.

These controls resolve exactly their demonstrated inputs. They do not test the residual recipient project dependency: current CP1 cases use a remote Dispatcher target without a local recipient projectPath, and change caller runtime/version or generic caller bookkeeping, not the original local recipient's project.

## New receipts, compiler/lint and archive checks

All43 gzip archives match committed compressed/raw SHA256 values, lengths and lossless roundtrips. The five111–115 command pairs have the expected exact source heads/trees/src trees, clean statuses and matching15 relevant hashes before/after. Thirteen paths are tracked source/config/doc files verified to the corresponding immutable Git trees; two are local cached config/receipt-script byte observations, whose computed Git blob hashes are not claimed to be committed source entries. Raw gate START/END/exits match each archived command and standalone exit file. These are meaningful new observations; they are not an exclusive filesystem lock or atomic full-dependency/executable seal.

114 at exact275df is actual exit0/zero diagnostics with3958 ordered raw listFiles entries. The complete after-execution inventory order matches that output. I independently verify2470 tracked input contents against the frozen source Git tree;1488 dependency hashes remain owner-observed after execution. Both complete changed fixtures are present, with2465 reconstructed production roots plus2 complete additional fixture roots=2467. Archived config equals the original unweakened config, adding no lib/target/exclusion or reduced-graph substitution. No full-input hash inventory is retroactively attributed to101. Final115 actual JSON is exactly3 files/0 errors/0 warnings; it is a delta lint result, not whole-repository lint.

The original full b6 review archive matches its published blob. All4 source rows and archived patches/whole fixture versions match immutable Git, including original-production red tree equality and benign fixture refinement. Original candidate61 artifacts, original compiler failures146/2, prior86/89 reds,98/99 corrected expectations, original101 limitations and native166FAIL/71/247-warning attribution remain unchanged. There is no aggregate37-case runtime pass at275df and no transfer of previous source-specific runtime counts.

The companion `producer-fences-275df-independent-verification.json` and `producer-fences-275df-verifier.py` preserve the independent comparisons. Read-only report verification is not a new product test. Synthetic caller registration, exact-call approval input, delivered notification input and remote connectivity/member/public-key metadata remain declared fixture boundaries; no native TLS/bridge nonce/provider/live-human or filesystem-watcher integration is established. Existing actual producer/POST ownership, admitted independent-save truth and general-MCP running-call policy are unchanged by these two source hunks and retain the prior limited observations, subject to the residual admission blocker.

## Next bounded step

Keep original275df/f1c128 and all old reports/raw receipts frozen. Resolve CP1-R1 within the existing private recipient/call-continuity seam, capture its genuine red/green and current/benign scope controls with new exact pre/post source receipts, and return one frozen successor for exact-delta review before PR. Do not recapture permission for a replacement target or infer cross-store rollback. CP2 and the demonstrated version/caller-runtime subcase closures need not be re-proved broadly if their exact code/evidence remains unchanged and the successor bridge is explicit.

No reviewer execution or broad original/lower/native rerun is requested. Ordinary fresh composition/actual-main/head/clean/pushed/duplicate guards, one coherent PR and automatic hosted checks remain later requirements. No product, whole-handoff/full-duplex, worker/apply/wake, provider/runtime/Q5, UI/Details/Naming, grant, release or installation acceptance is implied.
