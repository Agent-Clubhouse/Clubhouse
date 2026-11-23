# Desktop CI efficiency: workflow plan (2026-11-23)

Planning only, against `817ef3827c266dab9fef40c9ab06cd23d06fb394`. This change activates no workflow, opens no PR and runs no hosted work. Standby is preserved. Runtime and step-duration census belongs to the Orchestrator/history owner; this document combines source-derived counts with the supplied release census and labels older measurements explicitly. No billing multiplier, dollar estimate, current queue limit or quota is assumed.

## Recommendation

Start with skipping unused Electron downloads in the release updater-test job and the static SDK guard, then deduplicate the fixed/related macOS unit selections. Evaluate release Electron download caching separately using the release census. Preserve signed/notarized per-architecture release packaging, the real macOS updater script checks and the independent stable-candidate harness. Existing build artifact sharing is already implemented; it is not a new saving.

The desktop macOS pause from #3570 remains in force. All Validate macOS improvements below have **zero incremental macOS saving on ordinary runs while paused**. Release is tag-triggered and unaffected by that pause; Stable candidate is explicit dispatch only. Neither is permission to run them in this task.

## Workflow and artifact census

| Workflow / mode | Work actually selected at this base | Reuse already present / boundary |
|---|---|---|
| Validate, ordinary PR / main / daily / full-ci while paused | Linux/Windows; `macos=false` removes every macOS matrix leg and skips the dedicated pair | Skipped macOS checks are not passes. Manual dispatch without `macos=true` still selects complete Linux/Windows coverage |
| Validate, resumed ordinary code PR | `macos-unit`; optionally `macos-build` from classifier | At most two jobs; unit-test-only changes skip builds/E2E. Docs-only PRs are ignored before jobs start |
| Validate, resumed main | Same classified macOS pair; Linux package smoke added | Main push is not a complete macOS run |
| Validate, resumed daily | Targeted macOS unit + build/smoke | Daily is not full macOS E2E |
| Validate, complete **and** macOS enabled | 2 unit shards + 1 build + 3 E2E shards + 2 Annex shards + 1 SDK guard = **9 Mac jobs** | Dedicated `macos-unit`/`macos-build` do not also run; Chat, Stable-mode and Classic remain Linux/Windows |
| Validate build artifact | `.webpack/`, `webpack-${matrix.os}`, retained 3 days | 1 build feeds **10 consumer jobs per Linux/Windows OS** (3 E2E + 2 Annex + 3 chat + stable + classic); complete Mac build feeds 5. All consumers still install dependencies/Electron |
| Validate macOS integration artifact | `clubhouse-integration-${runner.arch}-${github.sha}`, retained 7 days, produced by either Mac build route | Alternative routes are mutually exclusive. Unsigned isolated name/bundle ID/run version; ASAR/fuse provenance. `packagedLaunchVerified=false`, `embeddedRuntimeExecuted=false` |
| Release | Signed tag verification; updater tests on Mac/Windows; two Mac arch builds, two Windows arch builds, one Linux build; Linux publish | **3 Mac jobs/tag:** updater gate + arm64 + x64 build. `release-darwin-{arm64,x64}` retains ZIP/DMG for 5 days and publish downloads them. Rerun failed jobs reuses successful outputs within retention; never rebuild merely for notes |
| Stable candidate | Dispatch boolean default false; one packaging/launch job on each of Linux, Windows, Mac | 1 Mac job/authorized dispatch. Candidate full SHA on main and harness SHA checked separately. Stable version rewrite, fresh install, hardened fuses, CDP main/renderer/files checks; results/provenance/logs only, 7 days |
| Chat handshake nightly | 3 Linux provider jobs, 08:00 UTC; optional dispatch | Pinned real protocol handshake + localhost fake-model flow; no model prompt/credentials. Scheduled failures are tolerated, manual failures are not. No Mac job to eliminate |
| Republish notes | Linux prepare + gated publish; dry run default true | Existing `republish-notes` artifact; no package rebuild; release environment/OIDC/ETag conflict protections |
| Publish CLI denylist | Linux preview + gated publish; dry run default true | Existing data-only manifest operation; no app rebuild. Publish rereads main and preserves release gate |

`docs/ci.md` predates multiple shard/layout changes and retains before/now/proposed tables from October. Its 67-PR 18% macOS-build rate, ~2.5/9-minute pair estimates, 5/~60 runner constraints and 85% macOS reduction are **historical**, not current measured savings. Its final sentence calls release dispatched by hand; the authoritative YAML actually uses tag pushes. Its table says Classic one shard while earlier prose reflects other shard counts. Read YAML and current shard lists first.

## Archaeology and overlap/deduplication

Reviewed all six current workflow files, workflow path history across local refs (106 commits at inspection), classifier and tests, packaging/stable scripts, Forge/webpack configs, E2E launcher/shard tests, updater fixtures, CI documentation and relevant PR metadata. Important transitions:

| Evidence | Consequence for this proposal |
|---|---|
| #66 (`29a6bbfd1`), #116 (`31d79445b`) | Earlier merge double-trigger removal / initial cross-platform coverage are already historical work |
| #1984 (`f4ed75f32`), #1995 (`319e04778`) | Earlier opt-in E2E and removal of PR Macs are intermediate states, not the current coverage baseline |
| #1999 (`09d7e3738`) | Single build per OS, one Linux typecheck/API gate, two unit shards, targeted Mac pair, classifier, Electron skipping, PR cancellation and docs exclusion already landed. Do not add their savings again |
| #2000 / #2003 (`4f44ec5cf`) | Removed failing credential-dependent nightly Mac real-CLI job; renamed Linux handshake workflow. Do not propose removing it again or substitute a mock handshake for native packaging |
| #2625 / #2636 / #2869 / #3687 | SDK guard, nightly SDK coverage and later static-only boundary/pins evolved independently. Keep runtime QA opt-ins separate from standard tests |
| #2804 (`61bd9f8a8`) | Stable packaged candidate intentionally independent of unpackaged stable-mode E2E and normal Validate dispatch |
| #2798 / #2509 / #2833 | Tested manifest-last release publishing, notes-only republish and denylist-only publish already avoid unnecessary rebuilds |
| #3019 (`c80cd459d`) | Electron cache + limited Linux/Windows package 5xx retry already landed. Explicitly excluded stable-candidate caches, signed release retries and integration-package retries |
| #3090 / #3131 / #3135 / #3143 / #3149 / #3169 | Layout migrations and explicit measured shard balancing already landed. Current Classic has one shard; replacing all with test-count sharding discards that work |
| #3435 (`35596e579`) | Release-notes Git fixtures already share initial repository preparation and independently copy state. Do not count fixture dedup again |
| #3570 (`b7669586b`) | Maintainer pause is an intentional coverage gap, not successful Mac equivalence proof |

Read-only PR searches on 2026-11-23 found [#3721](https://github.com/Agent-Clubhouse/Clubhouse/pull/3721) and [#3736](https://github.com/Agent-Clubhouse/Clubhouse/pull/3736) as open DO NOT MERGE hosted validation branches modifying Validate. They extend Annex from 2 to 6 shards (commit `9142a8c84` and descendants); they are not merged baseline or optimization owners. An implementation must preserve their future lists and acceptance holds if integrated. In that variant, complete Mac has **3 E2E + 6 Annex = 9 consumers**, and complete Mac total becomes **13 jobs**. Do not budget those speculative jobs as current traffic. Diagnostic variants (`5126149d8`, `wrf-flake-probe.yml`, deleted Windows-signing workflows) carry isolated control/approval semantics; do not activate or generalize them. Deleted Claude review/mention workflows and old scheduled-real-cli file are not current jobs.

## Supplied release measurements

The Orchestrator’s [release-jobs.csv](release-jobs.csv) and [release_usage.py](release_usage.py), committed on integration at `3089a36e4c0366ba4094ab398bef344fa3647eff`, cover the configured 2026-10-25 through 2026-11-23T23:29Z window. Offline CSV verification finds **15 tags, 47 distinct Mac job executions and 517.37 runner minutes**. The combined Forge build/sign/notarize step accounts for **432.2 minutes**; npm install phases account for **50.8**, including **17.0** in updater-test jobs. Those phases do not isolate Electron download time, and the Forge step does not isolate compilation from signing/notarization. They are opportunity ceilings for investigation, not removable time. The CSV includes retries/failures as actual executions; do not collapse them into 45 nominal jobs or count copied retry outputs again. This lane inspected the supplied committed CSV offline and collected no hosted job history. Relative evidence links resolve when this plan is integrated with that evidence commit.

## Ranked concrete proposals

Rank reflects coverage confidence and implementation size; duration ranking must be updated from the census before adoption. Counts are deterministic opportunities, not minutes saved.

### 1. Skip unused Electron binary downloads

Set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` on Release `validate-update-scripts`. It runs only `vitest --project main auto-update-apply`; Electron is mocked and no Electron app launches. Keep `npm ci`, native updater script execution and the blocking dependency on both updater jobs. The same setting can cover Validate `copilot-sdk-chunk` while it remains `--static-only`: that code returns before `findRuntime`/`findElectron`, uses a dedicated webpack build and stages native modules with filesystem code. Preserve `npm ci --foreground-scripts`, the koffi prebuilt-load/no-source-build assertion, optional dependencies, and all static leak assertions.

**Envelope:** at most one unused Electron postinstall download/install avoided in each updater job (1 Mac + 1 Windows per tag), and in each SDK job (2 Linux/Windows per E2E-bearing run, plus 1 Mac only in enabled complete mode). A warm Electron cache may already avoid the network transfer, so do not equate each invocation with bytes or duration saved. Historical docs call the binary roughly 100 MB; that is not a current transfer measurement. Job count and package/test execution unchanged.

**Proof required:** review all import/install hooks for Electron use; compare native case names/results and static SDK report before/after on the same authorized head. Confirm the static-only early return and that no require-electron flag is added. Failure or a future runtime smoke restores the download for that job. No runtime proof has been collected here.

### 2. Execute the macOS fixed/related test union once

The `run: >-` scalar has equal indentation and folds to one valid shell command. The thirteen `src/...` tokens are positional **path-substring file filters**, not individual test-name/OS predicates. Current source enumeration finds **63 matching `.test.ts(x)` files**. `auto-update` also matches Windows/mock/builder tests; `renderer/chrome` currently selects 38 files. The `install-kind` token matches no test file at this base (the source exists). That is a selector-audit finding, not permission to silently drop a purported gate.

The next step calls `vitest related` separately. Preserve both selections by discovering fixed and related file/project identities using the pinned Vitest API, unioning by `(project, canonical file path)`, then executing that exact union once with one JUnit report. Alternatively retain the fixed run and subtract only proven identical fixed file/project identities from the related run. Fail closed to the present two commands if resolution fails, a path is ambiguous or an expected native file disappears. Use argument arrays / NUL-safe changed-file handling; do not keep shell word splitting on `FILES`.

**Envelope:** old executions `|F| + |R|`; proposed `|F union R|`; removes exactly `|F intersect R|` duplicate file/project executions (0 through 63 at this source-only bound) plus one Vitest startup if a single union invocation is implemented. `R` can be large; do not assert a positive saving on every PR. No overlap on daily without a diff. No saving while Mac paused. Narrowing F to fewer files is a separate coverage change, not this proposal.

**Proof required:** export before/after file/project/test identities for changes to auto-update-service, chrome, unrelated source, tests only, deletion/rename and no-base cases. Preserve all 8 real darwin updater cases; related uses static imports and is not a guarantee for dynamic import paths. Both reporter output and failure propagation must survive. Official [Vitest CLI](https://vitest.dev/guide/cli.html) documents path filters and related's static-import limitation; use the repository-pinned v4 API, not newer CLI features without checking compatibility.

### 3. Cache release Electron distribution downloads, not built apps

Release Mac builds currently cache npm via setup-node but lack Validate's Electron cache. Add a narrowly scoped distribution cache around the **two** Mac `npm ci`/Forge make paths. Include OS, host/target architecture, Electron version/lock identity in keys; x64 target and arm64 target must not collide. Use verified upstream download bytes only, with no cached node_modules, certificates/keychains, signing state, out/, .webpack or publish artifacts. Preserve fresh package/sign/notarize/make/hashes per target.

**Envelope:** two Mac build consumers/tag; possible avoidance of host Electron postinstall and target packaging distribution fetches on warm hits, less restore/save overhead. Not two package builds removed. Existing same-key immutable caches may not contain both target distributions, so validate actual hits/content rather than assuming both jobs seed one entry. #3019 records SHASUMS is still fetched by packager; cache does not eliminate it. Separate from proposal 1: updater job skips download, build jobs cache required downloads. The supplied release census puts total Mac build-job npm phases at about 33.8 minutes (50.8 minus updater 17.0); cache savings are an unknown subset, before cache overhead, not the full phase.

**Risk/proof:** artifact/cache trust across PR and release contexts, checksum validation, cold-miss fallback, target arch separation and unchanged signed outputs/provenance. Do not copy #3019's retry loop around signing/notarization. Stable candidate intentionally consumes no earlier-run caches and is excluded.

### 4. Consolidate complete-Mac E2E consumers only if setup dominates

Existing `.webpack` artifact makes this possible without compiling again. One same-OS/arch consumer could download once and run the existing 3 E2E + 2 Annex lists as **five isolated sequential Playwright commands**, each with its original env/config, separate report destinations and all-command failure aggregation. Keep disposable app profiles and process cleanup; never set both shard variables together. Preserve `fail-fast:false` evidence semantics.

**Envelope:** five consumers to one removes 4 checkout/setup/npm-ci/cache-restore/artifact-download sequences and 4 runner job starts per enabled complete run; 9 Mac jobs become 5 if other jobs stay unchanged. Package builds remain one, test executions remain all five lists. This is **not** recommended without runtime data: sequential app tests can lengthen the critical path and one timeout can lose evidence. A two-consumer grouping trades less setup reduction for shorter serial time. If future Annex expands to six, recompute counts rather than copying this grouping. No change to ordinary resumed targeted smoke and no saving while paused.

### 5. Prototype compilation reuse only after equivalence is demonstrable

`docs/ci.md` already proposes webpack-only E2E builds. Existing `.webpack` consumers establish the launch contract, but no committed standalone Forge-equivalent bundling script exists. Forge supplies arch paths, renderer/preload constants, URLs and hooks; raw webpack.main.config alone is insufficient. Keep native package verification in `package-integration.mjs` and actual Windows packaged-runtime smoke even if compilation separates later.

A same-head shared renderer/main build for Release's two Mac arches is even less proven: webpack asset relocation, native staging, package metadata/version rewrite and Forge target injection can differ. Keep per-arch package/native/sign/notarize/ZIP/DMG checks on Mac; never replace release output with unsigned integration ZIPs or stable-candidate results. No existing artifact proves cross-OS/arch equivalence, so assign **zero bankable savings** to cross-platform compilation or node_modules sharing. Prototype separately with file/module manifests and native contamination checks before changing workflow dependencies.

## Gates and honest coverage

- Mac updater execution: `auto-update-apply.test.ts` has **8 darwin-only tests** executing generated bash against temp app bundles, real zip/unzip/mv and cleanup/rollback paths. Relaunch invokes native `open` on a fake app and tolerates failure; it does not establish a successful real-app relaunch. Cross-platform builder assertions are supplementary. The Windows file mocks child_process/fs/Electron; its win32 guard is not an actual Update.exe execution. Keep both release gates on the exact tag until an explicit equivalent checked-source receipt design is approved.
- Existing macOS unit files exercise code on a Mac, but `secret-store` mocks safeStorage, `shell` mocks child_process, and file-watch-service mocks fs.watch. Do not claim actual Keychain, login-shell or FSEvents integration from those files. Keep current coverage; test-list optimization cannot upgrade its strength.
- Native Mac E2E smoke retains app launch/window chrome, default-shell-macos, blank screen, popout, command palette, find/replace, terminal/node-pty. The actual YAML includes seven spec paths. The unpackaged `.webpack` launcher is not evidence that the unsigned integration bundle starts or passes signing/Gatekeeper.
- Release's arm64/x64 are output architectures; both select `macos-latest`. An x64 output does not itself prove execution on Intel hardware. Preserve Developer ID, entitlements, hardened fuse assertions and notarization/makers per output, release environment, signed-tag check and manifest-last/hash/recovery semantics.
- Stable candidate must retain candidate/harness separation, main ancestry/exact commit checks, clean source checks, own node_modules/config, stable-version rewrite/restore, packaged SHA/ASAR/fuses, all scenario and CDP completeness checks, isolation and results-only upload. Normal integration version is Preview-eligible and cannot replace that stable test. Do not add caches or reuse its package without a separate design decision.
- Linux glibc 2.36 native rebuild and rpm/deb contents checks; Windows runner pin, installer signing and packaged runtime smoke are native gates outside the Mac optimization scope. Preserve them.
- Classifier fallback with no usable base runs builds; changed-line matching and fixed native list are coverage assumptions. Do not widen exclusions merely because a file has no darwin marker. Packaging helpers/webpack inputs deserve an explicit coverage audit before any narrower Mac selector.

## Acceptance and accounting

This is a docs-only proposal. No local app/native updater tests, installs, packaging, hosted execution or job-history requests were performed. Source enumeration and `git diff --check` are static evidence only. Independent review and exact-head runtime equivalence remain deferred to the owning integration lane.

For each adopted candidate, join the history owner's measurements by immutable workflow revision, source SHA, event/attempt, OS/arch and selected job mode. Record setup/download/build/test/upload separately, with missing/cancelled/skipped rows distinct from passes. Sum actual affected step intervals for runner-time opportunity; recompute DAG critical path independently. Cache-hit downloads, eliminated duplicate tests and eliminated job setup cannot each claim the same elapsed interval. Do not multiply old per-job medians by current shard counts, infer billed cost, credit historical #1999 changes again, or use full-ci/manual mode as ordinary traffic.

Current source-only additive envelope: proposal 1 affects unused downloads in updater/SDK jobs; proposal 2 affects repeated Mac unit test execution; proposal 3 affects required release-build downloads. Proposal 4 replaces consumer setup and must be counted instead of any other reuse proposal for those same sequences. Proposal 5 is unproven and contributes no forecast. Release census is linked above; incorporate the separate Validate history-owner findings when available; no observed runtime speedup is claimed here.
