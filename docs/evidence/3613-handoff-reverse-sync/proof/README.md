# Reverse handoff synchronization: bounded four-file source and proof

**Implementation candidate, awaiting independent exact source/proof review.
No PR, hosted CI, landing or full-handoff acceptance.**

Executable/doc source: `9a5247cadf41756bc1c085a87c59493b34d5e99f`, tree
`38b3a1ca4ead8e6b664eef641676cb72838a3814`. Base remains
`c2a59f9f2c872bf2cb1fe9852adf8c92f2a996fc`. The independently approved
[6385 contract](https://github.com/Agent-Clubhouse/Clubhouse/blob/6385c5ead359d3b46bfc7895e889d4a486dedc4e/docs/evidence/3613-handoff-sync-contract-r2/README.md)
was fully read with the complete404f15761cd8319374ccc1b8d9854cd6575bc8e5
confirmation, blob `bbe2f6be5371e21ae08878e3286a0125f8b3c447`, retrieved and
Git-blob verified. D1 was closed **design-only**, not as unseen-code approval.

Relative to6385, the exact source delta is **10 files,925 insertions/63 deletions**:
four private production services, their four complete existing test files,
one new paired assembly test and the desktop reverse-routes doc.
`source-map.json` binds all ten files by Git blob, bytes and SHA256 and names
the actual symbols/lines. No whole-file transplant or protected WIP change.

## Exact source boundaries

| File | Change and admission boundary |
|---|---|
| `handoff-host.ts` | Host-local `HandoffSyncOwner` at148, reverse capture378, actual deadline POST399, stop532. Captures original host, eligible peer and existing ready/revision observation only when direct is absent. Existing pins/accepted-link currentness come from that observation; it grants no handoff/snapshot authority. |
| `handoff-coordinator.ts` | `syncRecord`236 retains one capture through primary/terminal/secondary legs. Existing full positive authorization and pending-command exception remain. `acknowledgeReverse`310 publishes reverse memory only after actual guarded durable ACK success; missing capability is explicit failure. Direct optimistic ACK ordering and default call shapes remain. |
| `handoff-service.ts` | Optional synchronous `beforeAdopt` in `receiveSnapshot`201 runs at206 inside the actual history queue, before accepting newer history or an older prefix. Original source/id/full-history checks remain. |
| `handoff-command-store.ts` | Optional synchronous ACK/removal callback enters `change`61 and runs at63 after actual lock acquisition, before updater/validation/save. No callback is serialized; undefined preserves direct/local callers. Rejection does not poison the existing queue. |

The fresh negative authority lease is only for an original LOCAL sender,
remote destination, offered record, no pending cancellation. Existing
`transferAuthority` is unchanged and does not replace positive
`authorizeOutgoing`. Pending cancellation and receiver-authored history/ACK
keep their original permission exceptions. A previously exception-only capture
cannot silently become fresh-offer authority if its cancellation disappears.
No global connectivity, client/control/protocol/caps/grant-store expansion.

Every reverse POST retains its actual-operation reference **before** the
existing deadline helper schedules its microtask. The scheduled operation
checks the original capture and expired signal immediately before the existing
`postToMachine`. Its settlement `finally`, not outer timeout, releases that
reference. The enclosing sync holds actually awaited history/command work and
ends separately. Final disposal is once at zero actual references.

Normal stop retires new admissions and awaits registered enclosing reverse
writers before replacement. A timed-out operation still owns its separate
reference until settlement but has no ended-sync continuation able to adopt
history or admit commands. This is not a new global shutdown/locking protocol
for unrelated pre-capture local writers, cross-instance crashes or power loss.
The unchanged30-second sweep, direct listener, same-ID serialization,
conservative attempted marker and10-slot active/history fairness remain.

## Admitted commit and notices

Retirement **before actual queued admission** refuses that mutation. Retirement
**after admission** may finish the actual atomic save; success publishes matching
committed memory and its truthful result. There is no post-save stale check
pretending that success failed, dropping only memory or rewriting older disk.
Each later ACK/remove/POST independently checks the original capture; refusing
that next operation does not undo an earlier committed one.

Deterministic pre-rename error and ambiguous post-real-rename error are distinct.
Both surface actual failure and leave the original instance's committed memory
unchanged; in the latter injection, a newly opened store reads the newer disk
version. This is **not** proof of disk rollback/no commit on arbitrary IO error.
Reverse ACK memory never advances merely because a failed save might have
replaced disk. Source storage behavior is unchanged.

Notice choice remains **normal retained committed authoritative history**.
An unadmitted stale reply creates no new committed version/notice. An admitted
version may persist and notify after retirement, including a later ordinary
sweep if a distinct cleanup refused. No caller check is claimed to fence later
notice/label/federation/runtime awaits. No Q5 ledger redesign or stronger
provider-delivery claim.

## Executed new assembly risks

| Boundary | Actual evidence on exact9a5247 source |
|---|---|
| Original host gate | Final paired base11: actual pinned accepted link/ready revision, direct false, no snapshot; original host sends0 requests, retains undelivered marker and destination has no record. One genuine assertion FAIL. The identical final fixture sends/adopts on the candidate. |
| Complete paired assembly | Actual host/coordinator/service/history/command stores and pinned TLS/control; first offer arrives, receiver decline is retained and sender commits durable version2 ACK. While disconnected, a different offer remains undelivered; explicit epoch1-to2 reconnect plus sync sends the same retained logical ID. |
| Held authority | Original host outgoing lookup held across grant revision, configuration, connection notification, binding revoke/restore, epoch/readiness/membership/direct promotion and host-instance replacement. No POST and original undelivered state remains. Negative lease does not grant a denied positive lookup; unconnected ordinary target refuses, Dispatcher does not acquire incoming-server/acceptance prerequisites. |
| Attempt/microtask | Actual attempted save completes before retirement with0 POST and no marker restoration. Retirement in the actual deadline microtask refuses before `postToMachine`. Expired scheduled operation also sends0 POST. |
| Actual history queue | Earlier real transaction held; newer and older-prefix adoption guards run only after actual acquisition and refuse retired work. Separate admitted real atomic rename hold completes after retirement with equal disk/memory, and next stale operation refuses. Original source/history forgery tests remain. |
| Actual command queue | Earlier real save held before ACK/removal. Guard executes inside queue and refuses; unrelated subsequent mutation succeeds. Candidate guards cover receiver ACK, terminal ACK, secondary ACK, primary removal and secondary removal through actual coordinator/store operations. |
| Guard discriminator | Clean base08 FAIL2 and actual candidate guard-removal mutant10 FAIL2, no unhandled errors. Only `beforeChange?.()` is removed from the actual queued store in the mutant; no mocked Git/new test framework. Candidate passes both unchanged assertion bodies. |
| ACK memory/IO | Receiver false-ACK map would prune retained terminal history; refusal/missing ACK/precommit error/ambiguous error all retain it. Admitted ACK may save after retirement, but separate original-capture removal refuses. |
| Secondary cancellation | Original capture and cancellation operation ID retained through primary and every secondary adoption/ACK/removal. Primary admitted history can commit after retirement; next secondary POST refuses. Actual pending cancellation can finish after grant/connection withdrawal without inventing new authority/ID. |
| Deadline/lifetime/stop | Actual or scheduled POST remains held past5000ms outer rejection: listeners remain until actual settlement and unsubscribe once. Late fulfillment and rejection produce no stale adoption/version notice or unhandled rejection. A replacement serves an unrelated eligible offer while old expired actual work remains held. Stop waits for admitted owned history save before replacement; normal committed-history notice remains permitted. |
| Legacy/bounds | Old no-control and existing direct controls, local operations, cancellation/retention and10-slot fairness all pass. Five-second/512KiB POST limits,30-second sweep and logical IDs unchanged. |

Final raw paired receipts identify both real fingerprints/pins, agreement IDs,
epochs1/2 and exact supported requests:
`offer(id1), offer(id1), offer(id2)`. No handoff-shaped `chunk` operation.
Ordinary HTTP count0; upgrades only `/control`; direct false and accepted
snapshot false. Teardown: sockets0/in-flight0/subscriptions0/listeners stopped.
These receipts are fixture dispatch observations, not packet tracing.

## Gated commands and counts

Execution directory is the existing descendant worktree
`node_modules/.cache/3613-p7w-remaining-consumers-work`.
All heavy jobs are sequential under the normal lane gate; no refusal/retry,
install, full suite, local Electron/browser E2E, manual dispatch or same-head
hosted rerun.

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/vitest run --project main --project integration src/main/services/handoff-host.test.ts src/main/services/handoff-coordinator.test.ts src/main/services/handoff-service.test.ts src/main/services/handoff-command-store.test.ts src/main/services/handoff-retention.test.ts test/annex-v2/annex-reverse-handoff-sync.test.ts --maxWorkers=1 --reporter=default --reporter=junit --outputFile.junit=node_modules/.cache/handoff-reverse-sync/final09-original.xml
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 6 -- node_modules/.bin/tsc --noEmit --pretty false --listFiles --project node_modules/.cache/handoff-reverse-sync/changed-fixture-types.json
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/eslint src/main/services/handoff-host.ts src/main/services/handoff-coordinator.ts src/main/services/handoff-service.ts src/main/services/handoff-command-store.ts src/main/services/handoff-host.test.ts src/main/services/handoff-coordinator.test.ts src/main/services/handoff-service.test.ts src/main/services/handoff-command-store.test.ts test/annex-v2/annex-reverse-handoff-sync.test.ts --format json --output-file node_modules/.cache/handoff-reverse-sync/lint13-original.json
```

Final09: **100PASS/0FAIL/0SKIP,6 files**, no unhandled errors. Per-file counts:
host33, coordinator19, service23, commands10, retention14, paired1.
Types12: **PASS/exit0/0 diagnostics,3961 ordered actual inputs**. All five
complete changed tests are present, as are **all2465 parsed root include files**;
unchanged root target/options/include/excludes are inherited. This is not a
root-excludes-test typing substitute. Lint13: **PASS/exit0,9 files,
0 errors/0 warnings**.

Node24.22.1, TypeScript5.9.3, Vitest4.1.12, ESLint9.39.5.
Actual `--listFiles` output and the full ordered content-hash graph are archived.
Hashes are measured after execution, not atomic per-read content tracing.
The original fixture config bytes are archived at their executed-relative
`.cache` path; copying them to a different-depth evidence directory does not
pretend to be a valid replay location.

## Originals, identity and limits

All **50** original/derived artifacts in `manifest.json` are gzip containers.
Raw bytes/SHA256 and stored bytes/SHA256 are separately bound; gunzip equals
the originals without trimming/rewriting output or patch-context whitespace.
The source map binds original gate START/END commands/exit codes.

Original01 mock-client-port host baseline FAIL1 remains. Original02
77PASS/9FAIL exposed misplaced suite registration plus a fixture message
assertion; the new coordinator suite did not execute there. Original03
49PASS/1FAIL exposed the Dispatcher fixture's notice-boundary mismatch; the
committed-notice proof uses a valid ordinary connected target instead, without
production notice changes. Original04 selected2PASS is not the final100PASS.
Types05 initial **12FAIL** are retained: four previously excluded legacy
host-fixture contexts and eight introduced contexts, all explicitly typed
without changing their values or removing coverage. Types07 PASS is historical,
not a substitute for final12's actual3961-input compiler.

Original06 contains three genuine baseline failures **plus two cleanup errors**
from unawaited unrelated test writes; it is not called a clean discriminator.
Cleanup now drains actual jobs in `finally` without treating all-settled as
test success. Clean08 has two genuine queue failures; clean11 supplies the
identical final-fixture paired host failure. The earlier paired fixture's
non-enum control placeholder is corrected to typed existing `hands-off`;
no production policy/protocol accommodation. An initial metadata audit's
nonexistent wire-fixture path is preserved separately and corrected from the
existing generator source, without execution. Packaging's incorrect bulk-file
path assertion was corrected before writing the packet; no tests/compiler rerun.

All **106 test-directory fixture JSON files/1,547,788 bytes** remain identical.
The broader frozen identity inventory has144 entries including historical
documentation metadata, not144 phone executions. All **103 canonical
`test/fixtures/annex-mobile` files/1,529,625 bytes** independently match base Git
blobs. Client/control/bulk/server/shared handoff schema, phone contract,
shared settings/history stores and dependency/root config bytes remain unchanged.

Reuse unchanged **a4074c7 source / be01f8bd proof**, independently accepted at
**74d2ed4**, only by exact identity. Its614,417-byte actual source/receiver
fsynced cut/resume/corruption/retirement proof is not rerun or expanded here.
The older81,937 bytes remain transport-envelope fidelity only. Owner9d74
original-consumer test-body hashing trims terminal whitespace; the independent
raw final-newline hash is a different definition, not falsely equated.

This new proof uses one Node process/two isolated module contexts/one physical
host. P1 peer/pin admission, TLS/control and domain/durable stores are real.
Positive grant callbacks, preparation binding, worker, runtime/provider delivery
and application route dispatch adapter remain fixtures. No native grant flow,
real preparation/Git, content transfer through coordinator, apply/wake/UI,
two-host or full-duplex product acceptance is inferred. Prior Details54FAIL,
Gitdiff FAIL1/FAIL139 nonregression dispositions and the unexplained original
Windows timeout are neither rerun nor relabeled by this distinct graph.

Independent exact implementation/proof review precedes a coherent ordinary PR
and hosted gates. Existing accepted lower proof, protected WIP and review refs
are preserved; no standalone matrix/PR is started to unblock further work.
