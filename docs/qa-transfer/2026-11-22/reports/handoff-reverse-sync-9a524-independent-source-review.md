# Reverse handoff synchronization: independent source and proof review

**Verdict: APPROVE / scoped PR-ready for exact source `9a5247cadf41756bc1c085a87c59493b34d5e99f`. No blocking finding in the reviewed implementation.** The four production files implement the approved6385/404f contract, including the actual command-queue correction from513d. This is source/proof acceptance for the bounded reverse synchronization slice, not landing, release, native grants, content transfer through the coordinator, actual apply/wake, two-host application or full-handoff/full-duplex acceptance.

Proceed with the coherent lower-proof plus synchronization candidate through fresh actual-main composition/head/clean/pushed/duplicate guards and ordinary PR/hosted checks. Do not blindly rebase/rerun unchanged tests or transfer a result to changed dependencies. No standalone proof-only full matrix is needed. The historical failures, lower-proof boundaries and lack of atomic per-read execution tracing remain explicit.

## Exact frozen identities and inspection

| Object | Identity |
|---|---|
| Source | `9a5247cadf41756bc1c085a87c59493b34d5e99f` |
| Source tree | `38b3a1ca4ead8e6b664eef641676cb72838a3814` |
| Resolved full evidence head | **`868d8b53fdb20c23876c83538c855165761b40df`** |
| Evidence tree | **`208fb893fcc36e7154efdb2df07206f85d65f6ed`** |
| Pushed branch readback | `lane-3613-p2-routes/handoff-reverse-sync` → exact evidence head |
| Base | `c2a59f9f2c872bf2cb1fe9852adf8c92f2a996fc` |
| Contract / confirmation | `6385c5ead359d3b46bfc7895e889d4a486dedc4e` / `404f15761cd8319374ccc1b8d9854cd6575bc8e5` |

Read the full [owner README](https://github.com/Agent-Clubhouse/Clubhouse/blob/868d8b53fdb20c23876c83538c855165761b40df/docs/evidence/3613-handoff-reverse-sync/proof/README.md), SHA256 `abcf7ac5e001c8f3c14c3237fc3920ed23654ed027a91b7abc3f01b502ccb3b7`; [manifest](https://github.com/Agent-Clubhouse/Clubhouse/blob/868d8b53fdb20c23876c83538c855165761b40df/docs/evidence/3613-handoff-reverse-sync/proof/manifest.json), SHA256 `bf4ae2bed779aafbb8c766dbfa5d2ef617ba59c1a65041c2ff2f937d53d525b0`; and source map, SHA256 `2b33859740eaa78750cbdf40e1541a7141101eb6855750c738feae757805a725`.

Independently resolved the supplied abbreviated evidence head, checked its and the source's GitHub commit trees, and read back the actual remote ref using **gh only**. All **50** stored gzip artifact blobs independently match stored sizes/SHA256 and decompress to their exact raw sizes/SHA256. The reconstructed final source patch equals the immutable6385→9a524 Git diff. All ten changed-source identities and twelve explicitly unchanged source/config/protocol identities match immutable blobs/hashes. Source changes relative to6385 are exactly four private production services, four existing complete fixture files, one paired assembly test and the reverse-routes documentation; no protected Details/renderer/Naming/selected-board or shared settings/history-store edit.

Review was read-only apart from a separate remote QA report branch. No source edit, product/test/compiler/lint/app/CI execution, account/login/access operation or lower-proof rerun by reviewer.

## Actual implementation

### Original capture and positive authority

`handoff-coordinator.ts:236–307` chooses existing direct connectivity first; only absent direct does it request the optional host capture. Constructor callers without the capture retain legacy behavior. One captured admission is retained for primary and secondary legs, with release in `finally`. Direct POST/removal calls retain their existing argument shapes and optimistic ACK branch. The optional service guard is undefined on the direct path.

`handoff-host.ts:378–398` captures the original host instance, machine, qualified reverse observation/revision and direct absence. Later checks require that exact host not stopping, original machine, network membership, direct absence and same ready revision. The underlying unchanged client observation contains full pinned trust and accepted-link epoch and enforces existing client/network/pause/pairing/member/desktop readiness. Snapshot receipt is not a transport requirement and no cached snapshot/receipt is promoted into handoff authority. No global `isMachineConnected`, control/client selector or route fallback behavior changes.

The full original asynchronous `authorizeOutgoing(record)` executes before transport and again after the primary response. Its current pending-command exception remains; a positive result is not replaced by a lease. `checkOutgoing` brackets that lookup and the attempt-marker await. The existing `transferAuthority` implementation is unchanged. It is captured only for an original LOCAL sender's remote offered record with no pending cancellation. It is a negative revision/binding fence, not a positive grant; no receiver acceptance/incoming-server permission is added. If a capture originally had only the cancellation exception and that command disappears, it cannot acquire missing fresh-offer authority. History/ACK and cancellation retain their independent permission exceptions; queued history/command effects still check the original transport capture without turning cleanup into a fresh-offer grant.

The actual marked-attempt save precedes POST. A successful attempt marker remains conservative if admission then retires with zero POST; it is not restored to never-attempted. Original offer/cancellation IDs, same-ID synchronization, history/source/schema checks, local never-attempted cancellation, terminal-history sinks and10-slot/30-second scheduling are preserved.

### Queue admission and ACK ordering

- `handoff-service.ts:201–213`: synchronous optional `beforeAdopt` runs inside the actual `HandoffStore.transact` callback, before either newer history or older-prefix/no-op acceptance. Parsing, source/id and full history-extension checks remain.
- `handoff-command-store.ts:61–72,83–90`: synchronous optional guard runs **inside** its private queued work before snapshot clone/updater/validation/save. ACK and removal pass it through. Undefined leaves legacy/direct/local defaults unchanged; rejected work does not poison later queued jobs.
- `handoff-coordinator.ts:282–302,310–314`: original capture is carried to receiver ACK, sender terminal ACK, primary cleanup and secondary cancellation adoption/ACK/removal. A reverse terminal secondary reply receives a guarded durable ACK before its command is removed. All later operations independently enter their own guarded admission.
- Reverse `acknowledged` memory advances **after** real guarded durable ACK success. Missing ACK capability explicitly fails; save/guard failure does not leave it advanced. The old direct optional/optimistic branch is not silently redesigned.

The selected admission contract is implemented honestly. Guard refusal before queued admission makes no mutation for that operation. A save admitted while current may finish after retirement and publish its truthful matching committed result. No post-save stale check invents rollback or drops only memory. A later independently refused ACK/removal/POST does not undo already committed history. Existing precommit and ambiguous post-real-rename error behavior is preserved, including the latter's possible newer disk versus original instance's old committed memory; this review does not turn an IO exception into proof that disk never committed.

### Actual-operation ownership and stop

Host-local `HandoffSyncOwner` (`handoff-host.ts:148–191`) holds one enclosing reference plus separately retained actual POST references. `post:399–416` acquires a hold before the existing deadline helper schedules its operation. The scheduled callback checks original capture and expired signal directly before existing `postToMachine`; its own `finally` releases that hold. Outer deadline rejection cannot release a still-running operation's reference. Ending the enclosing sync retires it, removes its queued-writer registration and resolves its enclosing-settled promise; actual-operation references remain until their real settlement. Zero references disposes the negative lease; original checks cannot become current after retirement/disposal.

Normal stop (`:532–550`) marks the original host stopping, retires admissions and awaits registered enclosing reverse writers before relinquishing it. Host replacement cannot bypass a registered admitted writer (`:355–365`). Outstanding POST work from an ended timed-out sync may keep its lease until settlement, but that ended invocation cannot later adopt or queue writes. This is a bounded reverse-owner guarantee, not a global drain for unrelated legacy/local writers that predate capture, cross-instance storage locking, process restart or power-loss proof.

Notification semantics remain normal **retained committed authoritative history**. An unadmitted stale response makes no new version/notice. An admitted version can commit and notify after retirement under existing local eligibility; subsequent sweeps may notify it. No transport fence is falsely claimed at later notice/federation/label/runtime awaits. No Q5 ledger/runtime coordinator or stronger provider-delivery behavior is added.

## Executed evidence, independently reconciled

Final09 raw/JUnit agree: **100PASS / 0FAIL / 0SKIP**, six files: host33, coordinator19, service23, commands10, unchanged retention14, paired1. All mapped execution START/END/exit strings match original raw logs; the final source-head observation is9a524 and frozen source hashes match Git. These are owner launch/source observations and content measurements, **not an atomic embedded per-read/whole-host seal**. Source commit exists before final09's observed launch. No reviewer re-execution is inferred.

| Risk boundary | Actual proof credited |
|---|---|
| Genuine original host gate | Clean baseline11 runs the **same final paired fixture bytes** over actual6385/base production hashes. Actual pinned reverse readiness/direct false/no snapshot gives0requests, retained undelivered and no destination record, then one genuine assertion FAIL. Downstream baseline assertions are unexecuted. Candidate's matching case passes. |
| Paired synchronization | Actual hosts/coordinators/service/history+command stores, TLS/control and request adapter carry `offer(id1), offer(id1), offer(id2)`. Destination decline is returned by sender's immutable-offer retry and committed with durable version2 ACK. Another offered ID remains undelivered while disconnected; explicit epoch1→2 reconnect/sync sends the same retained ID. No snapshot or ordinary HTTP fallback; upgrades only `/control`. |
| Actual history queue | Held real earlier transaction refuses both queued newer and older-prefix acceptance after retirement. Separate admitted atomic-rename hold finishes after retirement with equal disk/memory and a later stale operation refuses. Pre-rename and after-real-rename faults preserve their distinct actual memory/reopened-disk behavior. |
| Actual command queue | Held actual earlier save delays the candidate ACK/removal. Guard is checked only inside queue and refuses; unrelated later operation succeeds. Coordinator assembly exercises receiver ACK, terminal ACK, secondary ACK, primary removal and secondary removal using actual stores with injected admission/POST ports. |
| Semantic discriminator | Clean baseline08 and candidate mutant10 each have2FAIL/8SKIP on the same final command-fixture bytes. Failures are **unexpected resolution rather than expected refusal**, not timeout/cleanup artifacts. Independently reconstructed mutant content removes only `beforeChange?.()` from the queued store and matches its captured hash. Both exact failure names pass in final09. |
| ACK failure/missing capability | Actual queued-store guard/save failure or omitted ACK capability does not advance reverse memory; the retention/prune oracle keeps terminal history. Ambiguous rename control may produce newer reopened disk without a success-shaped in-memory ACK. Direct missing-ACK default remains allowed. |
| Separate admitted operations | Actual admitted history may commit after retirement; next secondary POST refuses. Actual ACK may commit after retirement; distinct primary removal refuses. Secondary success keeps the same admission/cancellation ID through actual service/ACK/removal operations. |
| Fresh authority/currentness | Host tests hold actual outgoing lookup over **mocked** grant/config/connection/binding/revision/member/direct/host inputs. Original negative fence refuses before POST and releases listeners. Binding membership/permission revoke/restore is sticky; denied positive grant and unconnected ordinary target still refuse. Dispatcher outgoing operation does not acquire incoming-server/acceptance prerequisites. These are fixture-input discriminators, not live saved-grant or native pairing experiments. |
| Attempt/microtask | Real attempted marker save completes then retires before POST; no restoration. The actual deadline helper's operation callback is held/changed through a fixture hook, checking capture/expired signal before mocked POST. |
| Timeout/stop/notice | The actual deadline function runs under **controlled fake timers**, with posted/scheduled/rejecting mocked operations held over the5000ms virtual deadline. Enclosing work ends while listeners remain; actual fulfillment/rejection later releases once without stale version/notice or unhandled rejection. An unrelated replacement offer succeeds while expired old operation remains held. Stop waits for admitted real history rename; its committed ordinary-target notice is permitted. This is not a measured five-second wall-time network drain or real provider delivery. |

Independently parsed all four final paired receipts and three clean baseline11 receipts directly from raw logs, exactly matching the source-map derived records. Candidate's explicit values are epochs1/2, terminalVersion2, three exact supported requests, ordinaryHTTP0/directfalse/acceptedSnapshotfalse. Teardown sockets0/inFlight0/subscriptions0/server+forward stopped. These are fixture dispatch observations, not packet tracing. The receiver's decline is retrieved by sender retry; receiver-originated push reachability is not thereby proven.

The new assembly's positive grants, preparation binding, worker, runtime/provider delivery and application route dispatch adapter remain fixtures. The code/tests do not promise all individual guards have independently killed mutants; mutant10 discriminates the queued command check specifically. No new native authority, Git preparation, content apply/wake/UI, real human consent or full handoff scope follows from these passes.

## Compiler, lint and original failures

Final12 compiler is actual **rc0 / 0 diagnostics /3961 ordered inputs**. Its config adds only five explicit complete changed fixture paths while extending the unchanged root config. Independently matched the full raw ordered list to its graph records, each of the five changed fixtures exactly once, and **2473 tracked content hashes** to immutable source Git blobs. The remaining1488 dependency hashes are owner after-execution observations. Root enumeration gives2465 production entries, all present; the adjacent `index.d.mts` shadows its vendor `index.mjs` implementation entry. No target/lib/exclude relaxation or reduced mock graph is substituted for this execution. The unchanged executed retention fixture is additional runtime coverage, not falsely counted as a sixth explicitly typed changed fixture.

Final13 lint JSON and raw gate exit agree: nine changed TypeScript files, **0errors/0warnings**. These are exact new results, not transfers from Details54FAIL, Gitdiff FAIL139/FAIL1 or prior lower graphs. Shared source/config/lock identities remain unchanged.

Original failures remain preserved and narrowly attributed:

- Baseline01 mock-port host FAIL1 is historical; clean paired baseline11 is the final host discriminator.
- Candidate02 actual77PASS/9FAIL and candidate03 actual49PASS/1FAIL remain; candidate02's new coordinator suite did not execute due fixture registration, so it is not19-test coverage. Candidate03's Dispatcher notice-boundary fixture mismatch is not claimed as a production notice defect. Final ordinary-target admitted-notice control retains original notice behavior.
- Candidate04 selected2PASS is not the final100PASS.
- Types05 is actual **12FAIL**. The owner identifies four previously excluded legacy fixture contexts and eight introduced contexts; no baseline compiler run is invented for those categories. Final complete fixtures contain explicit typing corrections without deleted assertion coverage, and actual final12 independently passes the full selected graph. Types07 remains historical.
- Baseline06 has3genuine FAIL **plus2unhandled cleanup errors** from unawaited unrelated test writes. Its earlier fixture hashes differ from final cleanup; it is not relabeled a clean/final discriminator. Original patches/hashes remain. Clean08 drains its own work in `finally` and supplies the command baseline; mutant10 has the same semantic failures without those cleanup errors. All-settled cleanup is not assertion success.
- The original bad non-enum policy placeholder was corrected to existing typed `hands-off`, not accommodated in production. Initial wire-path/packaging metadata corrections remain preserved, not an executed phone replay or rewritten raw output.

## Preserved boundaries and remaining gates

Independently verified144 broader identity-artifact entries against base/source blobs; among them **106 test fixture JSON files /1,547,788 bytes**, including **103 canonical mobile files /1,529,625 bytes**, remain identical. Counts are bytes/files, not phone executions. No client/control/bulk/server/shared schema/route-contract/phone grant behavior, root config, dependencies, shared history/settings stores or protected WIP change.

The six explicitly checked lower-proof executable paths (original consumer, shared helper, lower handoff fixture, transfer source/receiver/adapter) remain byte-identical to `a4074c7`. Reuse `a4074c7` / `be01f8bd` only under its [74d2 accepted limits](https://github.com/Agent-Clubhouse/Clubhouse/blob/74d2ed4f64c1e9d539339e5a75b7c3c31171e8b3/docs/qa-transfer/2026-11-22/reports/reverse-handoff-a407-independent-review.md). Its614417-byte fsynced content proof is not rerun, nor does its old approval cover the new host code. The old81937 bytes remain a transport envelope; raw-versus-trimmed consumer-body hashes remain separate definitions.

Required next gates are ordinary fresh-main/static composition, exact PR head/readback and hosted checks on the coherent candidate; any changed-risk drift or real failure needs bounded disposition. This review does not authorize blind reruns, manual CI dispatch, merge/default writes, installs, releases, live settings mutation or new access. No repeated lower proof or broad local suite is requested absent changed risk.

Private Q5 workspace stays clean at `079a257acf38b168b529fb7745dae97f686b72b8`, tree `89e942aabd42c8ec93fe47794f2eef95b0b61980`, branch `auto-reset-policy-design/q5-framed-root-journal-wip`. Original Details worktree and all immutable proof/review refs remain untouched. This report/verification is preserved on its own remote QA task branch.
