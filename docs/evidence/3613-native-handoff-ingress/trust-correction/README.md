# C1 canonical trust and C2 case derivation: bounded successor

**Exact successor review is pending.** This corrects the parent-conveyed
independent findings in `940365ecde7ca2e9fb31abf48362a938445e1fe5`: the original
native trust tuple omitted `pairingId` and saved certificate PEM, and the evidence
collector confused `name` with the suffix of `classname`. The full BLOCK report
`1172df1dde737d8ab3be33be44252103683e98b6`, blob
`767036e93c31c22fc670685eaadcea69f152a241`, was verified and read in full.
Its other bounded source/queue/RPC/lifetime observations are reused, not rerun.

| Identity | Exact reference |
|---|---|
| Original reviewed source / proof, unchanged | `940365ecde7ca2e9fb31abf48362a938445e1fe5` / `0da6a65fa4973658efe9964a4971ad9bc85d1912` |
| Genuine red fixture and originals | `7be137c573314d76e7f206dd319a8ac7c08f25c7` |
| Initial canonical source / tree | `222737575bba9a36af9ac9c626b92d8cdf23a86f` / `33ef87eedfffc37b0c1005384e2f7d95d91a2219` |
| Combined source with explicit legacy control / tree | `ef5e2f53ea9c3af94e7f22e23d9f0c5432b7a596` / `d4aecf6d612b57e5bf94861ea7372c4995aeda22` |

The production correction is **one line in `annex-server.ts`**:
`JSON.stringify([annexPeers.trustOf(peer), peer.kind])`. It reuses the existing
saved-trust field identity, including `pairingId` and PEM, and the exact prior
representation used by the desktop client. It does not consult outbound
readiness, change shared `trustOf`/`sameTrust`, or add grants/control/wire fields.
`sameTrust`'s pending-status boolean normalization remains untouched; this
capture uses the existing serialized saved identity, not a new shared equality.

The six new cases hold the **actual native history queue** after original
authentication. An established `pairingId` changes alone, or saved PEM changes
alone, while every other saved field is held equal. Before release, the original
real principal still authorizes and the manually receiver-opened pinned link
remains accepted. No control-refresh/debounce timing or replacement principal
is used to infer currentness.

| Run | Observed result |
|---|---|
| Red21, unchanged940 production | **2 FAIL / 4 PASS / 13 SKIP**: pairingId-only and PEM-only stale requests both fulfilled and stored offered history. |
| Green22 | **8 PASS / 11 SKIP**: both stale decisions refuse without their record; unchanged/current, route-only, alias-only and lastSeen-only requests commit; prior pairedAt and pin controls still pass. |
| Types23, minimum6 gate | Zero diagnostics; **3,957 actual compiler inputs / 2,466 roots**, changed native fixture included. |
| Lint24, minimum4 gate | Two changed TypeScript inputs, zero errors; **71 unchanged warnings**, exact940 warning objects including correctly mapped suggestion byte offsets. |
| Legacy27 | **1 PASS / 19 SKIP**, only the explicit undefined-pairingId native current-positive case. No new mandatory modern pairing ID. |
| Final fixture types28 / lint29 | Zero diagnostics, **3,957 inputs / 2,466 roots**; only the changed fixture linted, zero errors/warnings. The server and its71-warning baseline are unchanged from24. |

The new cases retain an unrelated already-admitted transaction and release actual
incoming ownership. Their original red failures and downstream-uncredited
assertions remain in [red-manifest.json](red-manifest.json). The corrected source,
type graph, raw/compressed originals and shared-policy/proof identity guards are
bound in [manifest.json](manifest.json).

The PEM-only fixture substitutes a valid fixture PEM while keeping the saved
pin/public key and all other fields fixed. This is an intentionally synthetic
saved-record mismatch, **not a claimed valid re-pairing or executed incident**.
Native Dispatcher/absent-runtime and synthetic-metadata limits are inherited.

Metadata verification25 initially compared raw lint suggestion character ranges
without accounting for the shorter replacement line. Its original tool output
is preserved. Mapping the existing post-line ranges by **-69 characters** proves
the full warning objects equal; no test, compiler or linter rerun was needed.

## C2: same raw XML, corrected derivation

[derive-case-metadata.cjs](derive-case-metadata.cjs) reads the committed archives,
checks their original raw/stored hashes, and matches **exact whitespace-delimited
attributes**. The corrected full collector differs from its original only in
the two `name`/`classname` attribute boundaries. The defective0da collector and
manifest remain unchanged.

[corrected-historical-case-manifest.json](corrected-historical-case-manifest.json)
binds all **185 actual names/classes/statuses** in order:110 final,31 queue-mutant
and44 postauthorization-mutant. Each binding includes the original escaped
attributes, unchanged XML hash and exact testcase-fragment hash. Counts/classes/
statuses remain the same; only the wrongly derived names change.

This is a corrected **historical940 view**, not new execution or successor-source
coverage. No test/compiler/lint/CI rerun was performed for C2. The27/28/29 runs
above address the separately added C1 legacy fixture only. Original2469 roots
mean **2465 production roots plus four explicit fixtures**, not2469 production
roots; current2466 roots mean2465 plus one native fixture.

## Exact commands

In the descendant `3613-p7w-remaining-consumers-work` checkout:

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/vitest run --project integration test/annex-v2/annex-native-handoff-admission.test.ts --maxWorkers=1 -t 'checks canonical native trust' --reporter=default --reporter=junit --outputFile.junit=node_modules/.cache/native-handoff-ingress/21-canonical-trust-red-original.xml
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/vitest run --project integration test/annex-v2/annex-native-handoff-admission.test.ts --maxWorkers=1 -t 'checks canonical native trust|saved .* changes while the actual queue is held' --reporter=default --reporter=junit --outputFile.junit=node_modules/.cache/native-handoff-ingress/22-canonical-trust-green-original.xml
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 6 -- node_modules/.bin/tsc --noEmit --pretty false --listFiles --project node_modules/.cache/native-handoff-ingress/trust-correction-types.json
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/eslint src/main/services/annex-server.ts test/annex-v2/annex-native-handoff-admission.test.ts --format json --output-file node_modules/.cache/native-handoff-ingress/24-canonical-trust-eslint-original.json
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/vitest run --project integration test/annex-v2/annex-native-handoff-admission.test.ts --maxWorkers=1 -t 'canonical native trust.*legacy-undefined' --reporter=default --reporter=junit --outputFile.junit=node_modules/.cache/native-handoff-ingress/27-legacy-pairing-positive-original.xml
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 6 -- node_modules/.bin/tsc --noEmit --pretty false --listFiles --project node_modules/.cache/native-handoff-ingress/trust-correction-types.json
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- node_modules/.bin/eslint test/annex-v2/annex-native-handoff-admission.test.ts --format json --output-file node_modules/.cache/native-handoff-ingress/29-legacy-fixture-eslint-original.json
node docs/evidence/3613-native-handoff-ingress/trust-correction/derive-case-metadata.cjs
```

Only correction checks and directly affected trust controls ran. The original35,
lower/synchronization proof, original failures and fixture/shared-policy trees
remain immutable and were not rerun. There is no aggregate41 exact-successor
pass claim, PR/CI/install/local-E2E, new grant/preparation/worker/content/apply/wake,
provider/human/two-host/full-handoff/full-duplex acceptance or release. Exact combined C1+C2 independent review is required before
one coherent PR.
