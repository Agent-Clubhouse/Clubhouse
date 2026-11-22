# Reverse handoff composed proof: bounded independent review

**Verdict: APPROVE the exact test/helper/docs proof at `a4074c7f5e76714bbe346ecee1acfc434307de0e`. No blocking finding in this delta.** This accepts the bounded composed fixture and its stated observations. It does not accept production handoff readiness, the actual host/coordinator/worker, saved grant leases, offer/accept/apply/wake, a real two-host application flow, or full duplex.

**Delivery recommendation:** carry these four reviewed files with a coherent, independently reviewed subsequent host-readiness fix rather than run a standalone proof-only full CI matrix now. The proof is useful as-is and should stay preserved. The next fix needs actual coordinator/host coverage and its own exact-source review; this approval is not approval of an unseen Boolean/readiness replacement. If assembly changes this fixture, config, imports or its dependencies, describe the identity bridge and target the changed risk rather than transfer old execution wholesale.

## Exact source and evidence

| Object | Immutable identity |
|---|---|
| Base | `c2a59f9f2c872bf2cb1fe9852adf8c92f2a996fc` |
| Source | `a4074c7f5e76714bbe346ecee1acfc434307de0e` |
| Source tree | `2281eb788e825e12c2e3b70b160b4c50863a7e36` |
| Evidence | `be01f8bd511dba2a625462021732c119ce6b170e` |
| Evidence tree | `c3d505fe7dc91178fd58e103f54276982502c115` |
| Observed pushed branch | `lane-3613-p2-routes/reverse-handoff-proof` → exact evidence head above |

Read the full [owner receipt](https://github.com/Agent-Clubhouse/Clubhouse/blob/be01f8bd511dba2a625462021732c119ce6b170e/docs/evidence/3613-reverse-handoff/proof/README.md), SHA256 `467af273b56428cb848dfc54928a26f47b317a7278331b0f3ca4e5d9dc7b6c46`, and [manifest](https://github.com/Agent-Clubhouse/Clubhouse/blob/be01f8bd511dba2a625462021732c119ce6b170e/docs/evidence/3613-reverse-handoff/proof/manifest.json), SHA256 `112ec164d5cc61fbd77223c04bb9c7b18c3c5dc6e0422a327d00137fdb6b4c26`. Independently verified all **30** committed stored blobs, original/stored sizes and SHA256 values, including lossless gzip reconstruction and the exact source patch. GitHub readback through `gh` independently matches the pushed ref and both supplied trees. No source edit or test/compiler/lint/app/CI rerun by reviewer.

The source delta is exactly four paths: the new handoff fixture, extracted shared desktop helper, import/extraction-only consumer fixture change, and `docs/annex-reverse-routes.md`. No production/config/dependency/grant changes. The evidence commit adds its packet separately. The documentation preserves historical proof and correctly distinguishes the prior handoff-shaped envelope from actual supported operations and the Details54FAIL disposition from this distinct compiler graph.

## Extraction and source boundaries

The original consumer case body is byte-identical, including its final newline: raw SHA256 `11311bbb07ad2ac9723742726b3f22a6ecee54ab39cc68602effef33294ddb74`. The owner's `9d74bbe97ea016a9de13044a40af192b0823d73253603a5f366139c07ff3c8f7` is the same body after trimming terminal whitespace, which independently reproduces. The moved helper bodies, after removing only added `export` keywords and surrounding whitespace, equal the old bodies, SHA256 `eb666631946839dad0a3ae3e92ace2e689a70839c611526579227277f85ddf3f`. Module imports supply the same `net`, `vi` and type dependencies. No original consumer assertion, deadline, lifecycle or forwarding behavior was replaced.

The new fixture (`annex-reverse-handoff.test.ts:25–246`) creates two isolated module contexts, real identities/certificates and pinned control links through one byte-transparent TCP forward. The target uses actual `HandoffTransferSource`, default actual snapshot verification, real snapshot descriptors and actual reads. The requester uses actual `requestHandoffTransfer` → `postToMachine`, actual receiver, real staging writes/syncs and final verification. The opposite direct endpoint is probed and actually refuses TCP; each connection records `isMachineConnected === false`, accepted reverse readiness and `/control` upgrades only. Dispatch parses actual supported `manifest`/`read` requests and actual body encoding. This is stronger than the unchanged original consumer's custom `op: chunk` transport envelope.

The custom target dispatcher and its authorization dependencies remain fixtures. Accepted `Handoff` records (including empty fixture history), preparation lookup, sender/receiver agent-grant admission and snapshot subscription payload are supplied by the fixture. `HandoffTransferSourceOptions.authority` is not installed: actual `handoff-host.transferAuthority` grant/config/binding leases are not tested. No production route registration, coordinator, worker, Git selection/preparation, offer/accept transition, apply, wake, renderer or real human gate runs. Two contexts in one Node process are not two real application hosts. These are explicit boundaries, not a defect concealed by this approval.

## Observed cases and actual fences

Final raw log and JUnit independently agree on **6PASS / 0FAIL / 0SKIP**: five new cases plus the unchanged original consumer. Parsed all **32** runtime receipts afresh from the raw log and compared them byte-for-value to the supplied derived receipt JSON. Reconstructed all seven fixture manifests' canonical digests from the exact parser's object/key order, independently reproducing `3b8a71ecda0deba7d7948cda37f1add54f7cb55ba7a55dead05a6c9a84107548`.

Every new case uses 614,417 bytes covering all byte values, SHA256 `0667d68f3d54649e11117d55ec5d2394f93f48d7ff1b0792212cf19b062225f2`.

| Case | Accepted observation and limit |
|---|---|
| Cut/resume (`:250–288`) | Actual receiver calls progress after `handle.sync()` (`handoff-transfer-receiver.ts:140–141`). The case verifies 262,144 on-disk bytes and exact prefix before closing the original control link; interruption retains the prefix. Explicit reconnect changes epoch1→2, immutable fixture agreement remains equal, and a separate explicit receiver invocation resumes reads at262144/524288. Final disk bytes, manifest and SHA match. This is a controlled socket cut after file sync, not a process/power-loss persistence experiment. |
| Sender retirement (`:290–308`) | Fixture accepted record becomes cancelled after first synced chunk; actual source record/state fence refuses the next read as `record_state`, only one content reply exists, receiving allocation is removed, and an unrelated agreement still completes on the eligible link. This is actual agreement-state retirement, not proof of saved grant revocation. |
| Chunk corruption (`:310–328`) | Fixture peer alters actual source output without matching its hash. Actual receiver rejects after one content reply and removes allocation. |
| Final digest corruption (`:310–328`) | Fixture alters all three chunks and gives matching new chunk hashes; actual final verification rejects the unchanged agreed whole-file hash. All three content replies are observed; allocation is removed. |
| Held original source read (`:330–372`) | Wrapper first performs the real descriptor read, then holds it (`:64–73`), before actual source `await assertCurrent()` (`handoff-transfer-source.ts:173–174`). Actual link loss aborts requester and invalidates original dispatch context. A new epoch completes an unrelated agreement while the old source operation remains held. Release reaches the original source fences; old content publications stay0, receiving file stays0, and the old artifact is closed before explicit receiver resume. The custom dispatch also checks its original context before publication, so this is composed fence proof; no standalone mutation-isolation claim for every individual fence. |

All five owned pair teardowns record sockets0 / in-flight dispatches0 / source artifacts0 / stopped server and forward listeners. Release hooks run before teardown waits; headless contexts are disposed and environment values restored in `finally`. Pair creation failure also invokes its owned disposal path. Ordinary HTTP remains0. “Published” is the fixture dispatch observation before returning a response, not TLS packet tracing or a renderer event. The unchanged original case independently retains its81,937-byte/68-byte transport/icon observations; those bytes are not relabeled as actual handoff operations.

No automatic receiver adoption across epochs is tested or inferred. The resume is explicit and retains the same agreement. The one `setImmediate` no-extra-request observation is bounded, not proof of indefinite absence of arbitrary future scheduled work. No new semantic mutants were run for this packet; original failures below are not substitutes for mutation coverage.

## Validation identity and honest failures

- Final06 compiler: normal gate START/END, **rc0**, no diagnostics, **3958 ordered raw file names**. The config adds only explicit `files` for the actual three changed test/helper paths and extends the unchanged root config; inherited ES2020/options/full production include remain intact. Each changed file appears exactly once.
- Independently matched all3958 ordered log paths to `final-compiler-inputs.json` after removing the identical recorded cwd prefix only; independently matched **2470 tracked captured content hashes** to immutable source Git blobs. The remaining1488 dependency hashes are owner observations measured after execution. This is not an atomic per-read filesystem/executable seal, and no independent compiler execution is claimed.
- Final07 scoped lint: gate rc0,0errors/0warnings on the three changed TypeScript paths.
- Final08 tests: normal gate `--maxWorkers=1 --no-file-parallelism`, rc0, exact6pass XML/raw receipts. Runs06/07/08 are serialized; no new refusal or bypass is hidden.
- Original01 is retained5PASS/1FAIL. Wrong module-context diagnostic WeakMap produced `unknown` instead of expected `record_state`; final code imports the target context's diagnostics and changes no production decision. Assertions after the original failing expectation are uncredited.
- Original03 is retained compiler **rc2 / one introduced TS2554**, missing `decodeControlBody` encoding argument. Final uses the captured request encoding. Intermediate02/04/05 do not attest the strengthened final held-read case.
- All106 tracked `test/fixtures/**/*.json` files,1,547,788 bytes, independently compare byte-identical base→source. Also verified the broader144-entry filename-selected identity artifact against the immutable base/source blobs;144 is not a phone/test execution count. No earlier Details54FAIL or other fixture/compiler result is transferred or reclassified.

## Separate next gap: host direct-only synchronization gate

**Confirmed source-derived reachability gap, not a reproduced live incident.** At this exact base/source, `handoff-host.ts:326` installs:

```ts
connected: (peer) => isNetworkComputer(peer) && annexClient.isMachineConnected(peer)
```

`annex-client.ts:909–912` checks only a direct satellite's `state === 'connected'`. `handoff-coordinator.ts:239` therefore returns before `markAttempted`/POST on reverse-only connectivity, and `:247` returns before reply parsing/adoption if only reverse is ready. Yet the actual transfer adapter reaches reverse via `postToMachine` (`handoff-transfer-transport.ts:26`, `annex-client.ts:2652–2671`). The proof deliberately calls that adapter directly and injects the accepted record, so it does **not** exercise or cure this host gate. Also, `startHandoffs` listens to direct satellite-connected events (`handoff-host.ts:444`, client`:876–892`); its existing30-second sweep remains distinct from an immediate reverse-ready wakeup. A new notification mechanism is not necessary to establish the Boolean reachability finding and is not approved here.

Before a concrete product delta is accepted:

1. Define a host-specific usable-route observation/lease matching the existing request selector, preserving direct preference and qualified accepted reverse request capability. Do not globally change `isMachineConnected` semantics for unrelated callers, infer readiness from cached snapshots/receipts, create connections, retry a failed request through a different route, or treat `hasReverseLink` alone as authorization.
2. Retain independent current network membership and each route's existing peer/pairing/pin/trust/settings authority; the reverse path also retains its desktop/not-pending/running/pause gates. Preserve existing direct admission rather than silently imposing reverse-only metadata requirements on it. `isNetworkComputer` itself is only a member/nonphone predicate (`annex-agent-calls.ts:169–173`); the reverse adapter's full running/settings/pause/trust/pairing/accepted-link readiness gates (`annex-client.ts:183–191`) cannot be dropped by a weaker new host predicate. No new grant or acceptance authority is conferred by transport availability.
3. Name where original route, peer/pin/trust, direct resource or accepted reverse epoch and lifecycle/revision are captured, then prove original-result currentness through outgoing authorization, transport and post-await reply adoption. Mere ready→false→ready under replacement must not validate old work. Existing `SatelliteRequestLease` captures trust/resource/epoch and checks before returning; coordinator's later awaited authorization/adoption boundary must be covered by the proposed contract rather than presumed from an earlier Boolean. An explicit reviewed lease design is still required; no unseen signature/implementation is approved.
4. Preserve outgoing offered-work grants/connections, `commands.markAttempted` before sending, response schema/id/version/extension checks, per-record synchronization and durable cancellation/history rules. The existing deliberate cancellation/status synchronization after authority withdrawal must not be accidentally disabled by conflating “new work authorized” with “can send retained cancellation.” Do not erase ambiguous prior attempts, silently recreate agreement history, or autoaccept/resume/apply/wake merely because reverse became usable.
5. Target proof at the actual host callback/coordinator/real request boundary: reverse-only offer/status/cancellation reachability, refusal before send when unqualified, held original reply across link/pin/trust/member/permission changes or replacement (including restored readiness), direct-path behavior, unrelated agreement liveness and owned cleanup. Keep actual saved-grant and human-gate omissions explicit if still fixture dependencies. The current614417-byte fixture remains valuable lower-layer coverage, not this missing integration evidence.

These are concrete obligations for the next bounded source/design/proof review, not a blocker to preserving or accepting this proof-only delta and not a blanket stop on ordinary engineering. Coherent batching with that fix should minimize repeated full-matrix PR cost. Ordinary fresh-main composition, independent exact review and hosted checks remain required before landing any assembled candidate.

## Preservation

This review adds only a remote report/verification task branch. Private Q5 branch `auto-reset-policy-design/q5-framed-root-journal-wip` remains clean at `079a257acf38b168b529fb7745dae97f686b72b8`, tree `89e942aabd42c8ec93fe47794f2eef95b0b61980`. Details owner's worktree and source are untouched. No product edit, extra test/CI, account/login/access change, install, restart, activation, merge or release was performed.
