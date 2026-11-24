# Native ingress: bounded hosted fixture correction

**Independent exact successor review is pending; PR3778 remains at206.**
The original automatic Validate45046385831 attempt1 remains FAILURE
**30 SUCCESS /4 SKIPPED /3 FAILURE**, sealed at
[13703 hosted packet](https://github.com/Agent-Clubhouse/Clubhouse/blob/13703fdf4270684c83c1c24e144f6ed3c73d6e4c/docs/evidence/3613-native-handoff-ingress/hosted-run-45046385831/README.md).
All33 actual checkout witnesses match99fee0f0149e2ba0f83735aa947b52c9fef1873f,
parents70eff+206 and tree48956fa912ed4e7696451f1f802f74294f0b863c.
No failed-head rerun, manual CI dispatch or landing occurred.

| Identity | Exact source |
|---|---|
| Reviewed implementation/proof, preserved | ef5e2f53ea9c3af94e7f22e23d9f0c5432b7a596 /206a88dcc93ecd7d2f5009d533894dd77e36e2ed |
| Genuine new discriminator before correction | f7c62dd5dc731bc2060c2c30f778823279396feb, tree3ded3a7f00df6eeaad4c15c6515c3588b56fa5ee |
| Fixture-only corrected source | 60ed5f77f76029681160f298bfe789fb1d884512, treea9068e09c2618aba0f6d4bd00e0c1d6d3b00f4c0 |
| Existing combined source disposition | [7acf](https://github.com/Agent-Clubhouse/Clubhouse/blob/7acf3f1adb93b71f21986e9b2fead93c78e1a837/docs/qa-transfer/2026-11-22/reports/native-trust-ef5e2-c1-c2-review.md), reusing accepted remaining-source observations in1172 |

Only **two test files** differ from206. Production, contract, shared trust,
control/grants, all existing testcase bodies and all historical proof/fixture
trees remain unchanged.

## Actual failure and bounded corrections

The old `annex-server.test.ts` mock lacked the newly used `trustOf` export.
Both hosted unit shard2 jobs timed out with that specific unhandled rejection.
Red45 reproduces it. The mock now uses the **real export**, exactly like its
existing `withSavedRoutes` passthrough; no replacement trust policy is invented.
The original direct-route/member/phone/unpaired/refusal-detail assertions pass.

The native helper previously accepted `acceptedHere` even if it still referred
to the old accepted connection. The added deterministic discriminator holds the
actual reconnect dial while the original native TLS connection remains accepted.
After one event-loop turn, old code falsely reports completion. Red45 fails at
that exact assertion. Corrected `connect()` captures the intended target and
requester fingerprints and previous accepted epoch, then waits for a **nonzero,
different accepted epoch and target opened readiness**. Releasing the actual
dial admits a fresh native offer, with real saved history.

This establishes the helper's old-epoch defect, **not that it caused the hosted
generation-restart failure**. That hosted failure exposed no fresh-rejection
code, and no code is invented. The original generation retirement/no-record and
fresh-positive assertions are preserved and pass in Green46.

| Execution | Actual credited result |
|---|---|
| Red45, f7c source | **2 FAIL /680 SKIP**, one unhandled missing-mock rejection. The old-epoch discriminator falsely settles against unchanged epoch; direct handoff case times out. Failure-dependent downstream assertions are uncredited. |
| Green46,60ed source | **5 PASS /677 SKIP**: same two matched cases plus actual native server-generation restart, retired held-queue replacement and native current-positive. Two files, one worker, no unhandled/cleanup error. |
| Full changed-fixture types47 | **FAIL,166 diagnostics**, all in the pre-existing legacy `annex-server.test.ts` body. 3,958 ordered inputs;2,467 roots =2,465 production +two complete explicit fixtures. No entire-graph pass claim. |
| Unchanged-source types49 | **FAIL, same166 diagnostics**, isolated206 worktree, same complete roots/options/ordered graph. Full multiline diagnostic bodies are exactly equal after mapping the one inserted mock line. **Zero added diagnostics**, not a green typecheck. |
| Scoped lint48 / original legacy baseline50 | **Zero errors**. Native fixture zero warnings; legacy fixture **247 warnings**, full objects including suggestions exactly equal after mapping one line and77 UTF-16 characters. No unrelated baseline cleanup. |

The type graph uses unchanged root options/includes/excludes. No target/lib
upgrade, excluded legacy section, reduced mock graph or test typing suppression
was used. These166 diagnostics are newly measured old fixture debt, not
retroactively part of the earlier green one-native-fixture graph.

The247 legacy fixture warnings are separately measured. They are not added to
or conflated with the unchanged71 native-server warning mapping, and the earlier
whole-repository160-warning baseline remains unmeasured.

Packaging53 failed at an incorrectly specified main-directory protocol path.
Its failed source and full raw stderr are preserved. The corrected packager uses
the actual shared protocol path and existing protected-file/tree identities;
no test, compiler or linter rerun was needed for this metadata-only correction.

The machine-readable manifest binds selected real XML names/classes/statuses,
full originals, both ordered compiler graphs and content hashes, mapped complete
diagnostic/warning equality, actual source identities and unchanged production/
proof/phone boundaries. Content hashes are after-execution observations, not an
atomic compiler-read/executable/whole-host seal. The isolated original type
worktree reuses installed dependencies; no installation or original source edit.

## Exact commands

In the descendant checkout; Red45 uses the two-case selector, Green46 the
five-case selector below:

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/vitest run --project main --project integration src/main/services/annex-server.test.ts test/annex-v2/annex-native-handoff-admission.test.ts --maxWorkers=1 -t 'accepts handoff agreement synchronization only|unchanged old accepted link' --reporter=default --reporter=junit --outputFile.junit=node_modules/.cache/native-handoff-ingress/45-fixture-red-original.xml
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/vitest run --project main --project integration src/main/services/annex-server.test.ts test/annex-v2/annex-native-handoff-admission.test.ts --maxWorkers=1 -t 'accepts handoff agreement synchronization only|unchanged old accepted link|owned TLS server generation restart|original native request retired before actual queue admission|admits a current native reverse offer' --reporter=default --reporter=junit --outputFile.junit=node_modules/.cache/native-handoff-ingress/46-fixture-green-original.xml
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 6 -- node_modules/.bin/tsc --noEmit --pretty false --listFiles --project node_modules/.cache/native-handoff-ingress/hosted-correction-types.json
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/eslint src/main/services/annex-server.test.ts test/annex-v2/annex-native-handoff-admission.test.ts --format json --output-file node_modules/.cache/native-handoff-ingress/48-fixture-eslint-original.json
git show 206a88dcc93ecd7d2f5009d533894dd77e36e2ed:src/main/services/annex-server.test.ts | ~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/eslint --stdin --stdin-filename src/main/services/annex-server.test.ts --format json --output-file node_modules/.cache/native-handoff-ingress/50-original-fixture-eslint-original.json
```

Types49 runs the same gated compiler command in the isolated206 checkout with
`--project hosted-correction-types.json`; only config-relative path spelling
differs. Both complete configs and original command/logs are archived.

No broad unchanged suite, lower/synchronization proof, canonical C1 matrix or
C2 archival test was rerun. Historical35 at940, initial8 at222737 and finallegacy1
at ef5 retain their original attribution under7acf/1172; there is no aggregate
60ed pass or new acceptance of their untouched assertions.

All original failures and106 phone/test JSON fixture identities, protected
Details/Naming/Q5 and existing human/security gates remain. Native metadata/
Dispatcher/absent-runtime/fake-timer seams are not real grant/preparation/approved
MCP producer/worker/content-through-coordinator/apply/wake/provider/two-host/
full-handoff/full-duplex acceptance. No production/settings/grant/protocol or
shared-store changes, local E2E, release, extra PR or CI dispatch.
