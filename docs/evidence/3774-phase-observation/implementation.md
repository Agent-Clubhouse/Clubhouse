# #3774 observation-only fixture implementation and proof

**Source candidate:** `7d816673ec91e3588c190e4900cebbb3cd4d87c6`, tree `f634dc9d32b9a1b9d426318ad3dbf326c9c75b1d`. Independent exact implementation/bridge review is pending; #3774 remains on `e566`. No CI observation, timeout fix, Windows-cause or flake claim is made.

Read in full: corrected design approval [b1a04e3ba0c6b191ad62ea85acfbd9736bab4f45](https://github.com/Agent-Clubhouse/Clubhouse/blob/b1a04e3ba0c6b191ad62ea85acfbd9736bab4f45/docs/qa-transfer/2026-11-21/reports/3774-phase-design-66a8590a1-independent-review.md), binding [66a design](https://github.com/Agent-Clubhouse/Clubhouse/blob/66a8590a1f571930d5478fad3c5c01c3bb1cd711/docs/evidence/3774-phase-observation/design.md). Original [8a/4c BLOCK](https://github.com/Agent-Clubhouse/Clubhouse/blob/4c886ba9d6993c250d39d20add8d3cf735071267/docs/qa-transfer/2026-11-21/reports/3774-phase-design-8a26721bb-independent-review.md), failed [44981401024](https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44981401024), forensic [1df](https://github.com/Agent-Clubhouse/Clubhouse/blob/1df05ad1aa681ca0253d8898f93369d986f4858e/docs/evidence/3774-managed-delivery-blocker/README.md) and #3714 approval592 remain separate and unchanged.

## Scope

The only non-documentation delta from e566 is `delivery.test.ts`: one existing #3517 case's phase recorder/native-only Proxy/hooks, plus three erased type annotations needed to compile the entire existing fixture strictly. No production/service/grant/assertion/phone/workflow/test-runner-config/deadline change. The fixture's real synchronous Git and callback-based tracking query still run with their original options, results and cleanup. There are no shipped proof triggers or new test cases.

The recorder emits early raw markers and one prepared final string via `console.error`; a returning call is `console.emitted`, never durable acknowledgement. Original-record closures, owned detach/reference release, frozen late-write suppression, bounded raw/history/active/child retention and explicit unavailable evidence are fixture-local. Native execution remains outside observation containment. No private runner mutation, annotation, extra application await, timer or callback replacement.

## Original commands and outcomes

Each `attempts/NN-*-receipt.json` records the complete gate command, minimum, before/after source/tree/diff/input hashes, installed dependencies, actual Node/platform, original output hash and exit. Gate path is explicitly rendered with a home alias. All seven runs were admitted and inputs stayed stable; no new refusal/retry was needed.

| Attempt | Head / minimum | Outcome |
| --- | --- | --- |
| 01 fixture observation | d333 / 4 | Existing full fixture: **68 PASS**, zero skips; actual JUnit final packet equals raw, 20 transitions. |
| 02 disposable controls | d333 + archived patch / 4 | **6 PASS, 2 intentional primary FAIL, 67 SKIP**. Original setup error and unchanged 5000 ms timeout preserved; **11 actual JUnit packets**, paired raw equality/allowlist/bounds validator PASS. |
| 03 missing-console mutant | d333 + archived mutant / 4 | **5 PASS, 3 FAIL, 67 SKIP**; same two primary errors plus publication-dependent failure, **zero JUnit diagnostic packets**, validator rejected. Raw-only evidence cannot pass. |
| 04 restored strict fixture types | d333 / 6 | Original FAIL: five empty-array inference errors at unchanged fixture locations. |
| 05 exact e566 fixture types | d333 + baseline restoration / 6 | Same five FAILs on byte-identical original fixture, same strict compiler config (441/611/734 versus candidate650/820/948). |
| 06 typed fixture bridge | 7d816 / 6 | **PASS**: inherited production graph plus actual complete changed fixture; no relaxed flags. TypeScript-emitted executable JS equals d333 byte-for-byte, SHA256 `0dbc5dfd19f59e26ad42bfbebfa505d519cccb259884b31f1e7e93550d920cc9`. |
| 07 exact fixture + lint | 7d816 / 4 | **68 PASS**, zero skips; scoped eslint **0 errors/0 warnings**; final raw/JUnit packet validator PASS on exact typed head. |

06 runs `npx tsc --noEmit -p docs/evidence/3774-phase-observation/fixture-tsconfig.json && node docs/evidence/3774-phase-observation/emission-bridge.cjs`. 07 runs the existing single-fixture Vitest with `--maxWorkers=2 --reporter=default --reporter=junit`, then scoped eslint sequentially inside the same min4 gate. No full suite or E2E.

## Decisive controlled observations and source bridge

`02-disposable-controls.patch` reconstructs the exact dirty d333 proof input; it is not shipped. Real native forwarding instrumentation records actual `Reflect.apply` invocations, without synthesizing Git/tracking. Controls verify same arguments/options/callback/this/native child, native own descriptors, exactly one invocation/callback, a real synchronous native error preserved by identity, and real grant-provider stop still called. A contained cleanup-begin fault in the original case preserves all original assertions and exactly one original stop. Writer/serialization failures remain unavailable diagnostic evidence, not application success substitutes.

The setup control fails in the actual beforeEach hook; body never starts and original error survives. The pending `proof.await` control is released by the existing Vitest abort signal at the unchanged deadline, with no new timer. Its separately retained abort snapshot shows body/pending scopes unfinished for 5002.699 ms; the final snapshot honestly reflects subsequent completion. Raw and JUnit contain identical records.

Retired/fresh record controls use a real Node ChildProcess instance as an **observer-event controller**, not as Git-execution proof. A captured retired callback/end/finalize cannot emit or adopt fresh ownership; unrelated close listener survives, only owned abort/close listeners detach, and fresh closure completes independently. Forty begin/end pairs retain and emit exactly32 transitions with48 explicit drops. Strict packet-key/finite-number validation and <16KiB packet checks pass. Serialization failure emits only the fixed unavailable envelope.

Controls executed on d333; the final7d816 source differs only in three type annotations outside those observer/target hunks. 06 proves emitted-JS equality, and 07 independently executes the final full fixture. Do not claim controls ran on7d816, exhaustive runtime sealing or compiler equality across different transpilers. This bridge is explicitly submitted for independent review.

## Limits and preserved evidence

All new execution is **macOS/darwin, Node24.22.1, Vitest4.1.12**, not the original Windows/Node22.23.4 execution. Phase intervals include observer overhead and scheduling; console-emission duration is not artifact acknowledgement. Source/action evidence does not establish prior Windows cause, a flake, a fix, whole-duplex/current-app/phone/security closure or landing authority.

Supporting raw logs, XML, FAILs, receipts and patches are retained without normalization. Archived unified-patch blank context lines are intentional bytes, not authored-code whitespace defects. The manifest hashes every retained artifact; source/doc whitespace checks exclude raw archives. Only after independent exact source/evidence approval may the same #3774 get one ordinary automatic new-head CI observation.
