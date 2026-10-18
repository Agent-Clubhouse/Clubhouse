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
- **Choices for the pickers** also travel on `session_info`. `models` (with the provider's own `costHint`), `efforts` and `levelNames` each replace the earlier value. For `models` and `efforts`, an empty array clears the list and an absent field leaves it unchanged. `levelNames` is the provider's name for each live level, shown under Clubhouse's level name (Copilot: Plan, Agent, Agent, allow all).
- **MCP servers** travel on `session_info` as `mcpServers`, each with a status (`connected`, `pending`, `needs_auth`, `failed`, `disabled`). A present list replaces the earlier one. Claude sends it from init's `mcp_servers`, so it's known after the first prompt; other drivers don't send it yet.
- **Clubhouse owns history.** The transcript of `ChatEvent`s is what the chat renders. The CLI's native session id is used only to resume the model's context.
- **Drivers stay thin.** They translate protocol traffic and report capabilities. Lifecycle, queueing for drivers without native queues, checkpoints, transcripts and fallback live in the chat runtime.
- **Capabilities, not provider checks.** If a feature differs by provider, add a field to `ChatCapabilities`.
- **Who emits what.** Drivers emit `turn_started` / `turn_ended` for every turn they run, plus message, thought, tool, permission, question, plan, subagent, usage, mode, model, command and error events. The chat runtime emits `session_started`, `session_state`, `session_ended`, `user_message`, `permission_resolved` and `question_resolved` itself, and tags turn-scoped events with the current `turnId` when a driver doesn't. A driver's own report of an answer the runtime gave is dropped, so one answer is written once; a driver's cancellation (`decision: 'cancelled'`, or `cancelled: true` on a question) still goes through.
- **Testing a driver.** `src/main/services/agent-runtime/fake-chat-driver.ts` is an in-memory driver the runtime tests use. Replay fixtures through your driver and assert the drafts it yields.
- **Context compaction** travels on `notice`. When a driver learns compaction has started (Codex `item/started` for a `contextCompaction` item, Claude `system/status` with `status: 'compacting'`, ACP `compaction_update` in progress) it sends code `compaction_in_progress` (`COMPACTION_STARTED`). A later notice with a code in `COMPACTION_SETTLED` (`context_compacted`, `compacted`, `compaction_completed`, `compaction_failed`, `compaction_cancelled`) settles it, and so do `turn_ended`, `session_ended` and a fatal `error`. The chat shows one running row in between; repeated start notices don't add rows.
- **Unknown native messages** become `protocol_unknown` events (the `c.chat.protocol.unknown` telemetry signal) rather than being dropped silently.
