# Copilot SDK test boundary

The standard `npm test` main project runs `driver.test.ts` and `fixture-replay.test.ts`. It does not launch the bundled Copilot runtime. The replay tests use the real driver and SDK with the repository's Node fake CLI, which binds a loopback server and replays committed protocol fixtures. The fake is source-controlled and has no outbound network client; this is not an OS network sandbox. Test child processes inherit a deliberately constructed environment and temporary home, rather than credentials, proxy settings or provider settings from the caller. Windows shims use `cmd.exe`; macOS and Linux use a shell shim. The fake invokes Node by absolute path.

The former `driver.test.ts` real-runtime describe and all of its assertions are retained in `driver.runtime.qa.ts`. Its independent discovery config is `vitest.copilot-runtime.config.ts`, invoked with `npm run qa:copilot-runtime`. It fails if the bundled runtime is missing. This is separately authorized QA: use a clean, allowlisted environment and an OS-enforced network sandbox that permits only loopback before invoking it. `--no-auto-login`, invalid tokens and a fake model alone are not an outbound network boundary, including for the probe. The repository currently documents a macOS sandbox profile in `docs/chat-fixtures.md`; Linux and Windows need independently verified sandbox arrangements. Do not run this command on an ordinary workstation or CI runner as a substitute for that boundary.

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
