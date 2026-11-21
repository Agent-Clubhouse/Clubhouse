# PR #3748: live binding summary test mount boundary

Scope: the Windows unit failure from run `44867358806`, job `136733974159`, at frozen Annex head `ade92c0099f3a398e3e97b0003da825360eaefb6`. Work is separate on `annex-wake-readiness/3748-binding-ci`; the approved Annex branch/ref is unchanged pending independent review. No product or binding-manager code is changed.

## Exact hosted evidence and existing-main comparison

The current job's raw log and JUnit artifact `14693135135` both identify `AgentGrantsSettings.test.tsx:90`, “updates the connection count when the live bindings change (#3275)”. It expected one outgoing connection and observed zero. The suite had 14 cases and one failure. `evidence/3748-binding-ci/current-unit-1.zip` is the exact downloaded artifact; `current-job-log.txt.gz` is a lossless gzip of the exact job log. `failure-manifest.json` records their hashes and original artifact/run identities. XML excerpts are explicitly labeled derivatives; the ZIP originals are unmodified.

Before local probing, the existing Windows artifact `14687822914` from main `69ef383` / run `44853735230` was read. That artifact has 14/14 passing cases for this suite, including the target. The original test, summary component and store match main. This comparison establishes an existing passing observation, not a waiver or proof of an unrelated/flaky failure. The failed current run remains red.

## Source and controlled discriminators

`AgentGrantsSettings` loads grants/tools through a Promise and then mounts `AgentConnectionSummary`. The summary reads `useMcpBindingStore` through Zustand's `useSyncExternalStore` hook and directly counts outgoing agent bindings. No binding fetch runs on this component's mount. The original test waited for DOM presence with `findByTestId`, then used synchronous `act` to update the store and immediately asserted the retained node's text.

Two bounded probes distinguish possible causes:

1. A prequeued external-store update and the full 14-case file order did **not** reproduce the failure. The store had one binding and the same attached/fresh DOM node already showed one, before and after an async React drain (`prequeued-probe.txt`). This does not support a stale-node or simple queued-update explanation.
2. A controlled mount-boundary probe returned from the DOM query without Testing Library's incidental additional timer drain. It reproduced the exact zero/one assertion discrepancy: the store already held the new binding, the retained node was attached and identical to a fresh query, yet its text still showed zero. An async React drain changed that same node to one without changing the store (`mount-flush-red.txt`). Awaiting the initial asynchronous mount made the same controlled case pass (`mount-flush-green.txt`). The red/green patches apply to the frozen `ade92c009` test in isolated checkouts.

This establishes a deterministic test await defect: DOM appearance is an insufficient boundary for this test's requirement that the newly mounted external-store subscription be settled. It does **not** supply a direct trace of Windows' internal scheduler or prove the hosted store value at the failing instant; that artifact records only the DOM assertion. The model and this limitation are explicit.

## Narrow correction

The target test now awaits `act(async () => { render(...) })` to finish the asynchronous grants mount, then uses synchronous `getByTestId`. The actual binding-store update remains synchronous `act`, and both immediate text assertions remain unchanged. There is no retry, `waitFor`, sleep, timeout increase, assertion relaxation, production behavior change or #3738 binding-manager hunk.

For the controlled reproduction, apply `evidence/3748-binding-ci/mount-flush-red.patch` to an isolated `ade92c009` checkout and run the target case. It fails while printing the store/attached-node observations. The green patch includes the same diagnostic control plus the awaited initial mount and passes. Probe outputs/patches are preserved as observed task artifacts, not retrospectively labeled as sealed-head executions.

The separate candidate's fresh validation manifest records its actual code HEAD, commands, timestamps, exit codes and raw output hashes. Evidence-only commits must be distinguished from the head at which checks ran. The old Annex receipts and all original hosted failures remain preserved; no old run is rerun or waived. Independent QA must review this test-only correction before the PR branch advances. Current-head hosted checks remain required before landing.
