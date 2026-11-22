# #3774 hosted blocker: bounded investigation, cause unresolved

**No cause-supported correction is established.** All product/test sources are
restored byte-for-byte to approved PR head
`e56648cb0952cb29c5045107b635d81f662dae74`; this investigation branch adds only
evidence and its capture producer. Same PR3774 remains blocked by failed hosted
run44981401024. No PR update, CI rerun, deadline increase, grant/service/workflow
change or source-approval transfer.

## Actual failed checkout, not merely an unchanged test

The original job log records `git log -1 --format=%H` returning
`7d8f85ef23058350d0491886665eeea90976750d`. GitHub's immutable commit and fetched
Git object confirm parents `e68536e2d292ed0b824230e158e54ff79b2f027d` and
`e56648cb0952cb29c5045107b635d81f662dae74`, tree
`3a565789d7551b92fce8c34ee14677b79efd69cc`: **the entire tree equals the approved
PR head**, including fixture, service, mocks, builtin payloads and configs.

Hosted Node is22.23.4. The actual command is
`npm test -- --shard=2/2 --passWithNoTests --reporter=default --reporter=junit --outputFile.junit=test-results.xml`.
It uses the existing main/renderer/shared/preload/integration configuration,
with no explicit worker cap in this invocation. A current worker count or
machine-contention explanation is not measured by the log.

Original Windows2 job137082523804 has exactly one failed test:
`managed-agents/delivery.test.ts:233`, the grant-gated project-owned skill case.
Error is `Test timed out in5000ms`; JUnit duration is10.395297s. The fixture blob
is `a47f156c1fc496d9472b7e074257b91e566fb3b7`. Original full job log and JUnit
ZIP are archived in [official/](official/), not overwritten or rerun.
The full and `--log-failed` downloads in this job were byte-identical; the
archived stream contains checkout, setup, command and failure context.

## Exact work and interference boundaries

`beforeAll` installs builtin assets once; `beforeEach` creates a fresh root,
copies the seed and verifies builtin revisions. Each case gets its own catalog,
state service and agent. No test concurrency, fake timer or shuffled sequence
is declared in this file. Vitest config resets/restores mocks.

The timed body initializes Git synchronously, writes the project skill and
stages it with a second synchronous Git call, then awaits real delivery.
Delivery resolves the granted skill and MCP catalog payloads, writes provider
instructions, checks safe paths, and awaits one real Git `ls-files` query for
tracked skills. That query's existing service timeout is10000ms. A project's
tracked builtin copy is left untouched and excluded from delivered skill IDs.
MCP writing and Claude parent-instruction stat/realpath scanning also run.
Finally, the test checks empty delivered IDs, current grant status without
installation evidence and unchanged project bytes; the grant provider is
stopped in `finally`.

Nearby grant tests also stop their providers in `finally`; the stop function
checks provider identity. The only PATH mutation is in a later Git-missing
case and is restored in `finally`. There is no earlier same-file PATH/fake-time
mutation found to explain this failure. Roots are not removed after every case;
the original file's cleanup removes the builtin seed in `afterAll`. This is a
possible shared-filesystem cost, not observed causal interference or authority
failure. No host/app paths were deleted or reset by this investigation.

## Executed transparent observations

Both attempts run the original timed case and three relevant grant/real-Git
neighbors, normal lane-p2 minimum4 GiB, main project and maxWorkers2. Source
instrumentation is **explicit tracked WIP**, not an unchanged-head run; both
patches reconstruct the recorded fixture bytes exactly. It forwards native Git
calls/options/results, leaves all original grant/content assertions and
deadline intact, and adds only phase observations.

Attempt01: **4 PASS/64 skipped**. Its original capture contains no emitted phase
records, so it has **no metric credit**. Attempt02 changes the instrumentation
to collect entries in memory and write one sidecar after existing seed cleanup:
**4 PASS/64 skipped**. [phase-observation.json](phase-observation.json) contains
the actual measurements. No Git delay, fake tracking result or synthetic timeout
was introduced.

| Local target phase | Measured milliseconds |
|---|---:|
| beforeEach total / copy / ensure | 7.311958 / 3.580208 / 3.531708 |
| synchronous Git init | 20.375542 |
| synchronous Git add | 14.100917 |
| async Git close interval | 9.594958 |
| awaited delivery total | 12.165083 |
| timed body through grant-provider cleanup | 47.516042 |

The three child wall intervals total44.071417ms, about92.75% of this local body.
This identifies a local external-process cost concentration, **not the Windows
stall's cause**. The unchanged neighboring real-Git/grant cases also pass.
The local OS is macOS and Node24.22.1 (observed after the runs, not retrosealed
per-command runtime metadata); hosted Node22.23.4/Windows differs.

Vitest4.1.12's inspected runner starts reported `test.result.duration` before
`beforeEach` and finishes it after cleanup. Its callback's5000ms deadline is a
separate wrapper. Therefore10.395297s is not a proved body or Git duration:
it cannot be apportioned among setup, synchronous children, async Git and
filesystem work from the original JUnit. Installed runner inspection is a
post-observation source interpretation, not a hosted stack trace or new timeout
policy. No assertion-cost hotspot, wrong grant receipt or intrinsic service
logic defect was demonstrated.

## Verdict and smallest missing evidence

The original hosted timeout remains real. Local green/unchanged inputs are
**not baseline/flake proof**. The larger service subprocess budget and
unbounded synchronous fixture calls identify places to observe, not grounds
to silently mock tracked ownership, move work outside the deadline, increase
timeouts or change grant behavior. No patch is forced from this measurement.

The smallest missing evidence is Windows22.23.4 phase attribution separating
beforeEach, each Git call and actual delivery for this exact fixture under the
existing approved validation route. This macOS lane cannot reconstruct that
past timing. An authorized Windows diagnostic observation is the recommended
next dependency before selecting a correction; none is launched here.

Both raw gate streams, before/after head/tree/status/diff/gate and55 selected
input seals, observational patches and sidecar are preserved. The54 original
fixture/service/mock/config/builtin inputs bridge to the failed tree; the extra
capture producer is task-only. Seals are not exhaustive runtime/untracked-input
seals. Source restoration is verified without rerunning unchanged approved
inputs. Independent #3714 source720 approval592 remains unchanged; no broader
security, current-app, phone, federation or full-duplex acceptance is inferred.
