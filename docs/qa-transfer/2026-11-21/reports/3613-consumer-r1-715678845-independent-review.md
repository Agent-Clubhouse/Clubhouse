# Independent R1 successor review: 715678845

**APPROVE — R1 resolved; scoped PR-ready from this source/evidence review.**

The original [c8b7 review and BLOCK](https://github.com/Agent-Clubhouse/Clubhouse/blob/c8b7d9b757b0bd1e44bb2119ab20e582ddf77c41/docs/qa-transfer/2026-11-21/reports/3613-consumer-41354e820-independent-review.md) remain unchanged. This successor verdict closes that finding for the bounded snapshot/icon/text consumer plus owned reverse stream increment. It does not approve full duplex or any separately deferred feature.

Reviewer `auto-reset-policy-design` did not author the host change. I used only the working existing authenticated `gh` route to inspect and publish review artifacts. No tests/compiler/lint/fixture were rerun by me, and no product code, dependencies, login, account, grants or settings were changed. Private Q5 work remains clean and unchanged at `079a257acf38b168b529fb7745dae97f686b72b8` on its original branch.

## Exact review objects

- Final executed source [`7156788458e0a391b5fdb402e427895af46ebf1c`](https://github.com/Agent-Clubhouse/Clubhouse/commit/7156788458e0a391b5fdb402e427895af46ebf1c), tree `31fefadbfcfa5bdf0705d444238cee75875ada35`.
- Pushed evidence [`0e779377f19e2c40347e983dd81ea752637a61d1`](https://github.com/Agent-Clubhouse/Clubhouse/commit/0e779377f19e2c40347e983dd81ea752637a61d1), tree `2c4f13a41473bece2f7e0c7c1a4a9ddf12e1a79e`.
- [R1 manifest](https://github.com/Agent-Clubhouse/Clubhouse/blob/0e779377f19e2c40347e983dd81ea752637a61d1/docs/evidence/3613-duplex-consumer-candidate/r1-manifest.json) SHA256 `6242cf7722a6c5a9c95f95e5e831e177c10fb7a0b0c3b24d3ebf3babb2a86e6f`; [README](https://github.com/Agent-Clubhouse/Clubhouse/blob/0e779377f19e2c40347e983dd81ea752637a61d1/docs/evidence/3613-duplex-consumer-candidate/README.md).
- Prior reviewed production `41354e82025320809b4a8bc954b7053a4f05c33e`; prior final fixture `6d7aec19dbc11489633a0a3d52629e41341c6548`; original evidence checkpoint `740aa5050fb870c971fef95a7dcb06ad785d1bae`; base `c43ffb37d20650c542e449a8a04a9fd84e65b655`.

I reviewed only the R1 delta and the necessary shared-worker dependency, new tests, lint-runner inclusion and new execution bindings. The consumer code delta from the prior final checkpoint is: client +5/-3, client tests +65, shared icon worker +2, and lint runner +1. No other production behavior was reopened or credited by a duplicate broad review.

## R1 disposition and source reasoning

The [client now receives the captured stream at each icon fetch](https://github.com/Agent-Clubhouse/Clubhouse/blob/7156788458e0a391b5fdb402e427895af46ebf1c/src/main/services/annex-client.ts#L576), refuses if it is no longer current, and chooses the reverse branch from that captured stream's transport. Currentness is checked synchronously immediately before request creation. For a reverse stream, that predicate also requires the same satellite/stream object, current trust/link epoch and no active direct stream. There is no await between this check and route selection. Thus readiness loss cannot move the queued reverse batch into the legacy direct branch, and replacement authority cannot silently inherit old queued work.

The [shared worker](https://github.com/Agent-Clubhouse/Clubhouse/blob/7156788458e0a391b5fdb402e427895af46ebf1c/src/main/services/remote-icon-fetch.ts#L118) now checks the captured snapshot before every fetch and again after the awaited fetch, before caching an image or recording a failed attempt. This prevents retired work from scheduling another read or consuming retry state. The existing publication guard remains in place. Its only production caller is the inspected Annex client; the existing worker tests exercise normal cache/retry/concurrency behavior and are included in the final six-file run.

[Retiring a stream clears its icon batch/cache reference](https://github.com/Agent-Clubhouse/Clubhouse/blob/7156788458e0a391b5fdb402e427895af46ebf1c/src/main/services/annex-client.ts#L278). A replacement receives a new state object while old promises settle against the retired state and old captured stream. This resolves the additional overlapping-replacement liveness bug, rather than merely suppressing forbidden sends. Cached offline snapshot data remains available; clearing the icon-fetch state does not clear that snapshot.

The six new cases hold the first four reads from nine missing icons, retire via stop/disconnect/forget/pin/link, and require all four aborts, original subscription close, no further reverse or direct sends and no late IPC. The replacement case reconnects and delivers the **same nine icons before the old abort promises settle**, then requires exactly nine fresh reads (13 total) and all nine icons populated, without direct HTTPS. Its synchronous setup and first await establish the intended overlap; it is not a serial retry disguised as overlap.

No concrete remaining R1 conflict was found. Common-route error/no-fallback, authority/currentness, stream sequence, direct-only observation and positive receipt boundaries inspected in c8b7 are unchanged except for the named icon ownership correction. This carries forward those bounded observations, not wider feature acceptance.

## Exact evidence credit

I independently downloaded and recomputed all **38 original/receipt blobs for 19 executed attempts**, all four archived patches and both producer archives. Each manifest digest matches; each receipt's raw SHA matches; before/after source observations and gate hashes agree; recorded head/tree/diff/minimum/exit agree with the manifest. All **19 final input blobs** were fetched by immutable source ref and matched the expanded restoration seal. The companion verification JSON preserves commands, identities and results.

- **Original defect, 33:** test-only patch on original reviewed 740 production, **5 failures / 363 selector skips**. Four retirement cases each attempted five forbidden direct HTTPS calls; pin replacement attached four extra reverse requests (8 instead of 4). These are instrumented test calls, not observed live network incidents.
- **Overlapping liveness defect, 47:** test-only strengthened overlap against intermediate 806a, **1 failure / 368 skips**, fresh work stranded at 4 instead of 13 calls. Both reconstructed test-only patches hash exactly to their original WIP diff seals; they are supplemental reconstruction, not newly claimed execution captures.
- **Final 715, 48:** six files across main/integration, maxWorkers=2, **624 passed**, exit 0. Includes the real pinned pair and existing shared-worker tests.
- **Final 715, 49/50:** production root typecheck and complete fixture typecheck, both min6, exit 0.
- **Final 715, 51:** policy lint at min4, **0 errors, 160 current versus 161 measured baseline warnings, 0 introduced diagnostics**. Runner adds the changed shared worker to the same policy check; no rule/config/dependency relaxation.
- **Final mutant, 52:** removes exactly the client currentness test and both shared-worker snapshot guards while retaining captured transport and batch retirement. **2 failures / 4 passes / 363 skips**: pin 8 instead of 4, overlapping replacement 18 instead of 13. I reconstructed the three guard removals from exact final source and matched both resulting changed file SHA256 values to the recorded mutant receipt; its preserved patch also matches the diff seal. Four passing stop-like cases are expected because the captured transport still refuses the old direct fallback. They are not falsely reported as mutant failures.
- **Restored exact 715, 53:** **6 R1 cases pass / 363 skips**, clean source before/after, expanded explicit input hashes and producer SHA. The mutant is not committed to product source.

The final real pair again records 81,937 decoded bytes with SHA256 `f7da8be077ec14d7c37a9e717948bedebdc1b9e4ec14cde538646611e18b643b`, 68 PNG bytes, exact UTF-8 text, one `/control` upgrade and no ordinary HTTP requests. Before forced network teardown it records zero owned subscriptions/inflight reads, an aborted pending read, disposed owned headless handle, no late IPC and the independent accepted control link retained. Separate fixture teardown records zero sockets and stopped listeners. These are actual final-715 observations, not transferred counts from 6039/6d7.

Attempts 36 and 40 remain genuine compiler failures (missing mock argument, then invalid mock error-code values); 37 and 41 were **not executed** and receive no credit. Earlier intermediate results, original negative results and the c8b7-era failures remain historical outcomes rather than being overwritten by final passes.

The producer through 51 omitted newly touched shared-worker/paired-fixture/runner files from its fixed list when the tree was clean. Those executions retain their actual clean immutable head/tree binding; touched WIP files were dynamically included. The expanded producer from 52 explicitly lists these inputs and records its own digest. Supplemental committed-blob checks do **not** retroactively fill the earlier receipts or establish an atomic seal absent from them. Evidence-only 0e779 is not relabeled as an executed source head.

## Scope of approval and remaining gates

This is **PR-ready source/evidence approval for the bounded consumer increment with R1 closed**. Ordinary exact-head/current-main/composition/duplicate/pushed-state checks and hosted CI still apply before publishing or landing; this review itself creates no PR or activation. No additional local run is requested by this verdict.

The fixture is two isolated desktop module contexts in one Node worker using real identity/pinned TLS/control with fixture target stores. It is not real handoff/grant/manifest/confinement, Electron/native PTY, process-tree/firewall, phone adoption, whole-app/full-duplex or release acceptance. Details sensitive reads/positive receipts, naming labels and previously deferred security/confinement work remain unchanged and separately owned. No Q5 source or runtime binding acceptance follows from this review.
