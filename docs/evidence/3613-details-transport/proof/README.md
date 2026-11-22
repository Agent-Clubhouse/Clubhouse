# Frozen Details transport/currentness candidate

**Source `b1f2ce9b1b360f1ca0fedc2b93af53d67c158a58` is not independently reviewed or accepted.** Final focused execution is95PASS/0FAIL/327SKIP and scoped lint is0errors/160warnings. The actual changed-test/full-production compiler still **FAIL54**, exactly matching its separately executed test-only baseline after legitimate diagnostic line mapping. That new54FAIL disposition requires independent review; previous139FAIL and1FAIL dispositions do not transfer. No compilerPASS, PR, hosted, full-duplex or release acceptance is inferred.

## Identity and mapped ownership

The candidate starts from landed main `edcd915763a2ec73f0e8149917b4683ced06ecd6`, still the actual main returned by the saved fresh API guard. The original complete client bytes match authorized map `db46fc6eae9ecd1153dbb9c97b816f002ba5ad86`. Source changes are only `src/main/services/annex-client.ts`, its existing test file, and `docs/annex-reverse-routes.md`; remaining changes are evidence. The separate test-only source `61e64c099b05ccfc663adbe5432f46faa2909359` and original9FAIL packet remain immutable at `f4688dfeed2181bc0dc3522ddb0ab5966d00e349`.

The two new production helpers are private and fully in review scope:

- `captureDetailsRead` returns the original request's currentness closure. It captures satellite identity, selected direct/reverse route, socket, stream including absence, connection generation, pinned trust, role/kind/pending state, and reverse accepted-link epoch/readiness revision before any await. The same closure is checked before send, after await and on failure; it does not recapture a replacement. Raw-connected legacy direct admission is retained, including no-socket fixtures and a closing socket before its close callback. SocketOPEN remains a positive-snapshot guard, not a new GET permission.
- `snapshotAdmissionCurrent` checks an owned current `snapshotAccepted` stream, compatible nonpaused snapshot, pairing/unavailable exclusions and directOPEN. Only the existing accepted snapshot callback uses `randomUUID` to mint this receipt; export is a pure guard over an existing local receipt. Request replies, readiness, cache, serialization, resume and wire receipts cannot mint or refresh it.

Other production hunks are the existing receipt comment, public receipt export, accepted-snapshot mint, and four mapped reader admission/currentness seams. The role reader's existing receipt equality stays. Ordinary AgentDetails uses its old receipt only for exact-old denial targeting: a newer same-stream snapshot does not alone reject its200 body; late403 cannot revoke the newer receipt.

`protected-final-source-original.json` verifies12 exact byte-equal boundaries: production imports; shared route/trust/stream-retirement; common request routing/fences; Settings target/status/DTO; role query/copy, URL/status/page binding; protected agent query/URL and complete body/page/source/selection validation; Changes query/URL/status/DTO; exact-old O1 invalidation; and snapshot compatibility/sequence/assignment prefix. Selected-board import, query-copy/URL, insertion-after-inventory-binding and all validators are protected, not transferred. This is not whole-function clearance or proof that future WIP composition is conflict-free. No producer/DTO/renderer/Naming, shared fence/retirement, phone/wire, permission/grant, tunnel, install, deletion or restart work is included.

## Original execution ledger

All checks use the normal `desktop-test-gate.sh lane-p2`, minimum4 for tests/lint and6 for compiler. Vitest uses one worker. Originals are stored unchanged, with lossless gzip where indicated by the manifest.

| Attempt | Actual source/scope | Outcome |
| --- | --- | --- |
| 01, separate baseline packet |61e test-only, landed production; nine reader/receipt gaps |9FAIL/0PASS/372SKIP, exit1 |
| 02 |bdc initial implementation; selected reverse/direct/O1/page cases |94PASS/0FAIL/327SKIP |
| 03 |bdc compiler request |REFUSED slot held by lane-p2, exit75; no compiler execution |
| 04 |bdc scoped source/test lint |PASS,0errors/160warnings |
| 05 |bdc actual changed-test plus full production compiler, retry after at least60s |FAIL58, exit2: four introduced fixture diagnostics plus54 legacy |
| 06 |b1 corrected source/test, same actual compiler graph |FAIL54, exit2 |
| 07 |61e clean temporary baseline checkout, identical compiler/config/cwd; restored b1 afterward |FAIL54, exit2 |
| 08 |Readiness-only outer-currentness mutant; existing inner lease and role equality retained |13FAIL/0PASS/409SKIP |
| 09 |Request-readiness-as-snapshot-admission mutant |2FAIL/0PASS/420SKIP |
| 10 |Wire-receipt adoption mutant |1FAIL/0PASS/421SKIP |
| 11 |Incorrect direct metadataOPEN requirement mutant |1FAIL/0PASS/421SKIP |
| 12 |Incorrect ordinary Details receipt-equality mutant |2FAIL/0PASS/420SKIP |
| 13 |Exactly byte-restored b1 source/test |95PASS/0FAIL/327SKIP |
| 14 |Exactly restored b1 scoped source/test lint |PASS,0errors/160warnings |

The final95 named passes comprise49 new reverse cases, one legacy closing-metadata control and45 existing direct/receipt/page controls. All nine original failing case names and all19 mutant failing case names now pass. Mutant failures are semantic primary assertions, not timeouts. Assertions after each original failure remain unexecuted and are not credited. The final positive execution reaches the original endpoint/count/caller-cap and forged/localUUID/export assertions.

Held live-signal tests distinguish outer currentness from the unchanged inner reverse lease: all four readers reject replacement satellites, newly owned streams after captured absence on the same epoch/generation, and stream retirement/generation withdrawal while the accepted request link stays live. Separate held valid-body tests cover stop/disconnect/forget, pin/full typed PeerTrust, role/kind/pending, link epoch, pairing, client/network disable and eligibility-return ABA. Snapshot/O1 tests cover request-only200 no-mint, local UUID, forged/old/replaced/incompatible/paused/failed snapshots, no cache/resume/request restoration, public withdrawal during owned close, exact-old denial and role-versus-ordinary equality.

Public close/publication observations cannot directly inspect hidden raw state. The synchronous raw `stream`/`snapshotReceipt` clear-before-close/disposal ordering is separately retained byte-identically and remains an independent source-review obligation. Adapter readiness/request/subscription are mocked in these client tests; no new actual target dispatch, hosted transport or full-duplex claim is made.

## Actual compiler failure and complete comparison

The private configuration extends the unchanged root `tsconfig.json` and explicitly adds the actual `annex-client.test.ts` in `files`; original production roots/options/excludes remain. No root-excludes-test proxy, reduced clean graph, flag/library relaxation, cast or unrelated fixture repair is used. Standard command:

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 6 -- npx tsc --noEmit --pretty false --listFiles --project node_modules/.cache/details-transport/fixture-types.json
```

The first actual58-diagnostic run is preserved. Its three introduced `Array.at` uses were replaced with indexed owned reads; its wrong string-valued trust mock now returns the actual complete typed `PeerTrust` object. A direct metadataOPEN restriction was also removed to preserve legacy behavior, with a meaningful negative control.

The corrected and baseline compilers each list the same3956 ordered inputs, including the actual changed fixture and production client. The two mutable source files have actual pre-run baseline hashes verified against immutable61e Git bytes. The other3954 input hashes are identical in candidate-before-baseline and restored-after-baseline observations. No per-read filesystem trace is claimed. Full diagnostic file/message/code/column/multiplicity equality is established by byte-equal unchanged source lines and saved zero-context Git hunk mapping, not counts alone. All54 residual diagnostics are legacy TS2550 `Array.at` library declarations; zero observed changed-hunk diagnostics remain.

Both complete checks still fail. `fixture-types-comparison-original.json` is evidence for a requested new nonregression disposition, not approval or compilerPASS. Baseline lint totals are unmeasured: the observed160 warnings are not claimed to be a measured warning nonregression.

## Exact commands, fixtures and limits

Every executed command/selector is in its original input/START log. The final combined selector is preserved in `13-restored-final-input-original.json`, with the original one-file main-project Vitest invocation; scope lint is `npx eslint src/main/services/annex-client.ts src/main/services/annex-client.test.ts`. Observed tools: Node24.22.1, TypeScript5.9.3, Vitest4.1.12, ESLint9.39.5.

All **106 current tracked JSON fixtures /1,547,788 raw bytes** under `test/fixtures` are identical across immutable landed base, source and worktree. This is a read/hash comparison, not phone-test replay. The first metadata probe wrongly asserted a historical103 count; its original failure receipt and corrected complete inspection remain preserved, with zero actual raw mismatches and no fixture edits.

The restoration preflight printed “reviewed candidate” incorrectly: it verified local byte equality only. Independent source review remains pending. No broad local suite/E2E, prior Gitdiff rerun, root compiler proxy, manual dispatch, same-head hosted rerun or protected/default push was performed for this candidate.
