# Copilot SDK chat driver: spike results and plan

Status: spike done, phases 0 to 3 done (opt-in driver, off by default) · Date: 2026-11-01 · Issue: [#2616](https://github.com/Agent-Clubhouse/Clubhouse/issues/2616) · Context: [docs/structured-chat-research.md](structured-chat-research.md) §7 and §8 (Phase 5)

Copilot chat runs today on the ACP driver (`copilot_acp`, `src/main/orchestrators/adapters/acp-chat-driver.ts`). This note records what the SDK does on real CLI versions and how to move to it. Codex is covered in [its own section](#codex-stay-on-app-server).

## Recommendation

**Build the `copilot_sdk` driver. Fallback order: SDK, then ACP, then terminal** (maintainer decision, 2026-11-01). ACP stays for Copilot and stays the generic driver.

| Question | Answer |
|---|---|
| Does it package? | Yes. A 221 KB lazy chunk, once `koffi` is aliased away. No CLI or native binary is emitted. |
| Can it run the user's `copilot`? | Yes, but not through `forStdio` as it stands: `--no-auto-update` still picks the shim's built-in runtime. Have the driver spawn the CLI and connect with `RuntimeConnection.forUri`. |
| Safe CLI range for SDK 1.0.28 | `minVersion: 1.0.83`, tested up to 1.0.106-2. Newer CLIs get a note, not a fallback. Pin the SDK to an exact version. |
| Do the promised features work? | Everything except credit usage and the live model list ran end to end against a fake model. Those two need a real login, so they stayed untested. |
| What triggers the fallback? | A failed or timed-out handshake, a protocol mismatch, or a CLI below `minVersion`. The protocol check alone is too weak to rely on (see [Version skew](#version-skew)). |
| Size | About 2.5 to 3 engineer-weeks, up from the earlier estimate of 1.5 to 2. The extra time goes to the launch path and a new fixture protocol. |

## How this was tested

No prompt reached a real model. Every run used:

- `sandbox-exec` with outbound network limited to localhost, so a paid request wasn't possible;
- a temporary `HOME` and `COPILOT_HOME`, invalid `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN`, and write access to the real `~/.copilot` and `~/.codex` denied;
- a local OpenAI-compatible fake model, set as the session's BYOK `provider`. What the CLI sent it shows what the CLI really did;
- packages installed in a scratch directory with `--ignore-scripts`.

`scripts/probe-copilot-sdk.mjs` re-runs the main probes on any SDK and CLI pair (macOS only). CLI behaviour goes stale quickly, so re-run it on each SDK bump.

Everything below is **observed** on macOS arm64 unless marked *docs claim* or *from reading the code*.

**Not tested:**

- A packaged app. Phase 0 ran the chunk under Electron's Node, with `ELECTRON_RUN_AS_NODE`, not inside a running Electron main process with the hardened fuses. Nothing in the app imports the SDK yet, so phase 1 has to prove that.
- The user's own `copilot` on Windows and Linux. Phase 0 ran only the SDK's bundled runtime there, and only as far as creating a session.
- Anything that needs a real login: `models.list` (models and billing for the menus), credit usage (`copilotUsage`, `quotaSnapshots`), `account.getQuota`, and how real models use steering.

## Features

SDK 1.0.28 with CLI 1.0.105 and 1.0.106-2. "Since" is the oldest version where the probe passed, using `send` plus events.

| Feature | Observed | Since |
|---|---|---|
| Steering, `send({ mode: 'immediate' })` | Sent during a model call. It arrives in the next model request of the same run, and the session goes idle once. | 0.0.423 |
| Native queue, `mode: 'enqueue'` | Runs after the current turn, and goes idle once after both. `rpc.queue.pendingItems` and `removeAt` list and remove items; a removed message never reaches the model. | Queueing 0.0.423; `pendingItems` absent at 1.0.20, present at 1.0.78 |
| Permissions | `onPermissionRequest` gets typed requests (`shell`, `write`, ...). `approve-for-session` stops a second prompt. `rpc.permissions.setApproveAll` skips the handler. | Handler and reject 0.0.423; the other two 1.0.105 only |
| Plan approval | `rpc.mode.set({ mode: 'plan' })`, then `exit_plan_mode` calls `onExitPlanModeRequest` with the summary and actions. Approving returns the mode to `interactive`. | 0.0.423 |
| Questions | `ask_user` calls `onUserInputRequest` with the question and choices; the answer reaches the model. | 0.0.423 |
| MCP elicitation | A stdio server's `elicitation/create` calls `onElicitationRequest`, and the answer returns to the server. | Yes at 1.0.40, no at 1.0.20 |
| Subagents | `subagent.started` and `subagent.completed`, with `agentId` on the subagent's events. | 1.0.10. On 1.0.0 and older, a subagent under BYOK starts and then fails asking for a GitHub token; whether it works with a login is untested. |
| `setModel` with effort | `reasoning_effort` and the model change on the next request, and both can change again later. | 1.0.81 (1.0.80 ignores the effort silently) |
| Usage | `assistant.usage` per model call: tokens, cost, timing. Under BYOK: `cost: 0`, `aiCreditsStatus: "unavailable"`, empty `quotaSnapshots`. **Credits are only in the types (*docs claim*).** | 0.0.423 for tokens |
| Resume without replay | 150-turn session: `resumeSession` took 75 ms with 8 state events and no history replayed. ACP `session/load` took 1,699 ms and replayed 302 updates. The model still saw the full history. | 1.0.80 (older CLIs fail on `disconnect`: `Unhandled method session.detach`) |
| Resuming a missing session | Immediate error, `Session not found`. ACP hangs on this (#2155). | 1.0.80 (older CLIs not reached, see above) |
| MCP over stdio | Works. ACP refuses client stdio servers (#2240), so this removes the "can't load stdio MCP servers" notice. | 0.0.423 |
| MCP over HTTP | Works with a custom header (`X-Clubhouse-Nonce`), including the session id and SSE stream the bridge expects. | 0.0.423 |
| `tools/list_changed` | Stdio and HTTP: the next model request lists the new tool, and `mcp.tools.list_changed` fires. | Yes at 1.0.40, no at 1.0.20 |
| Interrupt | `abort()` reaches idle in 66 ms, and the session stays usable. | 0.0.423 |
| Images | A `blob` attachment reaches the model as `image_url` when the model declares vision. A model without it got no image in the one case tried, with an 8-byte file that isn't a valid PNG. | 1.0.105 only |
| Compaction | `rpc.history.compact()` works and emits `session.compaction_complete`. | 1.0.105 only |
| CLI dies mid-turn | `sendAndWait` rejects in about 50 ms and the client state becomes `disconnected`. No session event fires, so the driver must end the session itself. | 1.0.105 only |

These matter for the normalizer:

- **A subagent's events carry `agentId`, and include its own `session.model_change` and `user.message`.** Without a filter, the chip shows the subagent's model. Tie them to the `task` call through `subagent.started`.
- **A queued message arrives as `user.message` with `delivery: "queued"`.** No idle fires between it and the turn before.
- **`exit_plan_mode` always offers `autopilot` among its actions**, whatever the model asked for. Approving picks `interactive`.
- **`session.mcp_servers_loaded` fires as each turn starts**, not at session open, so server status appears with the first turn.

- **`assistant.turn_start` and `turn_end` mark model rounds, not user turns.** A steered run had two rounds and one `session.idle`. A turn in the chat contract ends on `session.idle`, and a queued message starts at its `user.message`.
- **A `reject` without feedback ends the run**, with no further model call. With `feedback`, the model sees the reason and continues. The UI's plain Deny and "Deny with a reason" map onto this.
- **Sessions emit event types the SDK doesn't declare**, such as `model.log` and `model.turn_started`. The `SessionEvent` union has 149 members. Ignore undeclared types instead of reporting them as `protocol_unknown`.
- **`pending_messages.modified` has an empty payload.** Read `queue.pendingItems` for the contents.

## Packaging

The repo's production main webpack config built a smoke entry that loads the SDK through a plain-JS `import()`, the same pattern as `src/main/chat/claude/sdk-loader.js`.

| | As is | With `resolve.alias: { koffi: false }` |
|---|---|---|
| SDK chunk | 221,432 bytes | 221,432 bytes |
| Native files emitted | `native_modules/darwin_arm64/koffi.node`, 1.2 MB | none |
| Webpack warnings | 19 (`@koromix/koffi-*` not found and others) | 1 (`createRequire().resolve`, in code that finds the bundled runtime) |
| Bundled run, from a temp dir with no `node_modules` | connects and completes a turn | connects and completes a turn |

**`koffi` is only for the experimental in-process transport.** `dist/ffiRuntimeHost.js` is its only importer, reached through `import()` when `RuntimeConnection.forInProcess` is used. The driver never uses that transport, so the alias is safe. The chunk guard should fail if `koffi.node` or `@github/copilot-sdk-*` appears in the output.

**The bundled CLI is a separate package.** `@github/copilot-sdk-<platform>` is an optional dependency of 159 MB on macOS arm64. It's only resolved when no connection path is given. With a path set, the SDK's runtime cache directory was never created. Webpack doesn't pull it in, and `forge.config.ts` copies only `node-pty` into the package, so it never ships. It costs developer and CI disk, less than the 239 MB the Claude SDK's binary already takes.

**`koffi` stays in the dependency tree and it isn't optional.** Its install script (`cnoke --prebuild`) runs `node -e "require(...)"` on the koffi package, which checks that a prebuilt binary from an optional `@koromix/koffi-<platform>` package loads. If it doesn't, the script tries to compile with CMake. It downloads nothing.

| Where (npm 10.9.9, Node 22.23.4) | Prebuilt package | Script |
|---|---|---|
| Linux x64 | `koffi-linux-x64` | Loaded, about 0.1 s, nothing compiled |
| Windows x64 (windows-2022) | `koffi-win32-x64` | Loaded, about 0.1 s, nothing compiled |
| macOS arm64 | `koffi-darwin-arm64` | Loaded, about 0.1 s, nothing compiled |

The one way it breaks an install: with no loadable prebuilt binary and no CMake, the script exits 1 and `npm ci` fails. Run by hand with the optional package missing, it failed with `CMake does not seem to be available`. So `--omit=optional` would break the install, and nothing in this repo uses it. The release's macOS x64 and Windows arm64 builds have prebuilt packages in the lockfile, but no PR run covers those targets.

**Phase 0 results.** `scripts/check-copilot-sdk-chunk.mjs` runs in the `copilot-sdk-chunk` CI job on all three platforms. On each one the chunk is 0.21 MB, no binary is emitted, and the bundled chunk completes a handshake and creates a session against runtime 1.0.105 with no credentials, under Node 22.23.4 and under Electron 45.1.0's Node. With the alias removed, the check fails on `koffi.node`. `npm ci` didn't get measurably slower (median 49 s against 46 s on Linux, 58 s against 55 s on Windows, on a first run with a cold npm cache), and the npm cache grew by about 65 MB per platform.

**Handshake with no credentials works.** `start()`, `getStatus()` and `getAuthStatus()` succeeded with no tokens, no network and no login, and sent no model request. `createSession` works too. So the nightly handshake (research §8, decision 4) includes this driver, as does the fake-model Dispatcher smoke.

## Running the user's CLI

**`--no-auto-update` still forces the shim's built-in runtime (#2154).** The SDK adds `--headless --no-auto-update` on every spawn it makes. Measured in a temporary home, using a v1.0.82 shim with 1.0.105 and 1.0.106-2 in its package cache:

| Launch | Runs |
|---|---|
| `copilot --version` (what Terminal gets) | 1.0.106-2 |
| `copilot --no-auto-update --version` | 1.0.82 |
| `forStdio({ path })` | 1.0.82 |
| `forStdio({ path, args: ['--prefer-version', '1.0.106-2'] })` | 1.0.106-2 |
| `--prefer-version 9.9.9` (not in the cache) | 1.0.82, with a warning on stderr |
| Driver spawns `copilot --headless --port 0`, then `forUri` | 1.0.106-2 |

A v1.0.105 shim behaves the same way: 1.0.105 with the flag, 1.0.106-2 without. The gap is small on this machine today only because the Homebrew binary has updated itself in place to 1.0.105. It comes back whenever the package cache is ahead of the binary, and 1.0.82 is below the floor set in [Version skew](#version-skew).

**Recommended launch: the driver spawns the CLI and connects with `forUri`.**

| | Driver spawn + `forUri` (recommended) | `forStdio` + `--prefer-version` |
|---|---|---|
| Same version as Terminal | Yes, with no extra work | Only after a separate `copilot --version` before every start |
| `commandPrefix` | Yes, through `resolveStructuredSpawn` | POSIX through `sh -c`; no on Windows |
| Windows npm `.cmd` shim | Yes, through `resolveStructuredSpawn` | No (*from reading the code*): `spawn` of a `.cmd` without a shell fails, and a `.js` path runs `process.execPath`, which is Electron with the `RunAsNode` fuse off |
| Process lifetime and kill | Driver's, so `killStructuredChild` is reused | SDK's |
| Transport | Loopback TCP with a token | Stdio pipes |
| Hidden CLI flags relied on | `--headless`, `--port`; the "listening on port" line the SDK also parses | `--headless`, `--prefer-version` |

The TCP listener is safe enough for this: it bound to `127.0.0.1`, and with `COPILOT_CONNECTION_TOKEN` set, a wrong or missing token got `AUTHENTICATION_FAILED`. Use a random token per session, passed through the child's env. Steering, MCP, resume and the dead-CLI case all behaved the same over `forUri`. The full probe set otherwise ran over stdio.

## Version skew

**The protocol check is a weak signal.** Every CLI from 0.0.423 (March 2026) to 1.0.106-2 reports protocol 3 and passes it. Real breakage happens inside that range, with no warning at connect:

| CLI | Handshake | What breaks on SDK 1.0.28 |
|---|---|---|
| 1.0.83 to 1.0.106-2 | ok | Nothing found. Full probes on 1.0.83, 1.0.98, 1.0.105 and 1.0.106-2. |
| 1.0.81, 1.0.82 | ok | `sendAndWait` hangs until its own timeout (tested on 1.0.82). A driver using `send` plus events is fine. 1.0.81 reports its version as `0.0.1` in `getStatus`. |
| 1.0.80 | ok | `setModel` ignores the effort silently. |
| 1.0.40 to 1.0.78 | ok | Also: `disconnect` throws `Unhandled method session.detach`, which stopped the resume probe. (1.0.79 wasn't run.) |
| 1.0.20 and older | ok | Also: no `tools/list_changed` refresh, no elicitation, no `queue.pendingItems`. `rpc.mode.get` returns an object here and a string by 1.0.40, with the same protocol version. |
| 1.0.0, 0.0.423 | ok | Also: subagents fail under BYOK. |
| 0.0.400 and older | **fails** | CLI exits: `unknown option '--headless'`. |

**Newer CLIs look much safer than older ones.** SDK 1.0.0 (June), 1.0.15, 1.0.22 and 1.0.25 all passed the feature probes against current CLIs (1.0.0 and 1.0.15 on 1.0.105; 1.0.22 and 1.0.25 on 1.0.106-2). Five months of CLI releases changed nothing these probes cover. A wider SDK and CLI gap isn't proven safe, and the probes can't see every event field.

**Policy:**

- Pin the SDK exactly, as for the Claude SDK. `@github/copilot-sdk` 1.0.28 ships with CLI 1.0.105. The earlier note's "SDK 1.0.N matches CLI 1.0.N" is wrong.
- Set `copilot_sdk: { minVersion: '1.0.83', testedMax: '1.0.106-2' }` in `TESTED_CLI_VERSIONS`. 1.0.83 is two months old and these CLIs update themselves, so few users should be below it. 1.0.81 and 1.0.82 would work for `send` plus events, but they sit next to a broken SDK path, and the floor has no need to be that tight.
- Newer than `testedMax`: keep the SDK, and log a note per §7.1.
- Use the `chatCliDenylist` kill switch for a bad release. It already covers the driver id.

## Fallback

`tryStartChatAgent` in `chat-spawn.ts` already does the work. It goes through `chatDriverCandidates`, runs each driver's `probe()` through `checkDriver`, skips failures and version-policy rejections, and reports the reason. The driver only has to fail its probe in the right way:

| Trigger | What the SDK does (observed) | Driver response |
|---|---|---|
| Protocol mismatch (fake CLI reporting 2, 4, or none) | `start()` rejects in under 350 ms: `SDK protocol version mismatch: ...`. No child process left behind. | `handshakeOk: false`, `errorCode: 'protocol_error'` |
| CLI exits at launch (real 0.0.400) | Rejects: `CLI server exited with code 1`, with stderr. | `process_exited` |
| CLI hangs, or writes non-RPC text to stdout | **`start()` never settles.** Still pending after 45 s. | Wrap it in a timeout, 15 s like Codex's `PROBE_TIMEOUT_MS`, then kill the child. Cold handshakes took 0.8 to 5.9 s. `rpc_timeout` |
| CLI below `minVersion` | Connects normally. | Report `cliVersion`; the version policy skips the driver. |
| Not logged in | **Not a fallback.** Handshake and `createSession` succeed. The first `send` is accepted and then fails with `session.error`: `No GitHub OAuth token or Copilot HMAC key provided`. | Check `getAuthStatus().isAuthenticated` during start and report login required, unless `COPILOT_PROVIDER_BASE_URL` is set (see below). `isLoginRequiredError` doesn't match that message, so don't rely on it. |
| Failure after the session starts | `Connection is disposed`, client state `disconnected`. | End the session normally. No mid-session driver switch. |

**Using your own model key.** `--headless` ignores `COPILOT_PROVIDER_*` and `COPILOT_MODEL`, and still wants a GitHub login, with or without `COPILOT_OFFLINE`. The CLI view and ACP honor them (observed on 1.0.105). So the driver maps the variables from `copilot help environment` onto the session's `provider`, and only `COPILOT_PROVIDER_BASE_URL` counts in place of a login. Like the CLI, it needs a model: a saved one, `COPILOT_MODEL` or `COPILOT_PROVIDER_MODEL_ID`. With none, the CLI exits with `BYOK providers require an explicit model`, and the driver's start fails with its own message.

**Sessions carry over between drivers, so falling back doesn't lose context.** An SDK session loaded over ACP `session/load`, and an ACP session opened with `resumeSession`. In both directions the model saw the earlier messages. This held on 1.0.82, 1.0.83, 1.0.98 and 1.0.106-2. So existing Copilot agents need no migration, and the transcript stays Clubhouse's.

**Registration.** `copilot_sdk` registers after `copilot_acp` with `optIn: true`, so it is never the default and never a fallback from ACP. Choosing it in Settings writes the per-provider `driver` setting in `chat-runtime-settings.json`. To make it the default in phase 4, drop `optIn` and register it first.

## Shape of the code

Mirror `src/main/chat/claude/`, in `src/main/chat/copilot/`:

- `sdk-loader.js`: the plain-JS lazy import.
- `launch.ts`: spawn through `resolveStructuredSpawn`, read the port, generate the token.
- `transport.ts`: wraps `CopilotClient` and `CopilotSession`.
- `normalizer.ts`: SDK events to `ChatEventDraft`. My rough estimate is that about 40 of the 149 event types carry something the chat contract shows.

Reused from the ACP driver:

- the `session_info` shape and level names;
- the MCP bridge endpoint, sent as `type: 'http'` with the nonce header, plus stdio servers as they are.

Capabilities: `steer: true`, `queue: 'native'`, `planApproval: true`, `questions: true`, `subagents: 'full'`, `resume: 'native'`, `usage: 'tokens'` until credits are confirmed on a real login, then `'cost'`.

Levels: `plan` is `mode.set('plan')`, `ask` is the handler, `full_access` is `setApproveAll`, autopilot is `mode.set('autopilot')` (all observed). `auto_edit` would be the handler approving `write` requests (proposed, not run). Whether mode and `setApproveAll` survive a resume is untested, so check it in phase 2. ACP re-sends them after a resume because a loaded session's values were stale (#2174).

## Trying it

The driver is off by default. To turn it on, in a beta or dev build:

1. Settings › Experimental: turn on **Chat** and **Copilot SDK driver**.
2. Settings › Agents & providers › Copilot CLI: leave Runtime on Chat, and set **Chat driver** to **Copilot SDK (experimental)**.
3. Start or restart a Copilot agent.

The flag only offers the choice. With it off, Copilot uses ACP and the Chat driver setting is hidden. A saved choice is kept, and applies again when the flag comes back. Running agents keep their driver until they restart.

**Which driver is running:** the chat opens with "This chat runs on the experimental Copilot SDK driver with Copilot CLI x.y.z". The agent glyph's tooltip shows the same driver and version. On a fallback, a toast and a chat notice say "Using Copilot CLI (ACP): " and the reason.

**In the logs** (`~/.clubhouse/logs`):

| Namespace | Message | What it tells you |
|---|---|---|
| `core:chat` | `Chat driver check` | Each driver tried, whether it passed, and why not |
| `core:chat:copilot` | `Copilot SDK probe` | Binary, CLI version, protocol, login result, time taken |
| `core:chat:copilot` | `Copilot SDK session opened` | Session id, CLI version, level, resume result, MCP servers |
| `core:chat:copilot` | `Copilot session error` | Error type, status code and message |
| `core:chat:copilot` | `Copilot CLI exited` | Exit code and the end of stderr |

**What it doesn't do yet:**

- An Auto level. It asks first and says so, because Copilot's autopilot keeps going on its own, which isn't what Auto means elsewhere.
- Editing a plan while approving it. Send it back with a reason instead.
- `/allow-all`, `/permissions` and `/autopilot`, which ACP lists. They change access from inside the CLI, where the level menu can't see it, so the driver refuses them and points at the menu.
- Credits. Usage shows tokens only until a real login confirms the fields (phase 4).

## Commands and elicitation

**A slash command runs only through `commands.invoke`.** Sent as a message, `/help` reached the model as text (observed on 1.0.105). `commands.list` returns the same built-ins ACP lists, plus the project's skills. The driver runs a message that starts with a listed command, and anything else stays text for the model, so "/tmp is full" still works. A skill comes back as `agent-prompt`, a prompt to send as a normal turn. A picker the CLI would draw itself (`show-dialog`) gets a notice.

**A server's question starts at the approval card**, because the question card has no way to say no. Decline and cancel reach the server as such, and no level answers for the user. A form's fields then go in question cards. What a card can't do:

- Show a field as anything but a choice or free text. Numbers and text limits are checked on submit, and the form stays open on a bad answer.
- Leave a field blank: an optional one gets a Skip choice, or `-` as free text.
- Fill in a default: it's shown in the prompt, and must be entered.
- Open a link: in URL mode the card shows the URL for the user to open.

## Plan

Sizes are engineer-days. Each phase ships on its own, behind the Experimental chat flag.

| Phase | Work | Size |
|---|---|---|
| **0. Dependency** (done, #2624) | Add the pinned SDK, the loader and the `koffi` alias. Add `scripts/check-copilot-sdk-chunk.mjs`, like the Claude one. Confirm `npm ci` and the bundled smoke on macOS, Windows and Linux in CI. | 1 to 2 |
| **1. Driver, opt-in** | Launch, transport, probe with timeout, version policy, auth check. Text, tools, permissions and interrupt. Registered after ACP. | 3 to 4 |
| **2. Full features** | Steer, native queue, plan approval, questions, subagents, usage, model and effort, stdio MCP. Add the Windows launch and resume-level checks. | 4 to 5 |
| **3. Fixtures and CI** (#2632) | Teach `scripts/chat-fixtures/fake-cli.mjs` and the recorder a `copilot-sdk` protocol: `Content-Length` framing over TCP. Replay through the driver in unit tests. Add the driver to the nightly handshake. No prompts in CI. | 2 to 3 |
| **4. Default** | Maintainer QA with a real login on the three platforms, covering credits, the model list and real steering. Record real fixtures. Register SDK first. | 1 to 2 |

Total: 11 to 16 days. **The earlier 1.5 to 2 weeks was light.** The features need less investigation than expected, but it didn't count the launch path or the new fixture protocol.

The main risks left are real-login behaviour, which nothing here could test, and Windows launch. Phase 4 and phase 2 cover those, and until then ACP is what users get.

## Codex: stay on app-server

**Don't adopt `@openai/codex-sdk`.** It would be a step down from the current driver.

The SDK (0.166.0) is about 550 lines around `codex exec --experimental-json`. It spawns one process per turn, writes the prompt to stdin, closes stdin, and reads JSONL. Run with a fake endpoint and a temp `CODEX_HOME`, a logging wrapper recorded `exec ... resume <thread>` on each later turn.

| | `@openai/codex-sdk` | Current `codex app-server` driver |
|---|---|---|
| Steering | None. Stdin is closed after the prompt (*from reading the code*). | `turn/steer` |
| Approvals | None. With `approvalPolicy: 'on-request'`, an escalated command was refused: `approval policy is Never; reject command`. | `item/*/requestApproval`, live |
| Questions, elicitation | No channel to answer on (*from reading the code*). | `item/tool/requestUserInput`, `mcpServer/elicitation/request` |
| Interrupt | `AbortSignal` kills the process (*from reading the code*). | `turn/interrupt` |
| Resume | `exec resume <id>`, a new process per turn. | `thread/resume`, one process |
| MCP servers | Only through raw `config` overrides. | Same config, per session |
| Tool refresh (#2603) | The next turn lists new tools, but only because each turn is a new process and reconnects every server. | Keeps the first list. #2606 already handles this with a full list and `call_wire_tool`. |
| CLI | Can run the user's with `codexPathOverride`, but `@openai/codex` is a hard dependency pinned to the same version: 353 MB on disk. | Runs the user's `codex` |

So it doesn't improve on #2603 in a way worth having. A process per turn costs a cold start and an MCP reconnect on every message, and loses everything else in the table.

The method list comes from `codex app-server generate-ts` at 0.166.0. It still has every method above, but the driver wasn't re-run against that version in this spike. `mcpServer/tool/call` also exists there. Whether it can reach a tool outside the first list is untested, and #2606 means nothing depends on it.
