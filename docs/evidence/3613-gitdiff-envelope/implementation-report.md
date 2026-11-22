# Existing GET Git diff finite envelope: source/proof freeze

**Implementation and bounded execution evidence, not acceptance.** Independent exact-source review and the full-fixture typing disposition remain pending. No PR, CI, landing, install, release, native Git/TLS-control/E2E or whole-duplex claim is made.

## Immutable bindings

- Base: `63f140b2a0ba00e686fb727a931d6b340fc3ee7e`, tree `040b9eb93b5dd769920564319f7f3e4becdf2b84`.
- Original test-only RED: `9eff428ebeb70c6b7d0996b6600713a50b4928ed`; frozen design `b7843d9889cd004098590a1aac5578518b19c788`, tree `014f75de3c78dc3969da8f3dd09eb4111bbaa24f`.
- Full DESIGN APPROVE: `3046c2cf93acbd16b92e07316216e0d593241835`, `docs/qa-transfer/2026-11-22/reports/gitdiff-envelope-b784-design-review.md`, blob `332bd26e6411bf363d0798b3e308798c6aae2a52`, SHA-256 `ab456ae06d42e0382ccb011cb6794f98a05dd32eb5f93f65615ae9e33a266dc3`.
- Final executable/test source: `fb21d4cca635ccdbb109acfb5f249ba291d00293`, tree `f73a613add940a39d9f0350f1ada6b77e2dd3b4b`. The containing evidence successor changes no selected source/configuration input.
- The original `manifest.json` is interpreted at immutable **b784 only**. It does not assert current README/helper hash equality. The D1 correction and implementation successor are separately bound by `implementation-manifest.json`.

## Exact production delta and resource boundary

Only `src/main/services/annex-control.ts` changes production. At final source: private 32 MiB constant at line483; explicit original GET/raw anchored matcher at486; original `pending.path,pending.method` in accept519 and rejectStart531; original `request.path,request.method` in target dispatch862.

The first rule is `^/api/v1/projects/[^/?#]+/git/diff(?:\?[^#]*)?$`, only with explicit `GET`, before all legacy query-sensitive regexes. Missing method is not GET. The limit is **33,554,432 encoded JSON bytes**, not each diff string. No decoding/normalization, metadata-derived path/method, caller-limit removal or arbitrary-size parity is introduced. All other methods/routes and no-bulk frame behavior retain their existing limits.

No server/client producer, ReverseResponse implementation, grant, pin, controlFence, lease, token/count/meta/direction/sequence/digest/credit, strict-read, wire/phone, fallback, timeout, retry, provider/login, Details/Naming/selected-board or removal/revocation implementation changes.

**D1:** cap+1 clipping is a logical subarray view retaining the full original backing allocation. Disk/string/JSON materialization precedes clipping; accepted chunks and finish concatenation retain/add complete copies. Four 32 MiB incoming transfers can hold 128 MiB of chunk bodies per lane; results, strings, target writes and other allocations are additional. The route cap is not a target/global RSS bound. Existing one-use 64 KiB credit, ownership, cancellation, active-run and idle controls remain.

## Executed proof and precise attribution

Every execution uses `~/.clubhouse/orch/desktop-test-gate.sh lane-p2 <minimum> -- ...`, Vitest `--project main --maxWorkers=2`, original default/JUnit output and before/after seals. No admission refusal occurred in this increment. Runtime: local darwin/Node v24.22.1, not Windows.

| Attempt | Executed source / minimum | Observed result |
|---|---|---|
| 01 | 9eff unchanged production /4 | Original boundary **2FAIL/5PASS/190SKIP**; 8,454,145-byte plain/query GET rejected. Post-failure full-byte assertions unexecuted. |
| 02 | 231cee748 /4 | **2FAIL/28PASS/1219SKIP**: unsupported HEAD fixture input and raw attach that did not close/replace its old link. Originals retained. |
| 03 | fd58d8774 /6 | **30PASS/1219SKIP**; root `npx tsc --noEmit` PASS; subsequent full actual fixture compiler **140 diagnostics /FAIL**. Chained lint did not run. |
| 04 | 50723d350 HEAD, only server test replaced with exact63f bytes /6 | Full actual fixture compiler **139 diagnostics /FAIL**; baseline server SHA-256 `d3c4fe6d3af68a4444e5157e7132bb6f382fc332a933f39421e6111bcbec1368`. |
| 05 | 50723d350 corrected async new project-store mock /6 | Actual target **3PASS/658SKIP**; four-file lint **0errors/391warnings, PASS**; full actual fixture compiler **139 diagnostics /FAIL**. |
| 07 | 50723d350 plus missing-predicate mutant /4 | Wrong selector: **0 executed/216SKIP**, rc0. **Zero proof credit.** Original retained. |
| 08 | Same isolated missing-predicate mutant, actual query selector /4 | **3FAIL/2PASS/211SKIP**. Original sibling/socket assertions execute before failed receipt checks. |
| 09 | 50723d350 plus original-method omission only at actual target dispatch /4 | Actual target **3FAIL/658SKIP**: truncated byte results and unexpected resolution above the intended cap. Original log/XML retained losslessly. |
| 10 | Exact restored50723d350 /4 | **19PASS/858SKIP**: five complete query receipts plus real target three sizes, fatal ownership/meta/pin/feature cases, rejected-token replay, file-read parity and legacy digest-bypass denial. |
| 11 | Final fb21d4cca /6 | Changed raw `/content` query now tests **exact32MiB**: **1PASS/215SKIP**, updated control-test lint **0errors/0warnings, PASS**; full actual fixture compiler **139 diagnostics /FAIL**. |
| 12 | fb21d4cca with GET rule moved below legacy content rule /4 | **1FAIL/215SKIP** at exact32MiB, discriminating the query-precedence boundary that old-cap+1 alone could not. |
| 13 | Exact restored final fb21d4cca /4 | **1PASS/215SKIP**: complete32MiB bytes/JSON, fresh request/subscription and open sockets for that raw query. |

The 30-case batch covers raw GET path/query/method negatives, old boundary full receipts, exact32MiB/+1, caller0/stricter/equal caps before credit, missing/non-GET method, one-chunk held cancellation/revocation/close-before-replacement cleanup and fresh work, no-bulk behavior, actual public `requestGitOperation('diff')` adapter and actual server dispatcher/ReverseResponse. Later executions recheck only corrected/strengthened fixtures and risk-specific controls, not an unchanged broad batch. Do not relabel fd58's 30PASS as an execution at final fb21.

The client test uses the actual public adapter and production control/authorizer/bulk with a fixture response handler, exact encoded project/file/staged query, complete JSON containing a 9 MiB modified string and no HTTPS fallback. The server test uses actual route dispatch/ReverseResponse and production paired bulk; **the Git/filesystem producer (`gitService.getFileDiff`) and existing server-suite dependency ports are mocked**, so it proves dispatch cap/body/argument behavior, not real Git/filesystem production. Control/adapter transport uses paired in-memory sockets, not TLS control frames.

Commands are retained verbatim in every `*-receipt.json`. Key selectors: `GET Git diff envelope` (03/05), actual complete-query selector (08), real target selector (09), the explicit six-part risk selector (10), and the single `query .*content` selector (11-13). Compilers use `npx tsc --noEmit` and `npx tsc --noEmit -p docs/evidence/3613-gitdiff-envelope/fixture-tsconfig.json`. Lint05 covers exactly the four changed TypeScript files; lint11 rechecks only the changed control test.

## Full-fixture failure retained, no inferred typing acceptance

Both actual three-test fixture compilers FAIL. `06-full-fixture-diagnostic-comparison.json` binds04 to05; `12-final-fixture-diagnostic-comparison.json` binds04 to final11. The comparator verifies original logs/seals, actual file bytes, gate/runtime/installed identities, all33 selected inputs, ancestor/head delta and every diagnostic's **full message, code, column, multiplicity and legitimate source-line mapping**, not counts alone.

All139 final diagnostics are inherited `annex-server.test.ts` diagnostics on unchanged source lines; **zero diagnostics in changed hunks or other changed files**. The only server insertions are import line2 and new test lines9997-10025. The final head delta from507 is only the strengthened control test. Baseline/candidate normalized complete diagnostic SHA-256:

`c21118378143baf04073845e8bec22c9e752e8a0e0e92853e5143e16403a4f84`

No unrelated fixture error was repaired and no compiler setting relaxed. The original bridge exposed an accidental edit to an older file-system mock before execution; its unexecuted artifact remains, and the final baseline-to-server diff has only the two owned insertions.

Root03 PASS is separate: fd58 to final source changes only `annex-control.test.ts` and `annex-server.test.ts`, both excluded by unchanged root `tsconfig.json`. Production/config/package inputs are identical. This is an explicit unchanged-production bridge, **not a claim that root tsc ran at fb21 or that a reduced graph substitutes for the failed actual server fixture**. Full-fixture typing acceptance is deferred to independent review.

## Preservation and finite next milestone

103 tracked `test/fixtures/annex-mobile` files, the phone route contract and shared control protocol are byte-identical to63f, with per-file bytes/hashes in `14-phone-wire-byte-identity.json`; none regenerated. Original01 artifacts remain byte-identical to b784.

Dispatch mutant09 produced large assertion output: exact original109,961,156-byte raw and110,084,893-byte XML are retained via deterministic lossless gzip, verified against original/decompressed SHA-256. `09-lossless-original-archive.json` binds both; private ignored uncompressed copies also remain. No original FAIL, empty-selector result or compiler residual is discarded or converted to PASS.

All mutation source changes are restored byte-for-byte. `implementation-manifest.json` binds actual receipts, source identities, raw/JUnit/archive hashes, protected bytes and proof limitations. Sealing covers selected inputs/installed identities, not an assertion of all-host/all-dependency immutability or global memory bounds.

**Next:** existing independent reviewer evaluates this exact source/evidence delta, including the residual full-fixture typing disposition. No PR/CI before that substantive verdict. Details transport/receipt continuation remains the next slice, protected and untouched; original Windows timeout, current-app/P8, Q5, phone/release and whole-duplex acceptance remain open and separate.
