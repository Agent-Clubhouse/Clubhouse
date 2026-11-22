# Native handoff ingress: exact source and proof review

**Verdict: BLOCK / CHANGES REQUESTED at `940365ecde7ca2e9fb31abf48362a938445e1fe5`.** One bounded production correction is required: the original native trust capture omits the pairing ID. A separate evidence metadata correction is also required: the collector records file names instead of actual case names. The queued/postauthorization, owner/stop and admitted-save/RPC portions otherwise match the approved3e06 boundary within the observations below; that does not make the whole candidate PR-ready.

No reviewer product/test/compiler/lint/CI execution or source edit. Parent already relayed the narrow pairing-capture successor; preserve this source/proof and originals, then review the exact correction/proof separately. No repeated3777 or lower content proof is requested.

## Exact source and evidence

| Object | Identity |
|---|---|
| Base landed production | `70eff94e9042ccc304e68282e76afc9065497858` |
| Genuine native baseline | `c06ba470326b72b41568950e6e6e44f8b690e9bf` |
| Candidate source | `940365ecde7ca2e9fb31abf48362a938445e1fe5` |
| Source tree | `b3fb94c3b7bf94bb30a934d4d39b42a8850500aa` |
| Proof head | `0da6a65fa4973658efe9964a4971ad9bc85d1912` |
| Proof tree | `b42ede3a96fa08b3d6fb5ce01b8d8daeaab2fc9b` |
| Observed remote branch | `lane-3613-p2-routes/handoff-next-path` → exact proof head |
| Design report | `3e06e4f4e6a3c7ce9bc290a889fc06a02bd46dac`, blob `cc7b465f4ae08f90d24c3b28c8795becadd4f16e` |

Read the full [candidate README](https://github.com/Agent-Clubhouse/Clubhouse/blob/0da6a65fa4973658efe9964a4971ad9bc85d1912/docs/evidence/3613-native-handoff-ingress/candidate/README.md), SHA256 `00d8e0b72cf1e3b5737ecee97282dfc06946361aa6622c4191b8bac13f26c594`, and [manifest](https://github.com/Agent-Clubhouse/Clubhouse/blob/0da6a65fa4973658efe9964a4971ad9bc85d1912/docs/evidence/3613-native-handoff-ingress/candidate/manifest.json), SHA256 `1238141e78d13e9ed916c3a94c57b25046aeddb7b6cbeaf9e9a3ff77cc687f59`.

Independently verified all31 committed candidate gzip artifacts against stored/raw lengths, SHA256 and Git blob hashes, plus all three baseline raw/gzip artifacts atc06ba. Both source and proof commit trees and the branch ref match authorized `gh` readback. All nine source-input blob/byte/hash identities match immutable source; four production paths are exactly the approved server/host/coordinator/service scope. All59 protected inputs,87 lower/synchronization proof files and106 fixture JSON identities compare byte-for-byte to base. The additional baseline/contract/evidence documentation is not silently treated as production scope. Q5/Details/Naming files are untouched.

## Findings

| # | Severity | File / lines | Vulnerability or proof defect | Confidence |
|---|---|---|---|---|
| C1 | Medium | `src/main/services/annex-server.ts:3819–3828`, especially3822; native fixture393–411 | The original trust snapshot captures public key, `pairedAt`, role/kind/pending and pin, but omits **`pairingId`**. A same-fingerprint/pin/timestamp peer whose pairing ID changes remains equal under this capture and still passes the real authorizer. An original queued request can therefore cross the pairing-identity change unless some other mechanism happens to retire its link first. Existing “pairing-scalar” proof changes only `pairedAt`, so does not discriminate this omission. | High source confidence; no reviewer runtime reproduction or observed-user incident claimed |
| C2 | Low, evidence packaging | Frozen `collector-original.cjs:117–120`; manifest final/mutant case arrays | `/name="..."/` also matches the suffix of `classname="..."`, which appears first in Vitest XML. The derived manifest's185 case names are file paths, not the actual testcase names. README's assertion that all selected/skipped names are correctly bound is inaccurate. Counts/classes/statuses remain correct and the raw archived XML retains the genuine names. | High, independently parsed exact artifacts |

### C1: minimal correction and meaningful control

The canonical existing pairing identity is explicit in `annex-peers.ts:303–325`: `PeerTrust`/`trustOf`/`sameTrust` include `pairingId` as well as the pin and join time. Native `stillAuthorized` reauthorizes the original fingerprint/pin/via against current eligibility (`annex-authorizer.ts:112–117`); it does not compare pairing ID. `agentCallPeer` is likewise a current membership predicate, not an original pairing receipt.

Source-derived counterexample: retain fingerprint/publicKey/certificate pin/pairedAt/role/kind/networkPending and original live dispatch; replace only `pairingId`. The new route's trust function returns the identical string and current authorizer remains satisfied. This is a gap in the promised original pairing binding, not a claim of a real unauthorized peer/session in production.

Do not use eventual connection refresh as the required fence. This native fixture intentionally runs neither desktop client and opens the pinned connection explicitly; `connectTo` without `connectionSource` does not install a kept-plan trust observer (`annex-control.ts:1292–1308`). Even when the normal client supplies plans, its `onDevicesChanged` refresh is driven by a50ms debounced topology notification (`annex-client.ts:3595–3625`, `annex-device-signal.ts`). Actual queued admission may run before that later refresh closes the socket. The route-level original-pairing comparison is therefore material independently of a future link teardown.

Use the existing canonical private trust observation plus kind (for example the same `trustOf(peer)`+kind pattern already used by the client), or an explicitly equivalent bounded field set containing the original pairing ID. Do not require a nonmissing modern pairing ID for old clients merely to capture its original value; compare undefined faithfully. Do not include display/routing noise such as alias, lastSeen or typed hosts. Keep credential material private and out of logs/artifacts.

Add a matched actual held-queue case that changes **only pairingId**, leaves pin/pairedAt/other authority fields unchanged, and witnesses unchanged real authorizer plus original dispatch liveness before releasing the queue. It must fail on preserved940 source for the intended missing-fence assertion, then pass on the correction. Add benign alias/lastSeen/route-field controls that preserve the original authority and should still admit. No live re-pair, extra probe, grant change or broad suite is needed to demonstrate this bounded distinction. Freeze exact successor/source and targeted proof for independent review; do not retro-label940's35PASS as covering it.

### C2: repair derivation without rerun or rewritten originals

The defect is mechanically visible at collector118:

```js
name: unescape(/name="([^"]*)"/.exec(match[1])[1])
```

The first matching substring occurs in `classname`. Independent proper XML parsing finds the real full test names in all three archived final/mutant XMLs; statuses and classes align in order with their manifest rows, but **110 final +31 queue-mutant +44 postauthorization-mutant =185 names** differ. The companion verification preserves each actual/manifest mismatch and all real cases/failures.

Publish a corrected derived case list/manifest and collector with exact attribute matching or a proper XML parser, bound to the unchanged raw XML hashes. Preserve the old0da manifest/collector and identify it as the historical metadata defect. No test/compiler/CI rerun, raw XML rewriting or retroactive re-sealing is necessary for this correction. Independent review can still credit actual XML/raw outcomes below; incorrect derived names are not additional executed coverage.

## Source boundary assessment apart from C1

### Native server original request and result

The guarded reverse route captures a copied original principal, original TLS server/generation and request before body reading, then uses the original `reverseRequestLive(req)` signal/link/deadline closure. It does not use requester-side client readiness or an accepted-link epoch. Retirement latches once observed. Native direct retains its original pre/post `requireMtls`/membership checks; the reverse path passes an optional pure check to the host and deliberately does **not** overwrite a successfully admitted domain result with a new post-save403/400. Existing control-layer wire authorization remains in place. Body caps, native route selection, control cache/protocol/limits are unchanged. C1 is the missing part of that original trust capture.

### Queue and postauthorization decisions

The same optional `HandoffReceiveGuard` propagates through coordinator receive/applyCancellation to the actual service queues. Guards precede current/existing/no-op offer and cancelled-offer decisions and cancellation mutation. Landed inside-queue snapshot guard is reused, including older prefixes. Synchronous terminal snapshot ACK and terminal cancellation decisions have explicit checks; no queued guard is replaced by a caller-only check.

Both new-offer authorization calls now use `try { await admitIncomingOffer(...) } finally { beforeAdopt?.(record) }`, so the final check runs on allowed **and** typed-refusal branches before a stale `HandoffOfferRefused` can be converted to a receiver-authored refusal. Fresh-offer policy is captured only when the service passes a new-offer record; existing known history/cancellation passes no record and preserves its permission exceptions.

Host `incomingOfferPolicy` captures existing config generation, incoming setting, relevant Dispatcher/receiver/connection state and listens to existing connection/Dispatcher changes. It is a negative fence around the complete original positive admission, not a grant. The docs explicitly do not claim every unobserved settings revoke/restore interval is detected. No remote/new grant collection, worker/apply policy or acceptance behavior is changed.

### Actual incoming lifetime and committed truth

A guarded `receiveNetworkHandoff` creates and registers its owner before awaiting actual coordinator work; the `try/finally` releases only when that real promise (including queues/save/normal committed-history callback) settles. Legacy optional-guard callers keep defaults. Stop closes admissions and drains both incoming and existing reverse owners; replacement also tests both sets. A rejected incoming writer does not resolve success to its handler, and the owner's settled promise still permits complete draining.

No new deadline race or RPC/cache waiter replaces domain ownership. An admitted save may finish and publish its matching committed result after retirement; guard placement does not manufacture rollback. Notifications remain normal retained committed history, without a fake final-sink transport/provider guarantee. Expiry/prune are explicitly separately admitted local maintenance under this owner; coordinator rechecks before the incoming message afterwards, and the proof permits a legitimate independent expiry while refusing that message.

The existing outgoing sync owner and its still-running POST/negative-listener lifetime are unchanged. The new mixed-case proof correctly distinguishes an ended outgoing sync (no possible future local adoption) from an incoming domain promise that can still complete a save; no accepted owner class was silently “fixed.” This is normal scoped host stop, not a global server/app/local-writer/worker drain.

## Actual coverage and limits independently established

Proper parsing of final14 XML gives **35PASS /0FAIL /75SKIP** across four files: actual native13, service8, coordinator8, host6. The skipped75 are explicitly not newly executed3777/direct/legacy acceptance. Complete changed fixtures are typed; ordinary later hosted checks remain separate. Raw/XML content and source are bound by preserved owner launch/content observations; after-execution hashes are not atomic per-read execution seals.

| Boundary | Credited actual observation |
|---|---|
| Old-source baseline03 | Atc06ba, all four production blobs match70eff. Its separately frozen five-case fixture produced3PASS/2FAIL: retired queued offer still committed; normal stop permitted replacement while admitted save was held. First setup attempts01/02 have no boundary credit. Baseline fixture is its own after-execution identity, not falsely claimed as the final13-case fixture. |
| Native current/retired queue | Real native route/router/control dispatch, TLS/pins, unchanged real authorizer implementation and actual stores. Receiver outbound readiness is false; neither desktop client runs. A held original queue refuses after actual link replacement while unrelated fresh work succeeds. Current native positive and original native receiver-permission refusal controls pass. |
| RPC cancellation / admitted save | Actual cancel stops the waiting requester; an admitted actual rename can complete. Same-key retry waits/replays the completed result without a second coordinator invocation; changed digest gets existing409. Disk/committed memory and incoming registry agree. |
| RPC deadline | Actual native response deadline under **fake timeout timers** destroys response while save/slot/owner remain held. Late save can succeed but same-key replay is unavailable, not success or a rerun. Slot and incoming owner release after actual work. No wall-time/network-drain or durable exactly-once claim. |
| IO faults | Pre-real-rename EIO and injected error after actual rename are distinct. Both report bounded error and old instance memory; the latter may have newer disk. No guessed rollback or claimed successful adoption. |
| Stop/replacement | Actual admitted save blocks replacement until settlement; queued work retires and new admissions refuse while draining, then a fresh eligible request works. Server-generation restart cannot adopt old queued work. Host mixed case retains an expired outgoing POST's listener until real settlement while the actual incoming writer still blocks stop. |
| Permission exceptions / no-ops | Native known history, existing cancellation/cancel-with-offer, newer/older snapshots and private queue/no-op controls preserve original policy exceptions. Synchronous ACK/cancel branch tests use synthetic guard transitions, not a new native TLS race. |
| Fresh policy | Private host controls hold the actual receiver lookup over mocked setting/connection change and connection revoke/restore, proving negative fence and cleanup. Service controls hold authorization for both successful and typed-refusal outcomes. These are fixture-policy inputs, not a live saved-grant/MCP preparation flow. |
| Original trust | The real pin-mismatch and pairedAt-change cases pass, but they do **not** cover pairingId-only continuity; C1 remains. |

Queue mutant15: exact service source with only the three new queued guards removed. Independently reconstructed bytes match its recorded hash/blob. Actual XML gives **3FAIL/1PASS/27SKIP**; the three failures are unexpected resolution of existing-offer, terminal-cancelled-offer and cancellation decisions rather than the required retirement rejection. Its retained-history exception control still passes.

Postauthorization mutant16: exact service source with only the two final `try/finally` guards removed, reconstructed hash/blob verified. Actual XML gives **4FAIL/1PASS/39SKIP**: allowed offer/cancelled-offer unexpectedly resolve; denied variants return `HandoffOfferRefused` instead of original retirement. The native current-positive control passes. Each exact failure name is a passing selected final14 case; assertions after the mutant failures remain uncredited. These mutants prove their particular placements, not C1 or all individual lifecycle predicates.

## Compiler and lint: actual independent dispositions

Types13 actual gate **rc0 /0diagnostics**,3960 ordered input names. Independently matched the full raw list to its archived input records, all four complete changed test roots, and **2472 tracked input content hashes** to immutable940 Git blobs. The remaining1488 dependency hashes are owner after-execution observations. The config adds only explicit files and inherits the unchanged root target/options/includes/excludes. **2469 parsed roots includes the four explicit changed fixtures plus2465 production roots**; it is not2469 production roots plus tests. No reduced mock graph, prior54FAIL/FAIL139/FAIL1 transfer or compiler-executable/read-trace seal is asserted.

Lint12 actual eight-file result is **0errors/71warnings**, not zero warnings. Independently reconstructed the native-server zero-context line mapping; all71 original-server lint11 warnings match candidate rule/severity/full message/columns/end columns and mapped original source lines/multiplicity. No warning intersects a changed hunk, and source line bytes agree. This supports “71 mapped baseline native-server warnings” within this scope. Whole-repository160-warning baseline remains unmeasured. Normalized comparison SHA256 `eefbfc214975147e91301601998c789fd4ef03b01fa0ec9fb8e736ae3977483f` is preserved in verification.

Original05 host witness/assertion failures,06/07 correction results,08's three typing failures,09 intermediate typing result,10's four synchronous-read lint errors,04 resource refusal (NOT RUN), setup01/02 including the original cleanup warning, and failed collector17 attribution/source remain preserved. Collector17's raw tool stderr is accurately not claimed as an archived raw artifact. Corrected packaging did not rerun executable checks. C2 is an additional independently discovered derivation defect in that otherwise intact packet.

## Required bounded successor / preservation

Keep940/0da/c06 immutable. Correct only the original canonical pairing capture and focused matched pairingId-only/benign-field proof, plus C2's metadata derivation using archived raw XML. Use appropriate exact-source changed-risk checks and independent successor review; no broad3777/lower proof repetition, new helper, access change or live re-pair is requested. Until then this candidate is **not PR-ready**.

All106 test JSON files/1,547,788bytes, including103 canonical mobile files/1,529,625bytes, remain base-identical.59 protected and87 lower/sync evidence inputs match. Lower74d and synchronization6f15 acceptances remain exact identity reuse, not execution here;81937 bytes remain a transport envelope,614417-byte lower content proof adds no native application/producer/apply/wake acceptance.

The native setup uses synthetic offer metadata, fixture Dispatcher availability/absent runtime and isolated inputs. TLS/native router/real authorizer/store execution does not prove approved MCP producer/preparation/grants, real worker/content-through-coordinator/apply/wake/provider/human gates, two physical hosts or full handoff/duplex. No new CI, release, activation or merge approval follows.

Private Q5 workspace remains clean at `079a257acf38b168b529fb7745dae97f686b72b8`, tree `89e942aabd42c8ec93fe47794f2eef95b0b61980`, branch `auto-reset-policy-design/q5-framed-root-journal-wip`. Original Details/Naming WIP and named identities are untouched. Only this immutable report and independent verification are published to a separate remote QA branch through gh.
