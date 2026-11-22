# Native ingress C1/C2: exact successor review

**Verdict: APPROVE / combined scoped PR-ready at source `ef5e2f53ea9c3af94e7f22e23d9f0c5432b7a596`. C1 and C2 from1172 are resolved. No remaining finding in this correction.** This combines the narrowly verified correction with the otherwise accepted source/queue/postauthorization/owner/RPC observations in [1172](https://github.com/Agent-Clubhouse/Clubhouse/blob/1172df1dde737d8ab3be33be44252103683e98b6/docs/qa-transfer/2026-11-22/reports/native-ingress-940365-independent-source-review.md). It is not a new aggregate final-source test pass, full native grant/preparation/application acceptance, hosted result or landing approval.

Proceed to ordinary fresh actual-main composition/head/clean/pushed/duplicate guards and one coherent PR/automatic hosted validation. No repeated accepted3777/lower proof, broad local rerun or new scope is requested. Any changed-risk drift or actual hosted failure requires its own bounded disposition.

## Exact identities and limited delta

| Object | Exact identity |
|---|---|
| Original reviewed source/proof, preserved | `940365ecde7ca2e9fb31abf48362a938445e1fe5` / `0da6a65fa4973658efe9964a4971ad9bc85d1912` |
| Genuine red fixture freeze | `7be137c573314d76e7f206dd319a8ac7c08f25c7` |
| Initial canonical source/tree | `222737575bba9a36af9ac9c626b92d8cdf23a86f` / `33ef87eedfffc37b0c1005384e2f7d95d91a2219` |
| Combined source/tree | `ef5e2f53ea9c3af94e7f22e23d9f0c5432b7a596` / `d4aecf6d612b57e5bf94861ea7372c4995aeda22` |
| Proof/tree | `206a88dcc93ecd7d2f5009d533894dd77e36e2ed` / `48956fa912ed4e7696451f1f802f74294f0b863c` |
| Remote branch readback | `lane-3613-p2-routes/handoff-next-path` → exact proof head |

Read full [correction README](https://github.com/Agent-Clubhouse/Clubhouse/blob/206a88dcc93ecd7d2f5009d533894dd77e36e2ed/docs/evidence/3613-native-handoff-ingress/trust-correction/README.md), SHA256 `e33da0ceecd35f5bd32b80bcd069caac0ea8b40f27c6fe223a560a75328e8ac5`, [manifest](https://github.com/Agent-Clubhouse/Clubhouse/blob/206a88dcc93ecd7d2f5009d533894dd77e36e2ed/docs/evidence/3613-native-handoff-ingress/trust-correction/manifest.json), SHA256 `4fe021839b560cd7e14b6823e3f73232e775f4a6738291d9acd911a98cb03f52`, initial-C1 manifest, red manifest, corrected historical case manifest, derivation script and actual correction artifacts.

Independent `gh` source/proof commit and pushed-ref readbacks match both supplied trees. Verified the19 main-manifest raw/gzip artifacts, two separately bound red artifacts and the separately bound corrected-collector artifact: stored/raw sizes, SHA256 and supplied Git blob hashes all agree. Corrected historical manifest identity also matches its bound blob/size/SHA256. No product/test/compiler/lint/CI/app execution or source edit by reviewer.

Relative to940, the sole production change is **one native trust serialization line**. One test block and related contract documentation are added. All other host/coordinator/service production bytes are unchanged. Independently matched all13 protected file blobs to original940, and all five preserved trees (fixtures, native baseline, defective native candidate packet, lower reverse-handoff and synchronization proof) to original0da. No Details/Naming/Q5, shared policy/grant/control, outgoing owner, queue or RPC implementation change.

## C1 resolved: canonical original trust, faithful legacy and benign fields

`annex-server.ts:3822` now captures/checks:

```ts
JSON.stringify([annexPeers.trustOf(peer), peer.kind])
```

This includes the original `pairingId` and saved certificate PEM through the existing private canonical trust representation. It also retains all other original trust fields and kind; the request/principal/server/host/liveness guards are untouched. It changes neither shared `trustOf`/`sameTrust` nor their normalization, grants, wire fields or outbound readiness. The captured representation remains private; no logging/probe/receipt is added.

The correction compares existing values rather than requiring a modern pairing ID. The final explicit `legacy-undefined` native case verifies an older peer whose original ID is undefined still admits. Alias, routes and lastSeen remain excluded from authority identity. The full test helper and old case bodies are unchanged except for the added bounded block; no original assertion is removed.

### Actual red, green and final-source bridge

| Evidence | Credited result and source |
|---|---|
| Red21 | **2FAIL/4PASS/13SKIP** over unchanged940 production with the six-row fixture frozen at7be137. PairingId-only and PEM-only original native requests still fulfill and store offered history. Before queue release, the real original principal still authorizes and the manually receiver-opened pinned link remains accepted. Unchanged/route/alias/lastSeen controls pass. Downstream assertions after red failure are uncredited. |
| Green22 | **8PASS/11SKIP** bound to the initial canonical source222737: the same six-row fixture bytes plus the two existing pairedAt/pin controls. PairingId/PEM changes now reject without their record; benign/current rows admit; unrelated already admitted history survives and incoming ownership drains. |
| Legacy27 | **1PASS/19SKIP** on the combined sourceef5e2, selecting only the separately added undefined-ID row. It witnesses no canonical trust change, fulfills, stores offered history and drains ownership. |

Independently parsed XML names/statuses and raw `ANNEX_NATIVE_TRUST_QUEUE` receipts. The two exact red failure names pass in Green22. Red receipts actually show fulfilled/offered for those changed fields; green receipts show rejected/no record; four benign red/green rows remain fulfilled/offered. Legacy27 is an independent final-source positive result.

The red and initial canonical **entire fixture bytes are identical**. The production server is940 on the red freeze and canonical on222737. The server bytes on222737 andef5e2 are identical. Independently reconstructed the initial→final fixture delta: add one array label, condition the original pairing-ID setup on that label and assert undefined in that branch. For the earlier six modern rows, runtime setup and assertion bodies remain equivalent. This is a precise identity/conditional bridge, **not a claim Green22 was executed at ef5e2**.

The PEM-only input deliberately substitutes a valid fixture PEM while retaining saved pin/publicKey/other fields. It is a synthetic inconsistent saved-record discriminator, not proof of a valid native re-pairing or a user incident. PairingId-only is the direct C1 discriminator. Neither test depends on a future device-change debounce closing the original socket.

## Appropriate typing/lint identity, without an aggregate pass claim

- Initial Types23 actually passes its one-complete-fixture-plus-root graph. Final Types28 separately passes the updated final native fixture graph. Each has **3957 ordered inputs and2466 parsed roots =2465 production roots +1 explicit complete changed fixture**. Independently matched each raw ordered file list and all2469 tracked content hashes against its own source Git head;1488 dependency hashes per graph remain owner after-execution observations.
- The config extends unchanged root options/includes/excludes and adds only the native fixture. No reduced mock graph or compiler target/lib change. No atomic per-read/executable/whole-host seal is claimed.
- Lint24 actually covers the initial canonical server+fixture: **0errors/71warnings**. The server is byte-identical in the final source. Independently compared **full warning objects**, including suggestion fix ranges, to940's native-server warnings after mapping the single ASCII expression's **-69 UTF-16-character offset**; all71 match, not only messages/lines.
- Lint29 separately covers the final updated fixture: **0errors/0warnings**. It does not re-execute the unchanged server lint. Whole-repository160-warning baseline remains unmeasured.
- Metadata comparison25 originally failed because it omitted the suggestion-range adjustment. Its raw assertion output remains archived; the corrected comparison is metadata-only. No test/compiler/lint rerun was performed to repair that comparison.

Original35PASS/75SKIP remains **historical940** evidence under1172. Green22's8PASS and final Legacy27's1PASS are separate scopes/sources above. No aggregate41,44 or other exact-successor suite result is asserted, and no unchanged queue/RPC/lifetime or lower content test was rerun for this review.

## C2 resolved:185 accurate historical names from the same XML

Independently read and checked the corrected full collector, derivation script and [corrected historical case manifest](https://github.com/Agent-Clubhouse/Clubhouse/blob/206a88dcc93ecd7d2f5009d533894dd77e36e2ed/docs/evidence/3613-native-handoff-ingress/trust-correction/corrected-historical-case-manifest.json), SHA256 `34a197119c8650c917c4e7b2b907c83f1ec10ee629cebb9e57ae2b04b814b397`.

- The corrected collector differs from the defective original **only** by exact attribute boundaries for `name` and `classname`; whitespace/start matching no longer reads the suffix of `classname` as `name`.
- Independently parsed the unchanged original0da raw XML with a proper XML parser and compared every decoded name/class/status in order: **110 final +31 queue-mutant +44 postauthorization-mutant =185**.
- Independently verified every binding's original raw XML byte length/SHA256, exact testcase fragment byte length/SHA256, ordinal, original escaped attribute and decoded value. They match the same immutable archived XML, not newly generated output.
- Restored only old names in a copy of the corrected manifest and removed its explicit correction-provenance block; the result is deeply identical to the entire original0da manifest. Thus all original counts/classes/statuses, inputs, artifacts, scope/failure metadata and other fields remain unchanged.
- The defective0da manifest/collector and its entire candidate tree remain unchanged. This is explicitly a corrected **historical940** view; the script does not claim fresh execution or upgrade it toef5e2 coverage. C2 introduced no test/compiler/lint/CI rerun.

C2 is therefore closed as metadata preservation/derivation, with no retroactive rewriting of original evidence. The corrected report's case identities can now be used directly; prior independently parsed raw-XML observations remain valid.

## Combined disposition and remaining gates

C1's missing identity field is now present and behaviorally discriminated; C2's names are now faithful and all other historical fields remain intact. Combine this exact correction with1172's accepted remaining native source/queue/postauthorization/actual-owner/stop/admitted-save/RPC observations by the verified source bridges. No new finding requires another contract/product choice or a routine GO before ordinary PR preparation.

The unchanged3777 synchronization and74d lower content proof retain their exact scope and identity only. Native synthetic offer metadata, fixture Dispatcher/runtime inputs, fake-timer deadline/mixed-lifetime controls and original grant/preparation/worker/content/apply/wake/human/two-host/full-handoff exclusions remain. All original red/setup/type/lint/resource-refusal/packaging failures and their execution limits stay preserved. No live setting, re-pair, install, helper, release or default branch action occurred.

Fresh actual-main composition, exact clean/pushed PR head, duplicate guards, ordinary hosted results and final authorized landing guards remain separate. This is scoped PR-readiness, not those later results or broader product acceptance.

Private Q5 branch `auto-reset-policy-design/q5-framed-root-journal-wip` remains clean at `079a257acf38b168b529fb7745dae97f686b72b8`, tree `89e942aabd42c8ec93fe47794f2eef95b0b61980`. Original Details/Naming workspaces and immutable reports remain untouched. Only this report and verification are published to a separate remote QA task branch through the existing authorized gh route.
