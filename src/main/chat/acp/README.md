# Provider-neutral ACP chat layer

A chat driver for any agent that speaks the Agent Client Protocol (stable v1)
over stdio (#3796). It isn't registered for any provider: a provider driver
calls `createAcpChatDriver(spec)` with its own `AcpLaunchSpec` and registers
the result. Providers keep their own integrations (Claude Agent SDK, Codex
app-server, Copilot SDK); nothing moves to ACP and nothing falls back to it.

| File | What it does |
|---|---|
| `protocol.ts` | The stable-v1 subset Clubhouse speaks, from the vendored schema (`schema/`, see `schema/PROVENANCE.md`) |
| `connection.ts` | JSON-RPC 2.0 peer over any transport, including `$/cancel_request` both ways |
| `stdio.ts` | The stdio transport: spawns the launch spec's command |
| `capabilities.ts` | `ChatCapabilities` from negotiated facts, observed session facts and the spec's static claims |
| `mapper.ts` | ACP values to chat drafts and back (prompts, MCP servers, updates, questions) |
| `driver.ts` | `createAcpChatDriver` and the session lifecycle |
| `testing/scripted-agent.ts` | An in-memory scripted agent built from the schema, not a recording |
| `testing/stdio-agent.mjs` | A minimal stdio agent for the transport test |

## Launch spec

`AcpLaunchSpec` is the only provider hook: driver id, provider id, `optIn`,
the command line (which gets the start's level, for a level set by a launch
flag), `claims`, `levels` and `loginHint`. A claim covers a fact ACP v1 can't
advertise (`questions`: the agent asks with `elicitation/create`;
`usageContext`: it sends `usage_update`; `steer`: a prompt written during a
turn joins it). It must come from the provider's public docs. A claim never
enables something `initialize` left off, and `questions` only counts when
Clubhouse advertised form elicitation.

`levels` maps permission levels to the agent's session modes (from a `mode`
config option, else the `modes` state). A level counts only when the session
offers its mode: a start at a level whose mode isn't offered is refused, never
run at another level, and `liveLevels` lists only offered modes. Levels set by
a launch flag (`processLevels`) need a restart. `loginHint` turns
`Authentication required` (-32000) during setup into a login error with the
provider's own sign-in steps. Each is off when absent, and the driver then
behaves as before (`driver-claims.test.ts` pins that).

## Lifecycle

- A turn is one `session/prompt`. It ends when the agent answers, with the
  stop reason it reported or with an error (a reported failure). ACP has no
  turn id, so no `nativeTurnId` is reported and `sendWithReceipt` isn't
  implemented.
- No steer without the `steer` claim: the stable schema has no steer method,
  so the driver advertises none, `send` during a turn throws, and the runtime
  queues (`queue: 'client'`). With the claim, a `steer` send writes another
  `session/prompt` into the running turn and returns `'steer'`. How the agent
  answers the two isn't in the schema, so the turn ends only when every
  prompt in it has been answered, with the last answer's stop reason. An
  error answer to a steered prompt before then is a non-fatal error, plus a
  `steer_not_delivered` notice quoting it (it may not have reached the turn).
  Nothing is resent. This answer order is an assumption until checked on the
  real agent (Antigravity: #3802 V13).
- `interrupt` answers open permission requests and questions as cancelled (the
  protocol asks the client to) and sends `session/cancel`. The turn ends only
  when the agent answers the prompt, which it must do with `cancelled`. If the
  agent is lost before that answer, the outcome stays unknown.
- An error answer to `session/prompt` is a reported failure: the session
  stays open, the turn ends as `error`, and the prompt isn't sent again. It
  arrives after `send` has returned, since a prompt is answered only when its
  turn ends.
- The agent withdrawing a request with `$/cancel_request` is reported as
  cancelled by the agent.
- When the transport ends, the driver reports `process_exited` and nothing
  else. An unanswered prompt and open requests stay unresolved: their outcome
  is unknown, and no completion is invented.
- A failed prompt is never retried.
- `session/load` replays history Clubhouse already has, so replayed updates
  only refresh session state. `session/resume` is preferred when advertised.
  A session the agent no longer has (`-32002`) continues fresh with a notice.

## Conformance (#3804) traits

`mergesPrompts: false`, `steersRunningTurn: false`, `interruptReport:
'provider_reports'`, `permissions: true`, `questions`: per claim,
`nativeResolution: true` (`$/cancel_request`), `disconnectClosure: 'none'`.
`acp.conformance.test.ts` runs the shared suite against the scripted agent.

## What the tests prove

- The protocol, lifecycle and conformance tests run against an in-memory
  scripted agent built from the schema. None of them is a real ACP agent.
- `stdio-connector.test.ts` drives the stdio connector with a stubbed child
  process, on every platform:
  - while stdin isn't writable, or after the transport has ended, `send`
    throws and nothing is written;
  - a stdin error after a prompt was written (the agent stopped reading)
    ends the session once: the turn stays unknown, there's no `turn_ended`,
    nothing is resent and a later send is refused;
  - an error or exit after that end changes nothing.
- `stdio.test.ts` runs a real child process (`testing/stdio-agent.mjs`). Its
  stop-reading case (EPIPE after a write) runs on POSIX only: on Windows the
  child closing its stdin didn't make the parent's write fail, so real
  stop-reading behaviour there is unproven.
- Prompts have no timeout: an agent that never answers keeps its turn
  running until the session ends.

## Before registration

A provider driver built on this layer isn't registered until these are done:

1. Done: a deterministic test of the stdio connector's direct guard and
   stdin error handling (`stdio-connector.test.ts`).
2. Open: a real-process check on Windows of an agent that stops reading
   stdin while it keeps running. `stdio-liveness.test.ts` is the check: an
   established session whose agent stops reading mid-turn and stays alive,
   with no pipe broken, on every platform. The contract it proves is bounded
   by Stop, with no prompt timeout:
   - the composer's Stop (Esc) is `interrupt()`: it writes `session/cancel`
     and settles nothing, so the turn stays open;
   - the agent's Stop (row menu or toolbar, Annex agent stop:
     `killAgent` → `ChatAgentRuntime.stop` → `session.close()`) is the only
     escape. It ends the owned process within the stop path's limits, the
     turn's outcome stays unknown, nothing is resent, and later sends are
     refused.
   A steer written to such an agent is reported `'steer'` once written,
   though it's never read. POSIX runs locally; native Windows evidence needs
   a hosted windows-latest run, and the gate stays open until it passes.
3. Open: a caller contract for changing effort when the agent offers no
   model choice. `setModel` refuses any model id there, and current callers
   (the composer's effort menu, Annex) always pass a model id, so effort
   can't be changed for such an agent. The approved design is in
   `../antigravity/GATE-effort.md`.

## Not covered

Permission levels without a provider's `levels` policy, `session/list`, compaction
(no ACP request), `additionalDirectories` (no start option carries them),
client `fs/*` and `terminal/*` (not advertised), URL elicitation, subagent
sessions, `authenticate` (logins happen in the CLI), and the stable update
kinds with no chat mapping yet (plan edits, notices, compaction, session
messages). Mode changes are reported only when a `levels` policy maps the
mode back to one level.
