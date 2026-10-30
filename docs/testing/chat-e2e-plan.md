# Chat E2E plan: rich content and chat UX (#2480)

Rich chat content (`richChatContent`, #2349) and this month's chat UX are about to become stable and on by default. Until now the only chat E2E was `e2e/chat-fake-cli.spec.ts` (two turns, wide content, a permission, Stop), and no spec turned the flag on. Everything else was jsdom unit and component tests, which can't exercise real layout, scrolling and focus, pdf.js and its worker, media playback, IPC with main, or the production security policy.

This page is the plan for closing that gap: what to cover, with which fixtures, how specs are written and where they run, the CI budget, and the gate for making the flag the default.

## Hard constraints

These come from the maintainer and apply to all #2480 work.

1. **Add, don't replace.** Don't remove or rewrite existing tests until the maintainer moves rich chat to stable. Overlap with unit, component and existing E2E tests is fine.
2. **The long pole must not grow.** Total CI minutes may go up, but the wall-clock critical path of a Validate run must not. Add E2E shards or parallel jobs rather than lengthening existing shards. Measure the before and after critical path on CI and report it in the PR.
3. **macOS CI may grow by at most 25%.** New specs stay out of the macOS smoke set. Anything that must touch macOS is budgeted explicitly against that cap.
4. **No paid prompts.** Every spec replays fixtures through the fake CLIs (docs/chat-fixtures.md). Never record in CI.
5. **No local Playwright or Electron runs.** Locally, run unit tests, typecheck and lint, and the builder's dry check (`npx vitest run --project main src/main/orchestrators/adapters/testing/chat-script.test.ts`). CI runs the specs.

## Where the specs live and run

- **Specs:** `e2e/chat-rich/*.spec.ts`, one file per area below.
- **Harness:** `e2e/chat-rich/harness.ts` (launch, flags, DOM helpers) and `src/main/orchestrators/adapters/testing/chat-script.ts` (scripted turns).
- **Media:** `test/chat-media/` (see its README).
- **CI job:** `e2e-chat` in `.github/workflows/validate.yml`, "Chat E2E Tests (os, shard)". It runs on `ubuntu-latest` and `windows-2022` from the same `build` artifact as the other E2E jobs, in parallel with the three E2E shards and Annex E2E. It has three shards per OS (`--shard=N/3 --fully-parallel`), so tests rather than files are spread across shards; a `serial` group stays in one shard. A new area spec needs no workflow change.
- **Kept out of everything else:** the sharded E2E job sets `PLAYWRIGHT_IGNORE_CHAT_RICH=1`, which `playwright.config.ts` turns into a `testIgnore` for `**/chat-rich/**`. That keeps the existing shards exactly as long as before.

### How specs avoid macOS runners

- The `e2e-chat` matrix is fixed to Linux and Windows. Unlike the other E2E jobs, it doesn't add `macos-latest` on `full-ci` or manual runs either.
- The full macOS E2E matrix (on `full-ci`) is the sharded `e2e` job, which ignores `e2e/chat-rich`.
- The macOS build smoke set is an explicit file list (`app-launch`, `smoke-blank-screen`, `popout-window`, `command-palette`, `find-replace`, `terminal`). Never add a chat-rich spec to it.
- **Media and fixture-only PRs skip E2E.** `classify-changes.mjs` treats `test/` as unit-test-only, so a PR that only touches `test/chat-media` or `test/chat-fixtures` runs no build and no Chat E2E. Such a PR must also touch the spec that uses the file, or add the `full-ci` label.
- Nothing under `e2e/` counts toward `scripts/ci/classify-changes.mjs`'s macOS markers, which only read `src/` lines. A chat-rich PR triggers the macOS build job only if it also edits a macOS trigger (the workflow itself, chrome, packaging, dependencies).
- Why that's safe: the rich content code has no darwin branch except the "Show in Finder" label. Paths, pdf.js, media playback and IPC behave the same on macOS as on Linux. The macOS unit job already covers the macOS-specific bits, and daily and `full-ci` runs cover the rest of the app on macOS.

**macOS budget:** 0 added minutes per PR and per `full-ci` run. A PR that edits `validate.yml` (like the Phase 1 PR) runs the existing macOS build smoke once, under the existing rule. That isn't new recurring cost.

## Coverage matrix

Each row runs on **Linux and Windows**. macOS is excluded on purpose (see above). Windows is where path shapes differ (drive letters, backslashes, 8.3 short names under `%TEMP%`), so every path-bearing case must pass there, not only on Linux.

Legend: **E** is an example spec landed in Phase 1. **P2** is Phase 2 work. **·** means not needed: the behavior is in the renderer or main and doesn't depend on the provider, so one provider covers it. **n/a** means the provider has no such shape.

| Area | Case | Claude | Codex | Copilot |
|---|---|---|---|---|
| 0. Provider bring-up | Codex and Copilot open in chat over the fake CLI, with the existing four scenarios | already on | done (`providers.spec.ts`) | done (`providers.spec.ts`) |
| 1. Rich media | Tool-result image becomes a thumbnail | **E** (`content`) | P2 (`view`) | P2 (`asset`) |
| | Other image shapes | P2 (`read-result`) | P2 (`generated`) | P2 (`inline`, `omitted`) |
| | Markdown image inside and outside the project | P2 | · | · |
| | Missing or unreadable image says why | P2 | · | · |
| | Lightbox opens, fits, toggles actual size, closes, returns focus | **E** (open and close) | · | · |
| 2. File chips | Outside-project PDF chip opens page 1 | **E** | · | · |
| | PDF paging (Next, Previous, page count) | P2 | · | · |
| | Path with spaces (quoted, code span) | P2 | · | · |
| | `:line:col` opens the preview there, and Open in Files at that location | P2 | · | · |
| | Outside-project text file | P2 | · | · |
| | Too-large and missing files show their reasons | P2 | · | · |
| | A binary-ish file named `.pdf` is never shown as text | P2 | · | · |
| | Paths in tool output (command output) chip too | P2 | P2 | · |
| 3. Media cards | Audio and video cards play and pause | P2 | · | · |
| | Only one player is active at a time | P2 | · | · |
| | Playback survives virtualization and unmount | P2 | · | · |
| | No autoplay | P2 | · | · |
| 4. Links and PR tokens | Hover card for a PR or issue token | P2 | · | · |
| | No remote fetch until the user asks | P2 | · | · |
| 5. Question and approval dock (#2412) | Many long questions: composer and transcript stay usable, stepper works, submit stays reachable | P2 | n/a | n/a |
| | Focus moves don't scroll the page | P2 | · | · |
| | A long approval keeps the dock bounded | P2 | P2 | P2 |
| 6. Queue (#2413) and helper merging (#2414) | 30+ queued items stay capped | done (native queue, no remove) | done (client queue) | done (client queue) |
| | Remove and Clear all never deliver | n/a (native queue) | done | done |
| | A burst of helper messages merges into one item; user messages never merge | done (one steer) | done (one steer) | done (one queued turn) |
| 7. Flag off | Everything renders as plain text, with no rich IPC | P2 | · | · |
| 8. Annex | Rich content over a controller connection (`contentAnyPath`, the `pdf` kind) | P2 | · | · |

Area 0 (#2484) is done: `e2e/chat-rich/providers.spec.ts` runs the four `chat-fake-cli` scenarios for Codex and Copilot over their committed fixtures. `e2e/chat-fake-cli.spec.ts` still marks them `registered: false`, on purpose: it runs in the sharded E2E job. The harness gives every Copilot chat its own `COPILOT_HOME`, and the fake CLI's report records the `COPILOT_HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` it was launched with (`report.env`), so a spec can check the app passed them through.

## Fixture inventory

Scripts are built per test with `buildChatScript(cli, script)` and written to the test's temp folder. Paths and bytes are only known at run time, so nothing built is committed. Each script starts with the handshake of a committed fixture (`multi-turn` by default) and appends scripted turns in the protocol's own shapes.

| Area | Scripted turns | Builder support |
|---|---|---|
| 1 | One turn per image shape: `{ type: 'image-tool', image, variant }`. Markdown images: a `text` step with `md.image(alt, path)`. Missing: `md.image` pointing at a path that doesn't exist. | All shapes in Phase 1. Copilot `asset` also writes the session journal (below). |
| 2 | `text` steps naming paths with `md.path(path, line?, col?)` (a code span) or `md.quotedPath(path)` (quoted prose), files seeded with `projectFiles` and `outsideFiles`. Paths in tool output: a `{ type: 'command', command, output }` step (Claude Bash, Codex `commandExecution`). Too large: a sparse file over the preview cap, made with `fs.truncate`. Binary-ish PDF: bytes with NULs named `.pdf`, and a `%PDF-` header over text that pdf.js can't read. | Phase 1, plus the `command` step and `md.quotedPath` in area 2 |
| 3 | `text` naming `test/chat-media/tone.wav` and `clip.webm` copied into the project. Virtualization: enough earlier turns to push the card out of the window. | Phase 1 (many turns is a loop over `turns`) |
| 4 | `text` with `owner/repo#123`, bare `#123` (the project gets a github.com `origin` with `gitRemote`) and PR and commit URLs. The hover card's data comes from main, which answers from `githubRefs` through the unpackaged-only `CLUBHOUSE_TEST_GITHUB_REFS` seam and records each lookup (`githubRefRequests()`). Every chat-rich launch sets the seam, so no spec reaches gh. | Phase 1 for the text. The seam landed with area 4 (#2488). |
| 5 | `{ type: 'questions', questions, answers }` with 8 or more questions and long text. The fixture waits for exactly `answers`, so a wrong answer fails the replay. Long approvals: a committed `permission-*` fixture or a new builder step. | Questions in Phase 1. A long-approval step is area work. |
| 6 | A `held` turn (`end: 'held'`) keeps the agent running until Stop, then ends as cancelled, so queued items stay queued. Later turns take what the queue delivers. Claude steers natively, so its queued messages arrive mid-turn as `user` messages: held Claude turns list them as `steers` (`{ priority: 'next' \| 'later', text? }`, pinned in order). Helper messages go through the real `deliverHelperUpdate` from `session.sendHelperUpdates(texts)`, via an unpackaged-only seam (`CLUBHOUSE_TEST_HELPER_SEAM=1`, `helper-delivery-seam.ts`). | Held turns in Phase 1. Claude `steers` and helper injection in area 6 (#2490). |
| 7 | Reuse area 1 and 2 scripts with `flags: { richChatContent: false }`. "No rich IPC" means counting calls to the rich `chat:*` handlers in main through `electronApp.evaluate`. | Phase 1 |
| 8 | Area 1 and 2 scripts on the satellite, with the controller from the Annex dual-instance helpers (`e2e/annex-v2`). | Phase 1 scripts. The Annex wiring is area work. |

### Copilot binary results

For `variant: 'asset'`, the tool result carries `rawOutput.binaryResultsForLlm: [{ type: 'image', assetId: 'sha256:…', mimeType, byteLength }]`, and the builder adds a `session.binary_asset` line with the base64 bytes to the session journal. `writeChatScript` writes it to `<temp>/copilot-home/session-state/<sessionId>/events.jsonl` and returns `copilotHome`, which `openRichChat` passes to the app as `COPILOT_HOME`. The asset id is the sha256 of the bytes, so main's hash check passes. The builder's unit test reads the asset back with the real `CopilotAssetReader`.

### Building turns by hand instead of recording

Recording costs tokens, and a recording names your machine's paths, so area fixtures are built, not recorded:

1. Start from the builder. If a step is missing, add it to `chat-script.ts` next to the provider's other shapes, copying field sets from a committed fixture or the provider's generated schema (`codex-protocol/generated`, the ACP types). Then add a case to `chat-script.test.ts` that replays it through the fake CLI.
2. List any shape no capture backs in the header's `synthesized` field (the builder does this for the shapes it invents), as for committed hand-made fixtures.
3. When a real recording of that shape exists (docs/chat-fixtures.md, "Recording a fixture"), compare it with the builder's output and fix the builder to match. Change the driver only if the recording proves it wrong.

## Harness

- **`openRichChat({ cli, script, flags?, projectFiles?, outsideFiles? })`:** builds and installs the script, launches with Chat on (seeded, since it's read at mount), sets the flags through the settings IPC (`setExperimentalFlags`, default `richChatContent: true`), adds a temp project, creates a durable agent on that provider and opens its chat. It checks that the app spawned the fake before returning. `script` can be a function of `{ projectDir, outsideDir }`.
- **`setExperimentalFlags(window, flags)`:** saves through `window.clubhouse.app.saveExperimentalSettings`, as the Settings toggle does, then reads the flags back. The renderer reads `richChatContent` once, when the first chat pane mounts, so set flags before opening a chat, or `window.reload()` after changing them mid-session.
- **`chatDom(window)`:** locators for file chips (`fileChip(path)`, `mutedChip(path)`), the preview popover and PDF canvas, tool images, the lightbox, media cards, the permission and question dock, the queue, and the composer.
- **`expectImageLoaded`, `expectCanvasPainted`, `expectNoPageScroll`:** state checks that poll until true. "Painted" means not every pixel is the same, which proves pdf.js drew the page.
- **`richChatCalls(electronApp)`:** calls per rich `chat:*` channel that main's handlers have received, counted before validation and the flag check. The counter is a test seam in `chat-handlers.ts` that exists only in unpackaged builds, and the helper throws if it's missing, so a zero can't come from a missing counter.
- **`session.expectScriptComplete()`:** the fake replayed every line with no mismatch. End every test with it, or a driver that stops early still passes.

## Assertion conventions

- **Wait on DOM or app state, never on time.** Use `expect(locator).toBeVisible()`, `toHaveAttribute()`, `toHaveCount()`, `expect.poll` over an `evaluate`, or the fake's report. No `waitForTimeout`, no `setTimeout` in a spec. If a step needs settling, find the state that says it settled (a turn footer, `data-state="idle"`, `data-chat-file` on a chip) and wait on that.
- **Assert outcomes, not implementation.** Prefer test ids and data attributes the components already expose. Add a `data-testid` in the component if one is missing; don't select on Tailwind classes.
- **End with the CLI side.** `expectScriptComplete()` last, and any `match` on client entries pins what the app sent (answers, approvals).
- **One launch per test** unless the area's tests share a script and can run serially (`test.describe.configure({ mode: 'serial' })` with `beforeAll`). That's the main lever on shard time.
- **Timeouts:** `TURN_TIMEOUT` (20 s) for anything after a send. Don't raise timeouts to hide slowness; report it.
- **Cleanup:** `session.close()` in `afterEach` closes the app and removes the temp project, outside folder and fake CLI. Windows needs the retrying `rm` the harness uses.
- **Paths:** build them with `path.join` from the harness's real-path temp folders, never as POSIX literals: those fail on `windows-latest` only, and the failure hides in the JUnit artifact.

## Shard-time budget

**Baseline,** from PR Validate runs on 2026-10-27 to 30 (40994147689, 40917659347, 40897644638, 40637768887, 40468266949). The critical path is the Windows build followed by the slowest Windows E2E shard.

| | p50 | range |
|---|---|---|
| Wall clock, first job start to last job end | 11.5 min | 10.2 to 14.4 |
| Build app (windows-2022) | 7.1 min | 5.5 to 8.7 |
| Slowest Windows E2E shard | 4.4 min | 3.9 to 5.3 |
| Annex E2E (windows-2022) | 2.6 min | 2.4 to 2.8 |

**Budget:**

- A chat shard must finish within the slowest existing Windows E2E shard's p50, about **4 minutes** of job time, so it never becomes the long pole. Job overhead (checkout, `npm ci`, artifact download) is about 1.3 minutes on Windows, which leaves about 2.5 minutes of tests per shard.
- **Add a shard** (`shard: [1, 2, 3, 4]` and `--shard=N/4` in `e2e-chat`) when a chat shard's measured run time passes 3.5 minutes on either OS. Shards are runners in parallel, so they add CI minutes but not wall clock.
- Phase 2 estimate: about 35 tests at 25 to 35 s each on Windows (each launches the app), so 15 to 20 minutes of tests, which is 6 to 8 shards at one launch per test. Sharing one launch per area where tests allow cuts that to about 4. Each area PR reports its measured time in the job and adjusts the shard count.
- **Phase 1:** the two example specs fit in one shard. The measured delta is in the Phase 1 PR body.

## Flake policy

- CI keeps Playwright's single retry (`retries: 1` under `CI`). A test that passes only on retry is **flaky**, and Playwright marks it so in the JUnit output.
- **First flake:** re-run the failed job once. If it passes, open or update an issue titled `[MEDIUM] Flaky chat E2E: <test>` with the trace artifact (`chat-e2e-traces-<os>-<shard>`). Don't merge a fix that adds a sleep or raises a timeout. Find the state the test should have waited on.
- **Repeat flake** (twice in 5 main runs): the area owner fixes it before more specs land in that area. Quarantine (`test.fixme` with the issue link) only with the maintainer's OK, since removing coverage needs it (constraint 1).
- **Known unrelated flakes** (canvas golden path right-click on Windows, the checkpoint-tracker unit test) aren't chat flakes. Re-run them once, as usual.
- The graduation gate below needs **zero** flaky chat tests across its window.

## Phase 3 graduation gate

`richChatContent` becomes the default only when all of these hold:

- [ ] Every area spec (0 to 8) is merged and green on Linux and Windows.
- [ ] Five consecutive Validate runs on `main` have every `Chat E2E Tests` job green on the first attempt, with no test marked flaky.
- [ ] No open `Flaky chat E2E` issue, and no chat-rich test quarantined.
- [ ] The run's critical path is no longer than the baseline above (p50 11.5 min, measured over the same five runs), and every chat shard is within its 4-minute budget.
- [ ] macOS CI minutes are within 25% of the pre-#2480 baseline (expected: unchanged).
- [ ] The flag-off spec (area 7) still passes, since users can turn the flag off.
- [ ] Each Codex and Copilot case in the matrix runs over that provider's fake (area 0 done), not skipped.

When the default flips, area 7 changes from "default off" to "turned off", and the plan's matrix gets a "default on" pass over areas 1 to 6. That's still adding, per constraint 1.

## Phase 2 areas

One helper and one PR per area. Each area extends its spec file in `e2e/chat-rich/` and reports its measured job time.

0. **Provider bring-up (Codex, Copilot).** Add `e2e/chat-rich/providers.spec.ts`, which runs the four `chat-fake-cli` scenarios (two turns, wide content, approve, Stop) for Codex and Copilot through the harness, fixes any handshake drift in their committed fixtures, and checks that `COPILOT_HOME` reaches the Copilot driver. It lives in `e2e-chat` rather than flipping `registered` in `e2e/chat-fake-cli.spec.ts`, because that spec runs in the sharded job and 8 more launches there would lengthen the long pole (constraint 2). The old spec stays as it is (constraint 1).
1. **Rich media:** Claude, Codex and Copilot (all image shapes); Markdown images, missing images and the lightbox on Claude.
2. **File chips:** Claude, plus Codex for paths in command output.
3. **Media cards:** Claude.
4. **Links and PR tokens:** Claude. Needs a main-side seam to stub reference lookups and record outgoing requests.
5. **Question and approval dock (#2412):** Claude for questions; Claude, Codex and Copilot for long approvals.
6. **Queue (#2413) and helper merging (#2414):** Claude (native steering), Codex and Copilot (client queue). Needs Claude steering entries in the builder and a way to inject helper messages.
7. **Flag off:** Claude.
8. **Annex:** Claude, satellite and controller.
