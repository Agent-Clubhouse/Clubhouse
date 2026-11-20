# Reset-aware Auto: remotely preserved implementation

Status: production feature source implemented and pushed; owner validation passed. Independent exact-head review is pending. No PR exists yet. No live settings activation, migration, provider experiments, merge or release occurred. Source ownership remains with `auto-reset-policy-design` through Clubhouse-Orchestrator until a verified receiver fetches this exact SHA and explicitly accepts this scope. Sender delivery alone is not transfer.

Repository: `https://github.com/Agent-Clubhouse/Clubhouse`

| State | Ref / exact identity |
| --- | --- |
| Code branch and upstream | `auto-reset-policy-design/implement-reset-aware-auto` / `origin/auto-reset-policy-design/implement-reset-aware-auto` |
| Frozen code commit | `f7be061e73006cf094403dbc0e8b2739087d3e67` |
| Frozen code tree | `9eb1ae175523d98110af907478f821a405e37c62` |
| Evidence branch | `auto-reset-policy-design/reset-aware-auto-evidence` |
| Approved design predecessor | `f386b143fda60d969c705dcb397c9458b6ae0035` on `auto-reset-policy-design/reset-aware-reserves` |
| Original research / standby | `2bafbbbd13ac832aa6b323cd813cd8412f32ac79` on `auto-reset-policy-design/standby` |
| Issue / PR | No new issue or PR created. Internal parent task `t_mwojop1n`; independent review must precede PR creation |

The evidence branch has the same implementation source plus these notes/receipts; its evidence-only commit is not a new production head. Review, changes and any eventual PR should target the code branch, not merge the evidence branch. No branch was force-pushed, reset or deleted.

## Decisions and scope

User selected opt-in reset-aware Auto, usable weekly budget within48h with stronger24h priority, explicit provider reserves initially10%, no automatic reserve relaxation, preserved saved Copilot last-resort allowance and cold routing with fresh complete quota. Absent/off policy keeps legacy selection. Reserves belong to each shared provider-local login across orchestrators; they are admission ceilings, not physically enforceable balances against running/outside activity. No new rate-history collection/probes or advertised pace estimate. Known short/model/provider limits and qualified aggregate forecasts constrain admission. Unknown Copilot never receives a numeric capacity score.

Implemented shared closed schema, settings/pending-restriction composition and committed loosening, pure selector/AR1 ties, existing-lock integration, UI, optional mobile contract fields, local-only receipts/audit and focused tests/docs. Future/malformed stored policy stays preserved/fail-closed through unrelated writes. Budget-only writes preserve mapping identities, old partial updates and explicit/already-resolved plans. No agent-config/remote-card edits or provider/grant changes. [Implementation guide](../../helper-auto-reset-implementation.md) describes behavior and deferred measurement/epoch-completion limits.

## Actual evidence

All final receipts under [f7be061e7](f7be061e7/manifest.json) bind the clean code head/tree above and42 source hashes before/after the admitted command, exact argv, exit code and raw output SHA-256. They show `sealValid:true`, `passed:true`, `exitCode:0`. These are owner before/after seals, not continuous monitoring or independent approval.

- Feature checks:990 passed /15 files, maxWorkers2, 2026-11-20T08:49:46Z–08:49:50Z. Production policy, legacy replay, quota/aggregate pressure, routing, real persistence races, schema, UI, mobile parser and local telemetry.
- Full root `tsc --noEmit --project tsconfig.json`: passed at08:49:56Z–08:50:05Z, existing ES2020 target/config. Root test exclusions remain as configured; no claim of a whole test-source typecheck.
- Routing protocol profile:4 passed /64 intentionally unselected,08:52:02Z–08:52:11Z. Only eight routing fixtures checked; no claim of running every unrelated Annex test.
- Changed-source lint:0 errors, existing warnings,08:52:51Z–08:52:52Z.

Original c29 wrapper failed before launching tests due to a nonexistent source-manifest path; raw failure is retained as `predecessor-wrapper-failure.txt`. f7 differs only by that manifest correction, not production logic/tests. Earlier development checks included811 passed/10 failed: version3 expectations, incomplete new quota mocks and two UI timing assertions; corrected batch204 passed. An earlier root compiler found two implementation typing errors, then passed after correction; original compiler failure is retained. Gate75 refusals and>=60s spacing are preserved. Historical design receipts remain labeled with their original scoped/unsealed limits, not transferred as implementation proof.

Checks used the existing byte-matched lock cache (`bd9cc80304b81d317f2ffb295d9af5abbc484bf8efb64fc8d7f118e1288c212d`) through reversible per-package worktree-local links. Shared `.vite`/`.cache` directories were excluded. The original dependency layout has been restored. No install, lockfile/shared-cache modification or dependency symlink transfer is required or authorized by these notes. On another host, use its existing verified matching dependencies and applicable resource gate; do not assume sender paths or install to bypass a missing environment.

## Next actions and real gates

1. Independently review exact f7, particularly pending restrictions/failed/stale writes, complete/reset evidence, forecast coverage/tie ordering, reserved schema preservation and normalized protocol fixtures. Do not repeat990 tests/tsc merely to acknowledge receipt. Changes/failures/remaining concerns justify new risk-targeted checks on a new exact head.
2. Resolve any review findings, with coherent successor commits on the code branch. Preserve predecessor receipts honestly. After independent approval, prepare/create the PR within the existing assignment; CI and repository landing gates remain. No merge/release/live rollout is authorized here; the public release hold remains.
3. For ownership transfer, the verified coordination path is parent→Navi→Tael→Mini `desktopbp83o0`; there is no direct sender wire/grant. Fetch the advertised code and evidence refs, verify exact code SHA/tree, inspect these notes and receipts, and explicitly return acceptance quoting SHA, scope, observed validation and remaining gates. Until actual fetch plus that acceptance, the source retains ownership; do not begin duplicate implementation work. Do not use Clubhouse worktree-Handoff APIs or alter access/re-pair/restart settings.

All essential source, tests, documentation, current receipts and usable continuation state are in normal remote branches. Laptop-only ignored caches and redundant historical raw logs are not essential state. No secrets, credentials, private runtime captures or live provider data are included.
