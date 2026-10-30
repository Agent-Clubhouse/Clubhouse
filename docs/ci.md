# CI

How Validate spends runners, and why. The constraint: this plan has about 60 concurrent Linux and Windows runners but only **5 macOS** runners. When every PR also ran macOS, the macOS queue became the bottleneck for the whole repository.

The rules, in short:
- Every behaviour is tested on every PR, on Linux and Windows.
- macOS runs only what genuinely differs on macOS: at most **2 short macOS jobs per PR**, neither of them the long pole.
- The complete macOS matrix is still available with the `full-ci` label or a manual run.

## What runs when

| Trigger | Linux + Windows | macOS |
|---|---|---|
| PR, docs only | nothing (`paths-ignore`) | nothing |
| PR, code | lint; Codex schema drift; typecheck + API surface (one Linux job); unit tests (2 shards per OS); **one build per OS, then E2E (3 shards per OS), Annex E2E and Chat E2E from that build** | **macOS unit** (~2.5 min), plus **macOS build + E2E smoke** (~9 min) only if the change touches packaging, dependencies or window/keyboard chrome |
| PR touching only unit tests | lint, typecheck, unit | macOS unit |
| Dependabot PR | as a code PR, plus the Linux package smoke test | as a code PR. Electron and native-module bumps trigger macOS build |
| `full-ci` label, manual dispatch | everything | everything (unit, build, sharded E2E, Annex E2E) |
| Push to `main` | everything, plus the Linux package smoke test | macOS unit, plus macOS build if the push is macOS-relevant |
| Daily, 07:00 UTC | everything | macOS unit and macOS build. This catches runner-image and Xcode drift that no change would trigger, for about 12 macOS minutes a day. |

**Pushes to main are an accepted tradeoff toward the macOS cut.** They run the same reduced macOS set as a PR: macOS unit, plus macOS build when the merged diff is macOS-relevant. The complete macOS matrix doesn't run on merges. Together with the daily run of both macOS jobs, that's the deliberate trade for the cut in macOS minutes.

**Labels:** only the `full-ci` label starts a run. Any other label gets its own concurrency group, so it can't cancel a run in progress, and it stops at the `changes` job.

## Deciding what a change needs

The `changes` job classifies the diff with `node scripts/ci/classify-changes.mjs`. For a PR it diffs the base against the head; for a push to main it diffs `before` against the new head. With no usable base, for example a new branch, it runs everything. The step summary prints the decision and the reason.

- **Docs-only:** everything under `docs/`, `notes/`, top-level `*.md`, `.github` templates, or `LICENSE`. `paths-ignore` skips these PRs before any runner starts. Markdown under `src/` is bundled app content, so it doesn't count as docs.
- **E2E:** every change except docs and unit tests (`*.test.ts(x)`, `__fixtures__`, `__mocks__`, `test/`).
- **macOS build:** any one of these.
  - **A packaging input:** `forge.config.ts`, `entitlements.plist`, `scripts/fix-node-pty.js` or `.icns` icons.
  - **Window and app chrome:** `src/main/menu.ts` (the app menu) and anything under `src/renderer/chrome/`.
  - **The CI files themselves.**
  - **A dependency change** to Electron, node-pty, `@electron/*` or `@electron-forge/*`, in `package.json` or the lockfile, including lockfile `resolved` URLs.
  - **A changed line in any non-test source file** that touches macOS behaviour:
    - `'darwin'`, `safeStorage`, `systemPreferences`;
    - window chrome: `titleBarStyle`, `titleBarOverlay`, `hiddenInset`, `trafficLightPosition`, `app.dock`, `setVibrancy`;
    - Cmd shortcuts: `isMac`, `metaKey`, `CmdOrCtrl`;
    - macOS install paths and signing: `/opt/homebrew`, `osxSign`, `osxNotarize`.

    An unrelated edit to a file with a darwin branch elsewhere doesn't count, and neither does a darwin platform mock in a test.

The macOS unit job needs no classification, because it runs on every code PR. Its fixed test list covers auto-update, the keychain, the login shell, the CLI paths, the FSEvents watchers (`goobers-service`, `file-watch-service`), the app menu, window chrome and shortcuts. `vitest related` adds the change's own tests.

The Squirrel code in `src/main/index.ts` is the Windows installer hook (`electron-squirrel-startup`). The macOS update path lives in `auto-update-service`, which the macOS unit job tests on every PR.

Over the 67 PRs measured below, macOS build would have run on **12 (18%)**:
- window and renderer chrome: 5;
- darwin lines in telemetry install-kind, resource and bootstrap code: 3;
- the Electron bump in #1941;
- CI changes: 3.

## Paths Windows can't check out

Before it classifies anything, the `changes` job runs `node scripts/ci/check-windows-paths.mjs`. It fails if a tracked path has a segment Windows can't create: a backslash, `:` or another reserved character, a device name like `CON` or `NUL`, or a trailing dot or space. Without it, one such commit makes every Windows job fail at `actions/checkout` with no clear message (#2347).

`npm test` runs the same check after every run with `--untracked`, which adds untracked and ignored paths, so a stray directory fails locally before anyone commits it.

## The two macOS jobs

**macOS unit**, on every code PR (about 2.5 min). It skips the Electron download, then runs:
- **The unit tests for code that behaves differently on macOS:**
  - `auto-update` (the apply test runs only on darwin);
  - `secret-store` (keychain) and `install-kind`;
  - `shell` (zsh login env), and `shared` (the `/opt/homebrew` CLI paths);
  - `window-handlers` and `app-handlers`;
  - `goobers-service` and `file-watch-service` (FSEvents);
  - `menu` (the app menu);
  - `renderer/chrome`;
  - the terminal `clipboard` and `keyboardShortcutsStore` (Cmd versus Ctrl).
- **`vitest related` for the changed source files.**

**macOS build + E2E smoke**, only when the change is macOS-relevant (about 9 min).
1. **`electron-forge package` for macOS:** asar, fuses, the `osxSign` config, and node-pty's darwin prebuild with the `fix-node-pty.js` spawn-helper fix.
2. **The specs whose behaviour differs on macOS:** `app-launch`, `smoke-blank-screen` and `popout-window` for window chrome and traffic lights; `command-palette` and `find-replace` for Cmd shortcuts; and `terminal` for the node-pty spawn helper.

## Coverage map

The table below shows where every behaviour the old macOS legs tested is covered now. "Before" is the PR matrix before #1984, which ran typecheck, unit, E2E and Annex E2E on macOS for every PR.

| Previously tested on macOS, on every PR | Now covered by | Why that's equivalent |
|---|---|---|
| Typecheck | Linux typecheck, every PR | `tsc` output doesn't depend on the OS, and Linux paths are case-sensitive, so Linux catches more |
| ~560 unit/component files | Linux and Windows unit, every PR | They mock `process.platform` and use temp dirs, so they run identically on every OS |
| Unit tests with darwin-only paths (Squirrel.Mac apply, keychain, login shell, `/opt/homebrew` CLI paths, FSEvents watcher, title bar, Cmd shortcuts, clipboard) | macOS unit, every PR | Same tests, on a real Mac, on every PR |
| Unit tests affected by the change | macOS unit (`vitest related`), every PR, plus Linux and Windows | The change's tests also run on a Mac |
| macOS packaging (it ran inside every macOS E2E job) | macOS build, when packaging, dependency or chrome inputs change; also daily | Packaging only changes when its inputs change; daily covers runner-image drift |
| E2E specs, all ~33 files (core UI, terminal, agents, plugins, canvas, settings, onboarding, …) | Linux and Windows E2E, 3 shards each, every PR | The same specs; their only platform branch is Meta versus Control, which Linux and Windows run with Control |
| macOS-specific E2E behaviour: traffic lights, title bar, app menu, Cmd shortcuts, node-pty spawn helper | macOS build smoke set, when chrome or keyboard code changes; also daily | Those specs on a real Mac, triggered by the changes that can break them |
| Annex E2E (dual instance, `bonjour-service` discovery) | Linux and Windows Annex E2E, every PR | `bonjour-service` is pure-JS multicast DNS, and Annex has no darwin code path |
| (new) Rich chat content and chat UX specs, `e2e/chat-rich` (#2480) | Linux and Windows Chat E2E, every PR; never macOS, not even on `full-ci` | Paths, pdf.js, media playback and IPC have no darwin branch; see docs/testing/chat-e2e-plan.md |

The one narrowing: a change that touches none of the triggers can't break the macOS-specific UI and packaging checks by construction. Even so, if a runner image or Xcode update changes behaviour, the daily run surfaces it within a day, and `full-ci` runs the complete macOS matrix on demand.

## Building once

The E2E specs launch `.webpack/<arch>/main` with Electron from `node_modules` (`e2e/launch.ts`). Forge rebuilds no native modules (`rebuildConfig.onlyModules` is empty, and node-pty ships N-API prebuilds). So the `build` job runs `electron-forge package` once per OS and uploads `.webpack/` as an artifact.

The three E2E shards, the Annex E2E job and the Chat E2E job for that OS each run `npm ci`, download the artifact and run. The sharded E2E job skips `e2e/chat-rich` (`PLAYWRIGHT_IGNORE_CHAT_RICH`), so the chat specs add a parallel job instead of lengthening a shard. Before, every E2E and Annex E2E job packaged the app itself.

## Caching and skipped downloads

- **npm:** `actions/setup-node` caches it.
- **Electron binary:** the jobs that launch Electron cache the roughly 100 MB binary in its default cache directory, keyed by the lockfile.
- **Skipped downloads:** lint, typecheck, unit and macOS unit set `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, because vitest aliases `electron` to a mock and these jobs never launch it.

## Measurements

These are from the Validate runs between 2026-10-16 07:00 and 2026-10-17 06:40 UTC: 187 runs (193 attempts), 186 of them for PRs, across 67 PR branches. They were collected with `gh api …/actions/runs/{id}/attempts/{n}/jobs`. Most of the runs used the pre-#1984 matrix. Times are minutes: queue is job created to started, and run is started to completed.

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
| Lint, API surface | Linux | 0.0 | 0.3–0.4 | 0.8 | 0.8 |

- **macOS load:** across the 119 runs with a complete macOS leg, macOS used 27.2 minutes per run at the median (p90 32.1). macOS took about 30% of all runner minutes, 3,579 of 11,778, on 5 of the ~65 runners. It was the only queue: 5 running and 89 queued at the snapshot, against 51 running and 0 queued on Linux and Windows.
- **Dominant steps:**
  - "Build app" (`electron-forge package`) took 4.5 (Linux), 5.1 (Windows) and 6.0 (macOS) minutes, and it ran in every E2E and Annex E2E job: 6 packages per run.
  - E2E execution took 6.5 to 7.4 minutes, and `npm ci` 0.5 to 0.7.
  - `tsc` ran 4 times per run, on 3 OSes plus the API surface job.
- **Superseded runs:** 75 of 193 attempts were cancelled by a newer push. Jobs already running when that happened burned 163 macOS minutes.
- **Flakes:**
  - Unit failed and then passed on rerun of the same commit 5 times (3 macOS, 2 Windows).
  - E2E failed on 9 macOS commits, against 5 Linux and 2 Windows.

## Compute and long pole: before, now and proposed

These are per-job medians from the table above. The proposed figures are estimates, built from the same medians:
- **Unit shards:** half the test step, plus the job overhead.
- **E2E shards:** a third of the test step, plus overhead and an artifact download.
- **The build job:** the old "Build app" step, plus overhead and the upload.

### Per PR run (minutes of runner time)

| | Linux | Windows | macOS | Total | macOS jobs | Long pole |
|---|---|---|---|---|---|---|
| **Before** (pre-#1984: E2E on all 3 OSes) | 30.5 | 27.5 | 27.8 | 85.8 | 4 | macOS E2E: 14.2 run, ~20.4 with the median queue, ~52 at p90 |
| **Now** (#1984 + #1995: no E2E on PRs, no macOS) | 6.6 | 7.5 | 0 | 14.1 | 0 | Windows unit, 6.1 |
| **Proposed** | ~22.6 | ~27.1 | ~4.2 average (2.5 always, plus 9.3 on 18%) | ~54 | 1, or 2 for 18% of PRs | Windows build then E2E shard, ~10.5 |

Proposed against before, with the same coverage:
- **Total compute:** −37%.
- **Long pole:** −26% on run time alone, or −49% once the median macOS queue is counted.
- **macOS minutes:** 27.8 → ~4.2 average (−85%), with at most ~12 in the worst case.
- **macOS jobs:** at most 2 per PR, both shorter than the Linux/Windows critical path.

With demand down from 4 macOS jobs per PR to ~1.1, the macOS queue that drove the p90 should drain too.

Proposed against now: more compute, because E2E returns to every PR. Today, PRs get no E2E at all, and E2E problems only surface after merge.

### Per push to main

| | Linux | Windows | macOS | Total |
|---|---|---|---|---|
| Before and now (full matrix) | 30.5 | 27.5 | 27.8 | 85.8 |
| Proposed | ~29.0 (with the package smoke test) | ~27.1 | ~4.2 average | ~60 (−30%) |

### If E2E should stay opt-in on PRs

Gating the `build` job on `complete`, as #1984 did, gives a lean PR:
- **Compute:** about 7.0 on Linux, 7.3 on Windows and 2.5 on macOS, ~17 minutes in total.
- **Long pole:** a Windows unit shard, ~3.7 minutes. That's 40% shorter than today's 6.1 minutes.
- **Pushes to main:** they keep the ~30% saving.

## Follow-ups

- **Webpack-only build:** E2E only needs `.webpack/`, but `electron-forge package` also packages the app into `out/`. A webpack-only build, or a webpack filesystem cache, would take a minute or two off each `build` job, which is the critical path.
- **Shard balancing:** the per-shard JUnit artifacts will give real spec timings, so the shards can be balanced by duration instead of by file.

## Unsigned desktop integration artifacts

The existing hosted macOS packaging jobs also upload `clubhouse-integration-<arch>-<commit>` for seven days. `scripts/ci/package-integration.mjs` registers a Forge configuration object directly; a separate config filename can be overridden by Forge auto-discovery. The artifact uses the Clubhouse Integration display name, a distinct bundle identifier and a run-specific integration version. The script asserts the resolved configuration disables explicit signing, notarization and the fuse plugin's implicit ARM64 ad-hoc signing. All six production hardening fuses are retained and checked on the output. Production packaging configuration remains unchanged.

The archive contains the app, source-commit/ASAR-hash/fuse provenance and instructions. It is uploaded only as a CI artifact, never a release. No URL-scheme association is declared by the test bundle. Packaging does not launch it or verify its executed embedded runtime; the provenance explicitly records those limits. Any later launch requires separate authorization, a disposable profile, updates disabled and loopback-only ephemeral Annex settings. No local build/test/app invocation is required to produce this artifact.

The Windows build also runs `scripts/ci/smoke-packaged.mjs`. This hosted-only check launches the actual packaged executable with an isolated profile, updates/Annex disabled, no inherited CI credentials and no sandbox or inspector override. It checks the existing startup log for `packaged: true` and the embedded Electron/Node/Chromium versions, verifies the six hardened fuse values, records the binary hash, then stops only its owned process tree. The uploaded `packaged-runtime-*` evidence covers packaged Windows startup; development E2E, Annex/network tests and other platforms' packaged launch are separate checks.

The raw Linux package startup attempt in run 40053080627 aborted before runtime reporting because its `chrome-sandbox` lacked root ownership/mode 4755. No sandbox flags, privileged helper permissions or host security settings were changed. Linux installer production remains checked separately; this is not a successful Linux packaged-launch test.
