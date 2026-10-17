# CI

How Validate spends runners, and why. The constraint: this plan has about 60 concurrent Linux and Windows runners but only **5 macOS** runners. When every PR also ran macOS, the macOS queue became the bottleneck for the whole repository.

## What runs when

| Trigger | Linux + Windows | macOS |
|---|---|---|
| PR, docs only | nothing (`paths-ignore`) | nothing |
| PR, code | lint, typecheck + API surface, unit (2 shards per OS), one build per OS, E2E (3 shards per OS), Annex E2E | one **targeted** job, only if the change is macOS-relevant |
| PR touching only unit tests | lint, typecheck, unit | targeted job only if macOS-relevant |
| PR labelled `full-ci`, Dependabot, manual dispatch | everything | everything (unit, build, E2E, Annex E2E) |
| Push to `main` | everything, plus the Linux package smoke test | the targeted job (reduced set) |
| Nightly 07:00 UTC (`validate.yml`) | everything | nothing (see the next row) |
| Nightly 08:00 UTC (`nightly-macos.yml`) | — | full unit, typecheck, E2E and Annex E2E; files or updates a tracking issue on failure |

`full-ci` is the escape hatch. Add the label to any PR to get the complete matrix, including full macOS.

## Deciding what a PR needs

The `changes` job runs `git diff -U0 base...head | node scripts/ci/classify-changes.mjs`. The step summary prints its decision and the reason.

- **Docs-only:** everything under `docs/`, `notes/`, top-level `*.md`, `.github` templates, or `LICENSE`. `paths-ignore` skips these before any runner starts. Markdown under `src/` is bundled app content, so it doesn't count as docs.
- **E2E:** every change except docs and unit tests (`*.test.ts(x)`, `__fixtures__`, `__mocks__`, `test/`). A PR that only changes unit tests skips the build and E2E.
- **macOS-relevant:** any one of these.
  - **A file that exists for macOS:**
    - `forge.config.ts`, `entitlements.plist`, `scripts/fix-node-pty.js`, `.icns` icons;
    - `src/main/services/auto-update*` (Squirrel.Mac; `auto-update-apply.test.ts` runs only on darwin);
    - `src/main/telemetry/secret-store.ts` (keychain `safeStorage`);
    - `src/main/util/shell.ts` (the login-shell env);
    - the CI files themselves.
  - **A changed line in non-test source that touches macOS behaviour:** `'darwin'`, `safeStorage`, `systemPreferences`, `titleBarStyle`, `trafficLightPosition`, `app.dock`, `setVibrancy`, `osxSign` or `osxNotarize`. An unrelated edit to a file that has a darwin branch elsewhere doesn't count, and neither does a `darwin` platform mock in a test.
  - **A dependency change to Electron, node-pty, `@electron/*` or `@electron-forge/*`**, in `package.json` or the lockfile, which changes what gets built for macOS.

### Which tests need a Mac

Almost every unit test mocks `process.platform`, so it runs identically on Linux. The E2E specs only branch on the modifier key (Meta versus Control), which Linux and Windows exercise with Control. What genuinely needs macOS:

| Area | Why | Where it's checked |
|---|---|---|
| Packaging | `electron-forge package` for macOS: asar, fuses, `osxSign` config, node-pty's darwin prebuild (`fix-node-pty.js`) | Targeted job; nightly |
| Auto-update apply | Squirrel.Mac; the apply test only runs on darwin | Targeted job (when touched); nightly |
| Keychain | `safeStorage` in `telemetry/secret-store.ts` | Targeted job (when touched); nightly |
| Window chrome | `titleBarStyle`, traffic lights (`ChromeTitleBar`, `window-handlers`, `ChromeSidebar` inset), app menu and dock (`src/main/index.ts`) | Targeted job: the `app-launch`, `smoke-blank-screen` and `popout-window` specs; nightly |
| Keyboard | Cmd versus Ctrl (`keyboardShortcutsStore`, terminal `clipboard`) | Targeted job: the `command-palette` spec; nightly |
| Shell environment | zsh login shell, `path_helper`, `/opt/homebrew/bin` CLI paths | Targeted job (when touched); nightly |
| FSEvents | `fs.watch` latency differs from inotify (the goobers address watcher) | Nightly |

## The targeted macOS job

This is one `macos-latest` job, about 10 minutes long. It runs these steps in order:
1. **On PRs only:** `vitest related` for the changed source files.
2. **The macOS-specific unit tests:** auto-update, secret store, install kind, shell, window handlers, CLI paths, chrome, clipboard and shortcuts. That's about 27 files and 10 seconds.
3. **`electron-forge package`.**
4. **An E2E smoke set:** `app-launch`, `smoke-blank-screen`, `command-palette` and `popout-window`.

## Nightly macOS and the tracking issue

`nightly-macos.yml` runs the full suite on macOS, and its `report` job then runs `scripts/ci/nightly-report.mjs` over the JUnit results, from vitest and from Playwright. It keeps one tracking issue up to date:

- **The first failing night opens an issue.** It's titled `[MEDIUM][TEST] Nightly macOS CI failures` and labelled `nightly-macos`, `bug`, `type:bug`, `severity: MEDIUM` and `area:e2e`. It lists the failing tests.
- **Later failing nights comment on that same issue,** listing new failures, tests still failing, and tests fixed since the last report. They also refresh the issue body, which keeps the current failing set in a hidden marker.
- **The first passing night comments and closes the issue.**

## Building once

The E2E specs launch `.webpack/<arch>/main` with Electron from `node_modules` (`e2e/launch.ts`). Forge rebuilds no native modules (`rebuildConfig.onlyModules` is empty, and node-pty ships N-API prebuilds). So the `build` job runs `electron-forge package` once per OS and uploads `.webpack/` as an artifact.

The three E2E shards and the Annex E2E job for that OS each run `npm ci`, download the artifact and run. Before, every E2E and Annex E2E job packaged the app itself.

## Caching and skipped downloads

- **npm:** `actions/setup-node` caches it.
- **Electron binary:** jobs that launch Electron (E2E, Annex, macOS) cache the roughly 100 MB binary in its default cache directory, keyed by the lockfile.
- **Skipped downloads:** lint, typecheck and unit jobs set `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, because vitest aliases `electron` to a mock and they never launch it.

## Measurements behind this design

These are from the Validate runs between 2026-10-16 07:00 and 2026-10-17 06:40 UTC: 187 runs (193 attempts), 186 of them for PRs, across 67 PR branches. They were collected with `gh api …/actions/runs/{id}/attempts/{n}/jobs`. Most of these runs used the matrix from before #1984, which ran every job on all three OSes for every PR. Times are minutes: queue is job created to started, and run is started to completed.

| Job | OS | Queue p50 | Queue p90 | Run p50 | Run p90 |
|---|---|---|---|---|---|
| E2E | macOS | 6.2 | 34.5 | 14.2 | 17.1 |
| E2E | Windows | 0.0 | 0.1 | 12.8 | 13.6 |
| E2E | Linux | 0.0 | 0.0 | 11.4 | 12.2 |
| Annex E2E | macOS | 8.9 | 39.8 | 8.0 | 10.0 |
| Annex E2E | Windows / Linux | 0.0 | 0.1 | 7.2 / 6.1 | 7.9 / 6.5 |
| Unit + Component | macOS | 7.3 | 41.4 | 4.5 | 5.4 |
| Unit + Component | Windows / Linux | 0.0 | 0.1–0.5 | 6.1 / 4.3 | 6.7 / 5.5 |
| Typecheck | macOS / Windows / Linux | 4.7 / 0 / 0 | 37.0 / 0.2 / 0.6 | 1.1 / 1.4 / 0.7 | 1.4 / 1.8 / 0.8 |
| Linux package smoke | Linux | 0.0 | 0.0 | 6.4 | 6.9 |
| Lint, API surface | Linux | 0.0 | 0.3–0.4 | 0.8 | 0.9 |

- **macOS queueing:** while Linux and Windows jobs started immediately, macOS jobs waited 5–9 minutes at the median and 35–41 minutes at p90. In the snapshot behind this work, macOS had 5 running and 89 queued, against 51 running and 0 queued on Linux and Windows.
- **Runner minutes in the window:** Linux 4,289 (1,073 jobs), Windows 3,910 (605) and macOS 3,579 (513). That's roughly 30% of the minutes on 5 of the ~65 runners.
- **Dominant steps:**
  - "Build app" (`electron-forge package`) took 4.5 (Linux), 5.1 (Windows) and 6.0 (macOS) minutes, and it ran in every E2E and every Annex E2E job: 6 packages per run.
  - E2E test execution took 6.5 to 7.4 minutes.
  - `npm ci` took 0.5 to 0.7 minutes.
  - Typecheck ran three times, plus once more inside the API surface job, though `tsc` doesn't depend on the OS.
- **Superseded runs:** 75 of 193 attempts were cancelled by a newer push. Jobs already running when that happened burned 163 macOS minutes.
- **Failures and flakes:**
  - Unit failed on 12 macOS commits, 12 Windows and 5 Linux. Five failures passed on rerun of the same commit (3 macOS, 2 Windows).
  - E2E failed on 9 macOS commits, against 5 Linux and 2 Windows. macOS E2E was the least reliable leg.
- **PR mix:** 5 of 67 PRs (7%) were docs-only and ran the full matrix anyway. 13 of 67 (19%) would get the targeted macOS job under the rules above:
  - auto-update changes: 6;
  - title bar, traffic-light and darwin lines: 3;
  - CI changes: 3;
  - the keychain secret store: 1;
  - the Electron bump in #1941: 1.

## Before and after, per PR

The estimates use the medians above. "Now" is main after #1984 and #1995, which removed E2E from PRs and then macOS from the PR matrix.

| | Before #1984 | Now | With this design |
|---|---|---|---|
| E2E on a PR | macOS, Windows, Linux | none (needs `full-ci`) | Linux and Windows, sharded |
| PR wall-clock (code PR) | ~21 min median (macOS E2E queue + run), ~52 min p90 | ~7 min (Windows unit) | ~10–11 min: build ~6.2, then E2E shard ~3.8 |
| macOS minutes per PR | ~28 (4 jobs) | 0 | ~1.8 on average (19% × ~10 min) |
| macOS on the PR's critical path | yes | no | only for macOS-relevant PRs, ~10 min |
| Linux + Windows minutes per PR | ~58 | ~14 | ~55, with E2E restored |
| Docs-only PR | full matrix | partial | no runners |
| Push to main, macOS | ~28 min (4 jobs) | ~28 min (4 jobs) | ~10 min (1 job) |
| Nightly macOS | full matrix | full matrix | ~20 min (2 jobs) plus the issue report |

On macOS the saving is about 26 minutes per PR against the old matrix, and about 18 minutes per push to main against today. The coverage traded away:
- **Full macOS unit and E2E on a PR** now come only from the nightly run and the `full-ci` label, and their regressions surface the next morning as the tracking issue.
- **The Linux package smoke test** runs only on main, full runs and the nightly.

## Follow-ups

- **Webpack-only build:** E2E only needs `.webpack/`, but `electron-forge package` also packages the app into `out/`. A webpack-only build, or a webpack filesystem cache, would take a minute or two off each `build` job, which is the critical path.
- **Shard balancing:** with timings from the new per-shard JUnit artifacts, Playwright shards could be balanced by duration instead of by file.
- **Required checks:** if branch protection ever requires status checks, mark the `changes` job's skipped dependents as acceptable. Skipped jobs report as successful, so the current shape already works.
