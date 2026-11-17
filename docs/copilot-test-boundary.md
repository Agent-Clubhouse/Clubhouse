# Copilot SDK test boundary

The standard `npm test` main project runs `driver.test.ts` and `fixture-replay.test.ts`. It does not launch the bundled Copilot runtime. The replay tests use the real driver and SDK with the repository's Node fake CLI, which binds a loopback server and replays committed protocol fixtures. The fake is source-controlled and has no outbound network client; this is not an OS network sandbox. Test child processes inherit a deliberately constructed environment and temporary home, rather than credentials, proxy settings or provider settings from the caller. Windows shims use `cmd.exe`; macOS and Linux use a shell shim. The fake invokes Node by absolute path.

The former `driver.test.ts` real-runtime describe and all of its assertions are retained in `driver.runtime.qa.ts`. `dispatcher-tools.runtime.qa.ts` runs the Dispatcher's real bridge and tool registrations against the same runtime (#3615). Their independent discovery config is `vitest.copilot-runtime.config.ts`, invoked with `npm run qa:copilot-runtime`. It fails if the bundled runtime is missing. This is separately authorized QA: use a clean, allowlisted environment and an OS-enforced network sandbox that permits only loopback before invoking it. `--no-auto-login`, invalid tokens and a fake model alone are not an outbound network boundary, including for the probe. The repository currently documents a macOS sandbox profile in `docs/chat-fixtures.md`; Linux and Windows need independently verified sandbox arrangements. Do not run this command on an ordinary workstation or CI runner as a substitute for that boundary.

## Protocol-v4 migration coverage (#3685)

The application embeds exact-pinned `@microsoft/copilot-sdk` 2.0.0 and attaches explicitly over TCP to the installed CLI; the supported paired CLI is 1.0.113. A devDependency alias, `copilot-sdk-v3-fixture` (exact `@github/copilot-sdk` 1.0.29), is used only in replay tests to reproduce the original old-SDK/protocol-4 error. Neither that alias, the optional runtime packages nor FFI can enter production chunks or the packaged node_modules tree: the static production check and Forge afterCopy enforce those exclusions.

`handshake` exercises v4 success with no session or prompt. `protocol-v4` makes the real old SDK reject `3-3` versus `4`; `protocol-v3` makes v2 reject `4-4` versus `3`. Replay covers failed probes and an executable changing from v4 at probe to v3 at start, verifies no child remains, and checks zero inherited credentials. Chat-spawn tests also prepopulate the actual probe cache and verify protocol-specific CLI fallback plus restored prepared config. The synthetic protocol-99 fixture remains.

The existing feature fixtures are **derived**, with headers recording their protocol-3 origin and synthesized protocol-4 negotiation/grouped create/resume options. Their session-event bodies are historical replay evidence, not new recordings from a v4 runtime. Independent real-login, provider, persistence and tool-behavior QA remains outstanding as described below.

`handshake.runtime.qa.ts` is the separately authorized zero-token v4 handshake entry (run it by filename, rather than the full model QA suite). It may use the installed or SDK platform runtime only within a clean allowlisted environment and an OS-enforced loopback-only sandbox. It may call start/status/auth and stop, with no session or send required. Invalid tokens or an empty temporary home alone do not replace the network boundary. A successful real handshake proves negotiation only, not the feature or paid-model behaviors in the table.

**Observed 2026-11-17 on macOS arm64:** the isolated `handshake.runtime.qa.ts` passed against SDK 2.0.0 / CLI 1.0.113, reporting protocol 4 and a missing login. The parent process used an allowlist containing only temporary home/config/cache/state/temp directories and PATH; `sandbox-exec` denied outbound network except loopback, and denied access to the real Copilot/Codex/GitHub credential directories and macOS keychains. No session was created and no prompt was sent. This is zero-token negotiation evidence only; real-login and feature QA below remains outstanding.

## Behavior mapping

| Former real-runtime coverage | Standard evidence | Real-runtime evidence retained in QA |
| --- | --- | --- |
| Probe, login, own-provider and startup failure | `handshake`, protocol mismatch, launch failure, timeout and login replay | Runtime authentication and provider interpretation, fake-model reachability and model selection |
| Text, usage, model/effort, resume, interrupt, queue, steer, errors | `multi-turn`, `session-info`, `resume`, `resume-not-found`, `interrupt`, `queue`, `steer`, `turn-error` fixtures | Actual model requests, provider behavior, persistence, and turn scheduling |
| Tool approval, denial, question, plan, subagent | `permission-approve-edit`, `permission-deny`, `question`, `plan-approval`, `subagent` fixtures | Actual tool execution, denial sent to model, full-access behavior, cancellation and plan outcomes |
| Slash commands and elicitation | `slash-command`, `elicitation-accept`, `elicitation-decline` fixtures; pure slash parsing remains in `driver.test.ts` | Runtime skills, hidden/busy commands, system-prompt continuity and interrupted/closed elicitation |
| MCP, image, compaction, shim/prefix | Pure MCP conversion remains in `driver.test.ts`; fake launch and replay cover the protocol connection | Real runtime MCP loading, image handling, compaction, and real executable shim/prefix |
| Plan action selection | Pure plan-action assertions remain in `driver.test.ts` | Original assertions retained too |

Fixture replay verifies the recorded or synthesized messages and driver behavior; it cannot prove an installed runtime still emits those messages, makes the same model requests, executes tools, or maintains real sessions. Runtime QA is outstanding until separately authorized and run within the boundary above. The standard suite does not silently skip or claim that evidence.

## Per-test inventory

Each former `driver.test.ts` real-runtime test keeps the same name in `driver.runtime.qa.ts`. The following is the standard-suite counterpart or the explicitly retained runtime-only gap. Fixture names refer to tests in `fixture-replay.test.ts`; replay proves only the recorded protocol exchange.

| Original and QA test name | Standard counterpart or gap |
| --- | --- |
| probes with no session and no model request, and reports the login | handshake replay; runtime login QA only |
| honors COPILOT_PROVIDER_* as the CLI does: a probe that passes means a send reaches the model | provider probe replay; model reachability QA only |
| does not count a provider variable without a base URL as a login | provider-without-base probe replay |
| asks for a model when a provider has none, as the CLI does | Runtime-only model requirement and saved model |
| refuses to start logged out, in the words the fallback code reads as a login | logged-out session replay |
| runs a text turn: says which driver runs, streams, reports usage and ends on idle | multi-turn replay; real model and usage QA only |
| asks before a tool runs, and runs it once allowed | permission-approve-edit replay; tool execution QA only |
| runs a command that only reads at Ask without asking: the runtime's own rule, not a level | Runtime-only: runtime 1.0.107 runs read-only commands without a permission request, so the asking tests use a command that writes in the test's folder |
| carries a denial's reason to the model, which continues | permission-deny replay; model continuation QA only |
| skips the prompt at Full access | Runtime-only full access execution |
| asks first when given a level it doesn't have yet, and says so | Runtime-only unsupported level fallback |
| interrupts a running turn and stays usable | interrupt replay |
| cancels an open approval when interrupted | Runtime-only approval cancellation |
| reports a failed model call as an error and ends the turn | turn-error replay |
| resumes a session with its history, and starts fresh with a notice when it is gone | resume and resume-not-found replay; real persistence QA only |
| steers a running turn: the message reaches the next model request, and the turn ends once | steer replay; model request QA only |
| queues natively: the message runs as its own turn after the first | queue replay; actual scheduling QA only |
| asks the user a question and gives the model the answer | question replay; model answer QA only |
| cancels an open question when interrupted | Runtime-only question cancellation |
| shows a plan for approval, and approving returns to the level the user acted at | plan-approval replay |
| keeps planning when a plan is sent back with a reason | Runtime-only rejected plan continuation |
| never picks autopilot when approving a plan | driver.test.ts pure plan-action case |
| puts a subagent's work under it, and its own idle and model don't speak for the session | subagent replay |
| changes model and effort live, and reports what the CLI applied | session-info replay; real model selection QA only |
| applies the agent's saved effort at start | Runtime-only saved effort at start |
| applies the level again after a resume, as the CLI's own record can be stale | Runtime-only level restoration after resume |
| loads a stdio MCP server, and sees a tool it adds mid-session | Runtime-only live MCP server |
| sends an image, inline or from a file | Runtime-only image input |
| compacts on request, and says so | Runtime-only compaction |
| launches through a shim and a command prefix | Runtime-only real executable shim and command prefix |
| lists the CLI's commands and the project's skills, without the ones that change access | slash-command replay; actual project skills QA only |
| runs a built-in command without the model, and shows what it says | slash-command replay; no model request QA only |
| sends a skill's prompt to the model as a normal turn | Runtime-only skill prompt expansion |
| shows a command's own refusal as a notice, not a failed turn | slash-command replay refusal |
| keeps text that only looks like a command for the model | Runtime-only apparent-command model routing |
| refuses the commands that change access, and tells the model nothing | Runtime-only access command refusal |
| says when a command can't run during a turn, and keeps the turn going | Runtime-only commands during a turn |
| keeps the system prompt for the next prompt when a first message is a command | Runtime-only system prompt continuity |
| reads only a whole message that starts with a command | driver.test.ts pure slash parsing case |
| asks through the approval and question cards, and returns typed answers to the server | elicitation-accept replay; real server QA only |
| tells the server when the user declines | elicitation-decline replay; real server QA only |
| cancels when interrupted at the approval card | Runtime-only interrupted approval elicitation |
| cancels when interrupted at the question card | Runtime-only interrupted question elicitation |
| tells the server when the session closes on an open question | Runtime-only close during elicitation |
| accepts a form with no fields straight from the approval card | Runtime-only empty form elicitation |
| passes an HTTP MCP server with its header from the environment | driver.test.ts pure MCP conversion case |

## Dispatcher tools (#3615)

`dispatcher-tools.runtime.qa.ts` has no standard counterpart beyond the driver, spawn and gate unit tests for `loadAllTools`. A BYOK model gets no tool search unless a session asks, and no BYOK setting reaches the capability a hosted model turns it on with. So the defect is shown with search forced on: `tool_search_tool` leaves out a tool the session already loaded, before and after a resume, for the coordinator (`create_managed_agent`) and the chat (`start_work`). The fix is checked on a driver whose test-only `sessionDefaults` turn search on below the driver's own settings, as a hosted model's would. Those checks fail without `loadAllTools`: every bridge tool is offered at start, after a connected agent wakes and sleeps, after a resume, after a compaction, and when a session that searched before resumes. The CLI still asks before a Clubhouse tool that changes things at Ask. At 119 and 120 tools in all everything loads and nothing is logged. At 121, or the turn after the catalog grows past 120 mid-session (as connected agents wake), the runtime defers every MCP tool behind its search, as on main, and the driver warns once. Set `COPILOT_QA_MEASURE_OUT` to record request sizes. Whether the runtime ranks a real hosted default below the driver's setting the same way needs a real login, so it isn't shown.

## Other opt-in real CLI tests and CI

Standard main-project setup clears inherited `CLUBHOUSE_RECORD_COPILOT_SDK`, `CLUBHOUSE_CHECK_COPILOT_SDK_CHUNK`, `CLUBHOUSE_FAKE_MODEL_SMOKE`, `CLUBHOUSE_CHAT_HANDSHAKE_SMOKE`, and `CLUBHOUSE_LIVE_DRIVER_SMOKE` flags before loading tests. These suites remain available through `vitest.live-qa.config.ts`, with their original flags and assertions. They need their own explicit authorization and appropriate credential/network boundary. The scheduled chat-handshake workflow is separately configured real CLI QA; it is not a standard test or an egress sandbox.

The PR `copilot-sdk-chunk` job runs `--static-only`: it still builds and checks the SDK chunk size, assets, and modules, but does not launch the bundled runtime. The existing runtime handshake remains available in `check-copilot-sdk-chunk.mjs` without that flag for separately authorized, isolated QA. The static job cannot prove that the bundled SDK opens a real runtime under Node or Electron.
