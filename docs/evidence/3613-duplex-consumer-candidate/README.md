# Remaining duplex-consumer checkpoint: not accepted

Base: `c43ffb37d20650c542e449a8a04a9fd84e65b655`.
Test-only negative controls: `ff4a0949c933da4c4d4cec35ac67c00f89211876`.
Frozen source: `41354e82025320809b4a8bc954b7053a4f05c33e`,
tree `8f47585f68ccf9356be0d984a3780de2b9bc3d26`.
Branch: `feat/3613-p7w-remaining-consumers`.

This is an initial common-request/owned-stream implementation checkpoint, not
full P7w/P8, current-app, security, phone or release acceptance. The
[current-main map](../3613-duplex-current-c43/README.md) remains the capability
and separate-gate inventory. No source push, PR or merge accompanies this record.

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

Pending: independent exact-delta review; a bounded real paired one-forward /
reverse-direct-blocked request/subscription/bytes/cleanup fixture; owner
concurrence for Details read/positive-receipt integration; meaningful sequential
mutation/restoration evidence for this source; #3714's separate narrow security
review; #3711's separate explicit closure; current-app/P8 confinement, process
cleanup and end-to-end acceptance. No historical proof transfers to these gates.
