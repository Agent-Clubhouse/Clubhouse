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
