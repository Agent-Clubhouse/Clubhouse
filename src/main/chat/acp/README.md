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
the command line, and `claims`. A claim covers a fact ACP v1 can't
advertise (`questions`: the agent asks with `elicitation/create`;
`usageContext`: it sends `usage_update`). It must come from the provider's
public docs. A claim never enables something `initialize` left off, and
`questions` only counts when Clubhouse advertised form elicitation.

## Lifecycle

- A turn is one `session/prompt`. It ends when the agent answers, with the
  stop reason it reported or with an error (a reported failure). ACP has no
  turn id, so no `nativeTurnId` is reported and `sendWithReceipt` isn't
  implemented.
- No steer: stable v1 has one prompt per turn, so `send` during a turn throws
  and the runtime queues (`queue: 'client'`).
- `interrupt` answers open permission requests and questions as cancelled (the
  protocol asks the client to) and sends `session/cancel`. The turn ends only
  when the agent answers the prompt, which it must do with `cancelled`.
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

## Not covered

Permission levels and modes (provider policy), `session/list`, compaction
(no ACP request), `additionalDirectories` (no start option carries them),
client `fs/*` and `terminal/*` (not advertised), URL elicitation, subagent
sessions, `authenticate` (logins happen in the CLI), and the stable update
kinds with no chat mapping yet (plan edits, notices, compaction, session
messages, mode changes).
