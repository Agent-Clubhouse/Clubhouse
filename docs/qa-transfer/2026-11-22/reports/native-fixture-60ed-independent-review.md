# Native ingress hosted fixture correction: independent source/evidence disposition

**APPROVE — scoped readiness for one same-PR new-head update and ordinary automatic hosted checks.** No concrete blocker was found in the two-fixture correction. This is not a landing verdict, a compiler PASS, a hosted reconnect-cause finding, or broader production/handoff acceptance.

Reviewed independently by auto-reset-policy-design on 2026-11-22. This review performs source, Git/blob, archive, XML, diagnostic, graph and warning comparisons only. No product/test/compiler/lint/CI execution or source edit was performed by the reviewer. Private Q5 workspace remains clean at `079a257acf38b168b529fb7745dae97f686b72b8`, tree `89e942aabd42c8ec93fe47794f2eef95b0b61980`; Details/Naming work is untouched.

## Exact identities and permitted scope

| Object | Immutable identity |
|---|---|
| Previously reviewed implementation/evidence | `ef5e2f53ea9c3af94e7f22e23d9f0c5432b7a596` / `206a88dcc93ecd7d2f5009d533894dd77e36e2ed` |
| Genuine discriminator with original helper/mock | `f7c62dd5dc731bc2060c2c30f778823279396feb`, tree `3ded3a7f00df6eeaad4c15c6515c3588b56fa5ee` |
| Corrected fixture source | `60ed5f77f76029681160f298bfe789fb1d884512`, tree `a9068e09c2618aba0f6d4bd00e0c1d6d3b00f4c0` |
| Published packet | `e83d9f27f0e6a85f3a2791b1eadb85995c6ae701`, tree `42ab44d9d911f8d370cba393aff0c442f165472c` |
| Published branch readback | `lane-3613-p2-routes/native-ingress-fixture-review` at exact e83d9f27 |
| Prior combined production approval, unchanged scope | [7acf C1/C2 review](https://github.com/Agent-Clubhouse/Clubhouse/blob/7acf3f1adb93b71f21986e9b2fead93c78e1a837/docs/qa-transfer/2026-11-22/reports/native-trust-ef5e2-c1-c2-review.md), retaining accepted remaining-source observations in 1172 |

The full source diff from206 contains exactly `src/main/services/annex-server.test.ts` and `test/annex-v2/annex-native-handoff-admission.test.ts`, 38 insertions and2 deletions. Proof e83 adds only its evidence directory. GitHub gh readback independently matches source/proof trees and remote branch. All23 listed protected production/config/fixture/proof identities equal206 and60ed/e83, including the original canonical-trust correction and all four native ingress production files. No production change is approved by this fixture review.

Packet: `docs/evidence/3613-native-handoff-ingress/hosted-fixture-correction/README.md` SHA256 `418b186fd5d1e68882616b1a01ffe8d72406f2613e02cdf68ceb26bdb25aa336`; manifest SHA256 `d0544357339c010c0238a57e5e938888ef1352a118fdb22ba2aafe138d3d003f`.

## Fixture correction and executed discriminator

The single mock line at annex-server.test.ts279 exports the actual existing `annex-peers.trustOf` via `importOriginal`, following its existing real `withSavedRoutes` pattern. The real function at annex-peers.ts314–319 is a pure projection of saved canonical trust fields. It introduces no replacement grant/trust policy, live probe or production fallback. Removing that one exact line reconstructs the old fixture bytes.

The native `connect()` helper at lines115–130 captures the intended target/requester fingerprints and previous accepted epoch before the actual dial. It waits for a nonzero different requester accepted epoch, accepted request readiness for that original target, and opened request readiness at the original destination/requester. `getAcceptedLinkEpoch` returns the accepted request-ready incoming link's epoch or0; readiness is not treated as new authority. This corrects a helper that could previously see the still-accepted old link immediately after initiating a reconnect. Existing negative outbound-readiness assertions and helper timeout remain unchanged. It does not recapture the destination after waiting or weaken production fences.

The new case at190–216 holds the actual target `connectTo` call without dropping the existing accepted link. It observes the unchanged nonzero original epoch and asserts the helper has not settled after an event-loop turn. It then releases the captured dial, requires helper fulfillment and a changed epoch, and verifies a fresh native offer's200 response and exact saved history. Extracted `connectTo` is an exported module function without a `this` dependency. The returned `pair.own` promise records outcome rather than throwing unhandled rejection, and final cleanup releases a held dial, waits owned work, closes native transports/stores and restores spies. All original testcase bodies from the first existing native case onward are byte-identical. Red/green discriminator bodies are also byte-identical: their difference is the helper/mock being tested.

| Actual archived execution | Independent verification |
|---|---|
|45 at f7c original helper/mock | Exit1, **2 FAIL /680 SKIP**, plus the actual unhandled missing-`trustOf` mock rejection. The new discriminator fails `settled` true versus required false against the unchanged old epoch; the legacy pinned-member case times out5000ms. Assertions after either failed assertion are not credited. |
|46 at60ed | Exit0, **5 PASS /677 SKIP**, no archived unhandled/cleanup error: same reconnect discriminator and pinned-member case, plus current native offer, retired held-queue request with new-link liveness, and owned server-generation restart. Both files included, one worker. |

Both raw logs contain actual guarded START/END and exits; source/tree witnesses and complete archived patches equal Git exactly. All1364 XML rows, selected names/classes/statuses/failure bodies, raw XML hashes and derived archive rows were rederived independently, not inferred from summary counts. No broader suite or aggregate final60ed acceptance is claimed.

This proves the old helper defect and missing mock export. It **does not establish that old-epoch completion caused the hosted generation-restart failure**. The hosted fresh-positive rejection code and root cause remain unknown. The original failure at run45046385831 (30success/4skip/3fail) and immutable13703 packet remain unchanged; no failed-head rerun or speculative flake/incident assertion is credited.

## Explicit new compiler-failure disposition

**Both actual complete changed-fixture typechecks FAIL with166 diagnostics, exit2. Accept only exact nonregression for this bounded fixture update; do not label either PASS.** This is a new independently measured comparison, not a transfer from prior native-only successful typing or earlier unrelated FAIL139/FAIL54/FAIL1 dispositions.

I independently extracted the entire ordered multiline diagnostic section from47 final60ed and49 isolated original206 logs. All166 diagnostic headers reference the legacy annex-server fixture, with identical code, column, full multiline body and multiplicity after mapping the one inserted mock line (279) back by one line. Every corresponding diagnosed source line is byte-identical and none is the inserted line. The normalized full diagnostic section SHA256 is `1d0401c51bb132be3695259275345df6dc7987a3a4ca1d92703727ad908947e5`. There are zero added diagnostics in this actual comparison; no diagnostic in the changed native helper/new case or other file is omitted.

Both archived actual configs only extend the unchanged root config and explicitly add the **two complete fixtures**. No reduced mock graph, target/lib upgrade, suppression or excluded legacy section is substituted. Effective options, includes/excludes and complete roots match after checkout-relative path normalization. Both actual raw listFiles graphs contain3958 ordered inputs and2467 roots (2465 production roots plus the2 explicit complete fixtures). I independently checked their ordered names against the archived metadata and all2470 tracked content hashes against the respective immutable Git trees. All3956 other input records, including1488 dependency hash records, match exactly. Both complete fixtures are in roots and actual input lists. Root reconstruction accounts for TypeScript selecting the same-stem declaration `index.d.mts` over `index.mjs`; no unexplained root was filtered.

Content hashes and parsed effective-graph observations were collected after execution by the owner. They are not atomic compiler-read, executable or whole-host seals; the review does not convert them into those guarantees. Original dependencies were reused without an install. The prior production/root evidence and production-source approval remain separately attributed, not rerun here.

## Lint and packaging disposition

Actual48 final two-fixture lint and50 original legacy stdin lint both exit0 with zero errors. Native fixture has zero warnings. The legacy fixture has247 warnings; independently compare the **entire ordered warning objects**, including messages, columns, suggestions and nested fix ranges, with279+one line and77 UTF-16 characters mapped back. Every corresponding warning source line is unchanged. Normalized ordered warning-object SHA256 is `d24c00a902b5ebf749d7ee4d6a82a961e8b3123e8eb9e31a736ad2e9cc5a99aa`. These247 baseline-matched test warnings are separate from the unchanged71 native production-server warnings in the prior review; whole-repository160-warning baseline remains unmeasured.

All31 committed gzip artifacts have exact manifest blob paths, stored/raw sizes and SHA256 hashes, and decompress losslessly. Both configs, original exit files, collector/derivation scripts and source patches are preserved. Packaging53 genuinely failed on a nonexistent main-directory protocol path; its original failed source and stderr remain. The final metadata-only correction references the actual shared protocol file; no product/test/compiler/lint execution was rerun for packaging, and no historical artifact was retroactively replaced.

The companion `native-fixture-60ed-independent-verification.json` records exact per-diagnostic mapping, full selected XML records, graph/hash/count comparison and archive/protected-boundary results. `native-fixture-60ed-verifier.py` records the independent read-only derivation. These are review artifacts, not new product-test results.

## Remaining gates and recommendation

**No correction finding remains.** Carry these two fixture changes on the same coherent PR after ordinary fresh actual-main/head/clean/pushed/duplicate/composition guards and obtain the ordinary automatic new-head hosted result. The new hosted run is still needed; local five-case results do not prove full-matrix success or explain the historical Ubuntu fresh-positive rejection. No blind rerun/manual CI dispatch, extra standalone full-matrix proof PR or repeated unchanged production review is recommended.

The prior7acf/1172 production approval and its exact unchanged source/queue/postauthorization/actual-owner/nativeRPC cancel-versus-deadline limits are retained by byte identity. The fixtures still combine real TLS/control/native authorization/history with fixture metadata/Dispatcher/absent-runtime inputs and other declared synthetic seams. No grant/preparation/approved producer/worker/content-through-coordinator/apply/wake/provider/two-host/full-handoff/full-duplex, lifecycle/Q5, renderer/Details/Naming, live settings, release or install acceptance is added.
