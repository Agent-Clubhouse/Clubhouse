# Chat contract

Types that every part of the native chat runtime codes against. Design:
[`docs/structured-chat-research.md`](../../../docs/structured-chat-research.md) §7.

| File | What it defines | Who uses it |
|---|---|---|
| `events.ts` | `ChatEvent`, the normalized event model: envelope v2 (`agentId`, `sessionId`, `turnId`, `seq`, `ts`) and ACP-named event types | Drivers emit `ChatEventDraft`; the chat runtime stamps envelopes and writes the transcript; renderer, Annex and telemetry consume `ChatEvent` |
| `capabilities.ts` | `ChatCapabilities`, `ChatDriverId`, the five-level `PermissionLevel` ladder | Drivers publish capabilities in `session_started`; the UI downgrades by capability, never by provider id |
| `runtime.ts` | `AgentRuntime` (PTY and chat behind one interface), `ChatDriver` / `ChatDriverSession` (what a protocol transport implements), runtime-mode settings | Main process call sites (MCP, shoulder taps, group projects, Annex, restart) and the driver implementations |

## Flow

```
CLI ⇄ protocol client ⇄ ChatDriverSession ──ChatEventDraft──▶ chat runtime (main)
                                                              │ stamp envelope, seq
                                                              │ append transcript (JSONL)
                                                              ▼
                                                    chat event bus
                                       ┌───────────────┼────────────────┐
                                  renderer IPC      Annex          telemetry
                                  (chatStore)     forwarding      (when it lands)
```

## Rules

- **Additive only** within `v: 2`. Consumers ignore unknown event types and fields.
- **Order by `seq`**, which is per chat session and starts at 1. Don't order by `ts`.
- **Ids are Clubhouse's.** `sessionId` and `turnId` are Clubhouse ids. Native ids travel as `nativeSessionId` (on `session_started` / `session_info`) and `nativeTurnId` (on `turn_started`).
- **Late facts** (session id, capabilities, CLI version, title) arrive as `session_info`, which overrides what `session_started` said. Drivers emit `cliVersion` from their handshake as soon as they know it (the version-range check and `c.provider.cli_version` read it).
- **Clubhouse owns history.** The transcript of `ChatEvent`s is what the chat renders. The CLI's native session id is used only to resume the model's context.
- **Drivers stay thin.** They translate protocol traffic and report capabilities. Lifecycle, queueing for drivers without native queues, checkpoints, transcripts and fallback live in the chat runtime.
- **Capabilities, not provider checks.** If a feature differs by provider, add a field to `ChatCapabilities`.
- **Unknown native messages** become `protocol_unknown` events (the `c.chat.protocol.unknown` telemetry signal) rather than being dropped silently.
