# Reverse handoff composed fixture: exact source and bounded proof

Executable/documentation source: **`a4074c7f5e76714bbe346ecee1acfc434307de0e`**,
tree **`2281eb788e825e12c2e3b70b160b4c50863a7e36`**.
Base and freshly fetched main: **`c2a59f9f2c872bf2cb1fe9852adf8c92f2a996fc`**.
This containing packet adds evidence only. Independent exact source/proof review,
ordinary PR/hosted gates and acceptance are **pending**. No PR, hosted run,
production correction, full-duplex or handoff-product acceptance is claimed.

## Source and ownership

Four changed paths: new `test/annex-v2/annex-reverse-handoff.test.ts`; new shared
`reverse-desktop-fixture.ts`; import/extraction-only changes in
`annex-reverse-consumers.test.ts`; bounded current-source/acceptance reconciliation
in `docs/annex-reverse-routes.md`. Stat: **469 insertions / 76 deletions**.
Production, protocol, caps, grants, root compiler/Vitest/dependency configuration,
selected-board/Naming work and phone fixtures are unchanged from the base.

The shared desktop/helper bodies match the base after stripping only `export`
keywords: SHA256 `eb666631946839dad0a3ae3e92ace2e689a70839c611526579227277f85ddf3f`.
The original consumer test body is byte-identical:
`9d74bbe97ea016a9de13044a40af192b0823d73253603a5f366139c07ff3c8f7`.
Its original **81,937 bytes** remain handoff-shaped transport-envelope fidelity,
not real handoff operations. The new fixture uses only actual parser-supported
`manifest` and `read` requests through existing `requestHandoffTransfer`,
`postToMachine`, real pinned control/bulk, `HandoffTransferSource`,
`receiveHandoffSnapshot` and real file descriptors/sync.

## Exact final observations

All five new cases use **614,417 bytes**, every byte value represented.
File SHA256: `0667d68f3d54649e11117d55ec5d2394f93f48d7ff1b0792212cf19b062225f2`.
Canonical manifest SHA256:
`3b8a71ecda0deba7d7948cda37f1add54f7cb55ba7a55dead05a6c9a84107548`.
Original raw stdout/JUnit preserve each exact machine, pin, accepted fixture
agreement, manifest, dispatch sequence and link epoch. No inferred aggregate
replaces those case-specific receipts.

| Case | Observed boundary |
|---|---|
| Durable cut/resume | Progress executes after the receiver's real `handle.sync()`. Disk length and exact prefix are checked at262,144 bytes before actually closing the owned control connection. Interrupted receiver retains that prefix. Explicit reconnect changes epoch1→2; unchanged agreement is checked before explicit resume. Reads resume at262,144 then524,288; final disk bytes/digest and manifest match. |
| Sender retirement | After the first synced chunk, the sender record becomes cancelled. Actual source refuses the next read with `record_state`; receiving allocation is removed. No second content reply is published. Closing that transfer does not prevent a distinct valid agreement completing on the still-eligible link. |
| Chunk corruption | Fixture peer changes bytes without changing the chunk hash. Receiver rejects `hash_mismatch` after one content reply and removes its allocation. |
| Final digest corruption | Fixture peer changes every chunk and supplies valid new per-chunk hashes. All three chunks pass chunk verification, but actual final snapshot verification rejects the unchanged agreed file digest; allocation is removed. |
| Held old source read | A wrapper awaits **after actual descriptor read, before actual source post-await fences**, retaining the source operation and original dispatch context. Actual link loss aborts the requester. While that operation remains held, a new epoch serves a different valid agreement. Release lets the actual source fence refuse old work; zero old content replies are published, zero old receiving bytes appear, and the old descriptor is released. Only an explicit receiver invocation resumes the original agreement. |

Each of the five pairs reports sockets0 / in-flight dispatches0 / source
descriptors0 / both owned listeners stopped after teardown. Opposite direct TCP
is actually refused; ordinary HTTP requests are0; upgrades are only `/control`.
No timing-based drop guess, automatic operation replay, fallback or implicit
cross-generation receiver adoption is credited.

## Validation and original failures

Final commands, serialized under the normal lane gate:

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 6 -- npx tsc --noEmit --pretty false --listFiles --project node_modules/.cache/reverse-handoff/fixture-types.json
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- npx eslint test/annex-v2/annex-reverse-consumers.test.ts test/annex-v2/annex-reverse-handoff.test.ts test/annex-v2/reverse-desktop-fixture.ts
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- npx vitest run --project integration test/annex-v2/annex-reverse-consumers.test.ts test/annex-v2/annex-reverse-handoff.test.ts --maxWorkers=1 --no-file-parallelism --reporter=default --reporter=junit --outputFile.junit=node_modules/.cache/reverse-handoff/08-junit.xml
```

Final08: **6PASS / 0FAIL / 0SKIP**, two files: five new handoff cases and the one
unchanged original consumer case. Final06 compiler: **PASS / exit0 / 0 diagnostics**,
with **3958 ordered inputs**, including all three actual changed test/helper paths
and the unchanged inherited full production include. Final07 scoped lint:
**PASS / exit0 / 0 errors / 0 warnings**.

The fixture compiler adds explicit `files` while inheriting unmodified root
options/include/excludes; it is not an unrelated root-excludes-tests substitute.
This is a distinct graph from the prior Details3956-input/54FAIL disposition:
the earlier failure is not relabeled PASS or transferred here. Ordered file
names and content hashes are frozen; input contents were measured after the
execution, **not atomically traced at each compiler read**.

Original01 remains **5PASS / 1FAIL**: isolated target error tags were read through
the wrong module context's private WeakMap, so the expected `record_state` was
observed as `unknown`. The fixture now uses the target's own diagnostic module;
no production error decision or allowlist changed. Original03 actual fixture
compiler remains **FAIL / exit2 / one introduced TS2554**: the fixture omitted
the existing `decodeControlBody` encoding argument. Passing the captured request
encoding corrected it. Intermediate02/04/05 results remain historical; final
source strengthens the held case to the actual source read await and unrelated
work while held, so only final06/07/08 attest the exact source above.
No base production failure, baseline compiler comparison or causal product
defect is invented for this proof-only change.

All **106 tracked test-directory fixture JSON files / 1,547,788 raw bytes** match
the base. The broader filename-selected identity artifact also includes older
documentation artifacts; its144 entries are **not**144 phone/test executions.
No installation, full suite, Electron/browser/local E2E, phone replay,
two-host deployment, paid-provider call or repeated Gitdiff/Details proof occurred.

## Limits and independent-review inputs

Two isolated desktop module contexts are in one Node process on one host.
Electron/UI/native providers are mocked; identities, certificate pins, TLS,
WebSockets, control/bulk, source/receiver verification and disk I/O are real.
The single forward is fixture-managed byte-transparent TCP, not a tunnel
manager or relay product.

Accepted records (including their fixture history), source preparation lookup,
target route dispatch and sender/receiver agent-grant admission are fixtures.
The production server route, handoff coordinator/host/worker,
`transferAuthority` saved-grant/binding leases, offer/accept synchronization,
Git selection/preparation, apply/wake, renderer publication and real human/app
gates are **not** exercised. P1 pin/peer authorization is real against fixture
membership/settings dependencies. Retirement covers actual source agreement
fences, not real saved-agent-grant revocation.

The bounded corruption controls act as a malicious fixture peer after real
source verification; they do not mock integrity verification. The held read
wrapper performs the real descriptor read and then yields; actual source
post-await checks run on release. Published-response receipts are fixture
dispatch observations, not packet-level TLS write tracing or renderer events.
Future targeted product proof remains separate.

`manifest.json` binds all30 original/derived artifacts by raw/stored SHA256 and
size. Large files use lossless gzip. `final-binding.json` identifies source blobs,
compiler scope, cases and helper equality; `final-compiler-inputs.json` is the
ordered full graph; `final-runtime-receipts.json` retains every final receipt;
`source-delta.patch` gives the exact delta. The original failure logs, JUnit and
source snapshots remain included, with no discarded FAIL or relaxed setting.
The initial packaging whitespace check flagged blank context lines in the
embedded patch, not source whitespace. The raw patch is stored losslessly in
gzip rather than changing those original bytes; no executable proof was rerun.
A packaging baseline-identity assertion also refused a newly staged evidence
JSON that has no base blob; baseline enumeration now uses the immutable base
tree instead of the candidate index. Neither error changes validation outcomes.
