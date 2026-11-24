# Native reverse handoff admission: frozen candidate

**Independent exact implementation/proof review is pending. No PR, CI or product
handoff acceptance is claimed by this packet.**

| Identity | Exact reference |
|---|---|
| Actual baseline production | `70eff94e9042ccc304e68282e76afc9065497858` |
| Genuine baseline fixture/originals | `c06ba470326b72b41568950e6e6e44f8b690e9bf` |
| Candidate source/tests/contract | `940365ecde7ca2e9fb31abf48362a938445e1fe5` |
| Candidate source tree | `b3fb94c3b7bf94bb30a934d4d39b42a8850500aa` |
| Approved design, not source acceptance | `3e06e4f4e6a3c7ce9bc290a889fc06a02bd46dac` |
| Fully read design report blob | `cc7b465f4ae08f90d24c3b28c8795becadd4f16e` |

The source commit has exactly four production files: `annex-server.ts`,
`handoff-host.ts`, `handoff-coordinator.ts` and `handoff-service.ts`. It adds the
original inbound reverse request/principal/server/trust guard to actual incoming
queue and postauthorization decisions, and owns actual incoming domain work
through queue waits, saves and normal committed-history callbacks. Existing
direct/local behavior, outgoing sync/POST lifetime, protocol, grants, shared stores,
worker and phone fields remain unchanged.

The machine-readable [manifest](manifest.json) binds source Git blobs, raw and
compressed originals, actual compiler inputs, exact warning source mapping,
fixture identities, counterfactual source patches and all selected/skipped test
names. Hashes collected after execution are explicitly after-execution
observations, not invented before-execution witnesses.

## Observed results

| Run | Actual scope and result |
|---|---|
| Old-host baseline03 | 3 PASS / 2 FAIL on unchanged production: retired queued offer still committed; normal stop allowed replacement while an admitted save was held. |
| Candidate14 | 35 PASS / 75 SKIP, four files, one worker; no unhandled/cleanup error. |
| Native assembly | 13 cases: actual TLS/native router/control dispatch, real authorization implementation, actual history/command stores and held queue/save. |
| Private service/coordinator/host | 8 / 8 / 6 cases respectively; policy/identity/runtime fixture seams are not native permission evidence. |
| Types13 | Zero diagnostics; 3,960 actual compiler inputs, 2,469 roots, all four changed test inputs included. |
| Lint12 / original-server11 | Eight files, zero errors; 71 native-server warnings exactly equal by rule/message/columns and mapped original source lines. Whole-repository 160-warning baseline remains unmeasured. |
| Queue guard mutant15 | 3 FAIL / 1 PASS / 27 SKIP; removing only the three new queued service guards breaks existing-offer, terminal-cancelled-offer and cancellation admission. Retained-history positive control passes. |
| Postauthorization mutant16 | 4 FAIL / 1 PASS / 39 SKIP; removing only the two final guards breaks offer/cancelled-offer retirement on both allowed and typed-refusal branches. Actual native current-positive control passes. |

The two mutants ran in separate exact-source detached checkouts, with dependencies
reused and one worker each. Their patches and mutated source identities are frozen;
the candidate source was not mutated. Failure-dependent downstream assertions
are uncredited.

Original01/02 baseline setup failures used an incorrect authorizer-result witness;
their preserved failures, including original01's cleanup warning, are not boundary
proof. Candidate05 had five incorrect host hold/error witnesses: the hold caught
recovery rather than the actual receiver lookup, and an assertion used the wrong
error text. Corrected06 passes all five cases. Original08's three explicit callback
type errors and original10's four integration synchronous-read lint errors remain
preserved. Refusal04 was a resource-gate refusal, not a test run.

Packaging17 failed at an incorrect main-directory protocol path. The failed
collector source and accurate error attribution are preserved; its raw tool
stderr remains in conversation, not a falsely labelled raw artifact. The
corrected collector succeeded without any test/compiler rerun.

## Commands

Executed in the descendant `3613-p7w-remaining-consumers-work` checkout:

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/vitest run --project main --project integration src/main/services/handoff-host.test.ts src/main/services/handoff-coordinator.test.ts src/main/services/handoff-service.test.ts test/annex-v2/annex-native-handoff-admission.test.ts --maxWorkers=1 -t 'native incoming' --reporter=default --reporter=junit --outputFile.junit=node_modules/.cache/native-handoff-ingress/14-native-final-original.xml
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 6 -- node_modules/.bin/tsc --noEmit --pretty false --listFiles --project node_modules/.cache/native-handoff-ingress/changed-fixture-types.json
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/eslint src/main/services/annex-server.ts src/main/services/handoff-host.ts src/main/services/handoff-coordinator.ts src/main/services/handoff-service.ts src/main/services/handoff-host.test.ts src/main/services/handoff-coordinator.test.ts src/main/services/handoff-service.test.ts test/annex-v2/annex-native-handoff-admission.test.ts --format json --output-file node_modules/.cache/native-handoff-ingress/12-eslint-original.json
git show 70eff94e9042ccc304e68282e76afc9065497858:src/main/services/annex-server.ts | ~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/eslint --stdin --stdin-filename src/main/services/annex-server.ts --format json --output-file node_modules/.cache/native-handoff-ingress/11-server-baseline-eslint-original.json
```

In the **queue mutant** checkout:

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/vitest run --project main src/main/services/handoff-service.test.ts --maxWorkers=1 -t 'native incoming.*(checks inside the actual held queue|retains known history)' --reporter=default --reporter=junit --outputFile.junit=node_modules/.cache/native-handoff-ingress/15-queue-mutant-original.xml
```

In the **postauthorization mutant** checkout:

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/vitest run --project main --project integration src/main/services/handoff-service.test.ts test/annex-v2/annex-native-handoff-admission.test.ts --maxWorkers=1 -t 'native incoming.*(checks original retirement after held|admits a current native reverse offer)' --reporter=default --reporter=junit --outputFile.junit=node_modules/.cache/native-handoff-ingress/16-postauth-mutant-original.xml
```

## Boundary and acceptance limits

The native fixture uses a receiver-opened pinned link and explicitly sends the
request through the existing control primitive. Neither desktop client runs;
receiver outbound readiness is false. The real authorizer witness returns its
unchanged result. Dispatcher availability and absent runtime are fixture inputs.
Offers are synthetic metadata, not an approved MCP producer/preparation/grant
execution. Synchronous terminal ACK/cancel controls prove branch admission using
a synthetic guard transition, not a real TLS race.

Cancellation and deadline are distinct: actual cancellation may retain a completed
admitted result for same-key replay; deadline destroys the response, keeps actual
slot/host work owned, and yields an unretained late answer and unavailable replay.
Same-key retry does not re-execute; conflicting digest gets the existing 409.
Cache lifecycle/caps remain unchanged. Native deadline and the mixed outgoing
lifetime case use fake timeout timers, not fabricated queue/save completion.

Retirement before queued/postauthorization admission refuses the incoming
decision. Retirement after admission may finish the real save with matching
committed memory and normal retained-history notices. Two actual IO fault points
distinguish pre-rename from after-real-rename disk/cache ambiguity; neither is
reported as rollback or successful adoption. Expiry/prune remain separately
admitted local maintenance, not a global zero-write promise.

The initially suspected outgoing-owner conflict was an undelivered source-only
finding, subsequently corrected by reading the unchanged accepted source/tests.
Retired outgoing sync ownership intentionally ends before its remaining network
POST/authority-listener lifetime: that late result cannot write/adopt locally.
New mixed-case07/14 proves the incoming writer still blocks stop/replacement,
then unrelated eligible replacement work remains usable and the old POST cannot
adopt its late reply. No owner-class edit or unchanged accepted-case rerun occurred.

All 106 test fixture JSON files / 1,547,788 bytes match base Git blobs, including
103 canonical mobile files / 1,529,625 bytes. The manifest also checks 59 protected
inputs and 87 unchanged lower/synchronization proof files. Accepted source/proof
`a4074c7` / `be01f8b`, review `74d2ed4`, and source `9a5247c`, review `6f15b83`
are reused by identity, not rerun. The earlier 81,937 bytes remain transport
envelope fidelity only; the 614,417-byte lower proof adds no new native
coordinator/content/apply/wake credit.

No local E2E, full suite, install, new hosted run, grant/shared-store/worker change,
real approved producer/preparation/content-through-coordinator/apply/wake/provider,
human-gate bypass, real two-host/full-handoff/full-duplex acceptance or release is
claimed. Protected Details/Naming/Q5 and the accepted unrelated 54-FAIL
nonregression disposition remain outside this work.
