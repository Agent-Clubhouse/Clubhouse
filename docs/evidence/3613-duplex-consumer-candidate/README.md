# Remaining duplex-consumer checkpoint: not accepted

Base: `c43ffb37d20650c542e449a8a04a9fd84e65b655`.
Test-only negative controls: `ff4a0949c933da4c4d4cec35ac67c00f89211876`.
Frozen source: `41354e82025320809b4a8bc954b7053a4f05c33e`,
tree `8f47585f68ccf9356be0d984a3780de2b9bc3d26`.
Branch: `feat/3613-p7w-remaining-consumers`.

This is an initial common-request/owned-stream implementation checkpoint, not
full P7w/P8, current-app, security, phone or release acceptance. The
[current-main map](../3613-duplex-current-c43/README.md) remains the capability
and separate-gate inventory. The initial checkpoint was subsequently authorized,
pushed and read back at `99083ca0d44930fa7e2287c9d824cb4042ed9b50`.
No PR or merge accompanies this record.

## Finite paired consumer delivery

Smallest usable behavior: an existing remote-project consumer can receive its
compatible snapshot, fetch binary icons and read current text files through one
accepted reverse control connection, while retiring its owned stream, pending
read and headless display handle on stop. Details, handoff workflows, phone and
other feature closures are not part of this acceptance request.

Paired fixture source: `6039da94c3385f5c8f2371d7b2ffa180113113aa`,
tree `a5b2f61ba8c0a0cfa2281d2bf19900a4c29a9868`.
Final fixture-only lint correction: `6d7aec19dbc11489633a0a3d52629e41341c6548`,
tree `3196f2477ddfe3224d324e69b1cff85c70a52ad1`.
The initial production blobs remain byte-identical to `41354e820…`.

`test/annex-v2/annex-reverse-consumers.test.ts` uses two isolated desktop module
contexts in one Node worker, real generated identities and the existing pinned
TLS/P1 authorizer/control code. A has no listener. B's saved direct hint names an
actual closed port, checked for `ECONNREFUSED` after the two owned live listeners
have acquired different ports. The single usable forward preserves TLS bytes.
Target route/subscription stores are fixtures, not the app's real handler,
grant, filesystem-confinement or native shell boundary.

The observed paired result is 81,937 all-byte-values bytes with SHA256
`f7da8be077ec14d7c37a9e717948bedebdc1b9e4ec14cde538646611e18b643b`,
a 68-byte PNG through the actual icon adapter, one `/control` upgrade, no ordinary
HTTP, and one common request. The large envelope uses an existing handoff-shaped
fixture route solely to exercise bulk transport; it does **not** establish real
handoff offer/grant/manifest acceptance. The actual text-file adapter also returns
the complete UTF-8 text.

Before fixture-forced network teardown, the consumer stop leaves zero target
subscriptions and in-flight reads, an aborted pending-read signal, no owned
headless handle and zero late IPC; the independently accepted control link stays
ready. Separately, fixture teardown observes zero forward/server sockets and
both listeners stopped. There are no Electron/native-PTY/process-tree or firewall
claims.

| Attempt | Exact attribution and actual result |
|---|---|
| mutant-stream-sequence-17 | One genuine assertion failure: replacement sequence stayed 50 instead of 1 |
| real-pair-18 | Pre-freeze WIP pair passed; not final-source proof |
| pair-fixture-types-19 | Five actual new-fixture typing diagnostics retained; proper empty tuple, refusal guard, Duplex ownership and existing IconSnapshot view resolve them |
| pair-fixture-types-20 / pair-eslint-21 | WIP complete fixture types and strict new-file lint passed |
| frozen-real-pair-22 | Exact clean 6039 paired source passed with emitted byte/cleanup measurements |
| mutant-real-owned-close-23 | Real target subscription leaked: one instead of zero **before** forced fixture teardown |
| mutant-stream-dedup-24 | Same-epoch refusal caused two subscriptions instead of one |
| restored-five-files-25 | Exact clean restored 6039: 610 passed, five files, both projects, at most two workers |
| restored-production-types-26 / restored-fixture-types-27 | Exact 6039 production and complete fixture types passed, min6 |
| restored-eslint-baseline-28 | Exact 6039 unchanged production/test lint inputs: zero errors, 160 versus 161 existing warnings, no introduced diagnostics |
| restored-pair-eslint-29 | Actual final-chain failure: one `no-unsafe-finally` error in the new fixture |
| final-pair-30 / final-fixture-types-31 / final-pair-eslint-32 | Exact clean 6d7: paired test passed with the same measurements; complete fixture types min6 passed; strict new-file lint min4 had zero errors/warnings |

The three mutants ran sequentially and were restored. The restored source guard
and five-file execution bind the original production bytes again:
`annex-client.ts` SHA256
`81ec2f07313ad58f6bd7aae4297ac3eee842ca8b71b3c731f23fdcb3f4c14833`.
The final correction is only +8/-9 fixture lines: validate and capture listener
identities on the successful test path, then emit their observed teardown state
without an explicit throw in `finally`. All other 6039 inputs are unchanged;
the corrected fixture alone was re-executed, typed and linted. The 610-case
execution is credited to 6039, not relabeled as execution of 6d7.

The command receipts bind the tracked paired fixture through their immutable
HEAD/tree plus clean status/diff seals; the original fixed SHA256 input list did
not separately list that newly tracked fixture. Originals are retained, not
retroactively augmented. No broader regression or phone command was repeated
after the fixture-only correction; production/phone inputs remain unchanged.
The [paired manifest](paired-manifest.json) records each original/receipt hash,
actual executed revision and the fixture-only source bridge. Attempts 17–32 add
32 byte-verified archive files without overwriting attempts 01–16.

## Exact source execution

All commands below ran sequentially through the ordinary `lane-p2` gate, with
clean exact source `41354e820…` and unchanged before/after source and gate seals.
Each original and structured per-command receipt is in `attempts/`.

| Attempt | Command | Minimum | Actual result |
|---|---|---|---|
| frozen-tests-12 | `npm test -- --project main src/main/services/annex-client.test.ts src/main/services/annex-client-buffer.test.ts src/main/services/annex-control.test.ts src/main/services/annex-devices.test.ts --maxWorkers=2` | 4 GiB | 609 passed, four files |
| frozen-production-types-13 | `npm run typecheck` | 6 GiB | PASS, no diagnostics |
| frozen-fixture-types-14 | `npx --no-install tsc --noEmit -p docs/annex-reverse-routes.tsconfig.json` | 6 GiB | PASS, including the complete buffer fixture |
| frozen-eslint-15 | `node docs/evidence/3613-duplex-consumer-candidate/lint-baseline.mjs` | 4 GiB | PASS: zero errors, 160 warnings versus 161 on c43, zero introduced diagnostics |
| frozen-phone-check-16 | `npm run fixtures:annex-mobile -- --check` | 4 GiB | 68 passed, one file; no fixture rewrite |

The lint check uses the installed ESLint and unchanged c43 policy/dependency
inputs on both actual source texts. It maps unchanged diagnostic lines across
the zero-context Git diff and rejects new diagnostics, not just a warning-count
increase. Existing warnings were not fixed, disabled or claimed absent.

A separate read-only byte comparison found all 103 canonical files under
`test/fixtures/annex-mobile/`, totaling 1,529,625 bytes, identical to c43.
SHA256 over sorted `path + NUL + raw bytes`:
`fe5cb5a60c0acae34d4bd76a370b39779e4ed9c7bf3885cfe15982e39904cdaa`.
This is fixture integrity, not new phone-feature acceptance.

## Preserved failures and dependency provenance

The receipts identify clean heads or, for pre-freeze WIP, the actual status,
diff hash and input hashes. A WIP command is not execution of its HEAD alone.

| Attempt | Actual disposition |
|---|---|
| baseline-01 | Genuine unchanged-c43 production negative: 16 failures, one pass, 346 selector skips; no dependency/setup failure |
| candidate-02 | Initial WIP selector: 17 passed, 346 skips; not final-source proof |
| regression-03 | Ten actual failures, 599 passes: direct abort settlement, fixture connection ordering, pin-source prior-art assertion and the intentionally expanded common POST expectation |
| regression-04 | Corrected WIP: 609 passed; final-source execution remains separately recorded above |
| production-types-05 | Actual TS2307: missing worktree-local Azure exporter relative module |
| task-local-npm-ci-06 | Ordinary min6 admitted `npm ci`, successful; dependency restoration, not a product fix |
| production-types-07 | WIP production types passed after restoration |
| fixture-types-08 | Introduced TS7018 on the new replacement snapshot's empty projects array |
| fixture-types-09 | Contextually typed frame fixture passed; no `any` cast or exclusion |
| eslint-10 | Actual zero-warning-command failure: zero errors, 162 warnings, including two introduced catch-report diagnostics |
| eslint-baseline-11 | WIP after repository-standard explicit local-log/privacy exemptions: zero introduced diagnostics, zero errors, 160 versus 161 warnings |

Before installation, a separate read-only terminal check found only `.vite` in
the worktree-local `node_modules`; the ancestor exporter file existed, but the
unchanged Azure source imports a worktree-relative file. That terminal diagnosis
is not a retained physical preinstall snapshot. No production source or manifest
was changed to work around the missing module.

The task-local install ran inside the isolated consumer worktree, not its
ancestor or another lane. Its original output and receipt preserve the normal
admission, exact command, source/gate seals and exit. Package and lock hashes
were identical before and after installation and after final execution:

- `package.json`: `02a5006fdd2b94506ec91db8db8e093bcafeaf0174ee08c0a563f459bc4ac7a9`
- `package-lock.json`: `bd9cc80304b81d317f2ffb295d9af5abbc484bf8efb64fc8d7f118e1288c212d`

The install's existing audit/script notices remain in its raw output. No audit
fix, script approval, manifest change or new permission was performed.

## Owned hunks and deferred gates

`annex-client.ts` changes the common request lease/seam, reverse specialized
read branches, owned stream reconciliation/retirement, snapshot sequence and
async icon/canvas stream guards, the public **state** projection, direct
retirement hooks, subscription send and client start/stop. Existing direct
`isMachineConnected` and connected-listener publication semantics are retained.
Direct fixture ordering and explicit common-POST assertions are updated only
where this behavior directly depends on them.

The alias/problem-label expressions, Details GET readers and positive snapshot
receipt branch are unchanged. Stream retirement clears an old receipt; reverse
snapshot consumption does not mint one. Naming's full-list label observer
remains held. There are no handler, server, control/protocol/bulk, grant, phone
contract or package/lock changes. Device changes only preserve direct versus
reverse reach observation when renderer consumer state is live over reverse.

The bounded paired and mutation milestones above supersede their initial
deferred status. This delivery awaits independent exact-delta review and ordinary
hosted CI/landing. Details owner concurrence, #3714 security, #3711 closure,
current-app/P8 confinement/process cleanup and end-to-end acceptance remain
separate unwaived gates, not blanket prerequisites for this useful read/stream
increment. No historical proof transfers to those gates.
