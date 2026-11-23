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
- **An unknown model** is `session_info.model: null`: the session runs the provider's default and the driver doesn't know which model that is yet. A new Copilot session reports a placeholder until its first prompt resolves the configured model (#2293). The UI shows "Default model" until a `model_changed` names it, not the previous run's model.
- **Choices for the pickers** also travel on `session_info`. `models` (with the provider's own `costHint`), `efforts` and `levelNames` each replace the earlier value. For `models` and `efforts`, an empty array clears the list and an absent field leaves it unchanged. `levelNames` is the provider's name for each live level, shown under Clubhouse's level name (Copilot: Plan, Agent, Agent, allow all).
- **MCP servers** travel on `session_info` as `mcpServers`, each with a status (`connected`, `pending`, `needs_auth`, `failed`, `disabled`). A present list replaces the earlier one. Claude sends it from init's `mcp_servers`, so it's known after the first prompt; other drivers don't send it yet.
- **Clubhouse owns history.** The transcript of `ChatEvent`s is what the chat renders. The CLI's native session id is used only to resume the model's context.
- **Drivers stay thin.** They translate protocol traffic and report capabilities. Lifecycle, queueing for drivers without native queues, checkpoints, transcripts and fallback live in the chat runtime.
- **Capabilities, not provider checks.** If a feature differs by provider, add a field to `ChatCapabilities`.
- **Who emits what.** Drivers emit `turn_started` / `turn_ended` for every turn they run, plus message, thought, tool, permission, question, plan, subagent, usage, mode, model, command and error events. The chat runtime emits `session_started`, `session_state`, `session_ended`, `user_message`, `permission_resolved` and `question_resolved` itself, and tags turn-scoped events with the current `turnId` when a driver doesn't. A driver's own report of an answer the runtime gave is dropped whatever its decision (Codex reports "Deny and stop the turn" as `cancelled`), so one answer is written once. A driver's cancellation of a request the runtime never answered (an interrupt) still goes through.
- **Testing a driver.** `src/main/services/agent-runtime/fake-chat-driver.ts` is an in-memory driver the runtime tests use. Replay fixtures through your driver and assert the drafts it yields.
- **Context compaction** travels on `notice`. When a driver learns compaction has started (Codex `item/started` for a `contextCompaction` item, Claude `system/status` with `status: 'compacting'`, Copilot `session.compaction_start`) it sends code `compaction_in_progress` (`COMPACTION_STARTED`). A later notice with a code in `COMPACTION_SETTLED` (`context_compacted`, `compacted`, `compaction_completed`, `compaction_failed`, `compaction_cancelled`) settles it, and so do `turn_ended`, `session_ended` and a fatal `error`. The chat shows one running row in between; repeated start notices don't add rows.
- **Unknown native messages** become `protocol_unknown` events (the `c.chat.protocol.unknown` telemetry signal) rather than being dropped silently.

## Lifecycle contract

What a driver and the chat runtime promise about submissions, turns and requests today. It adds no "the provider processed it" or exactly-once guarantee. The conformance suite in `src/main/services/agent-runtime/lifecycle-conformance/` checks it through `ChatAgentRuntime` against each driver's fake transport (#3804).

### Submissions and turns

- **Send acceptance.** A send that resolves means the driver accepted it locally; it writes one `user_message` with the delivery the driver reported (`prompt`, `steer` or `queued`). It says nothing about the provider processing it: a failure the provider reports afterwards (a prompt RPC error, a failed turn) arrives as `error` and `turn_ended` with `error`, and the `user_message` stays as written. A send that rejects writes nothing and throws to the caller; Clubhouse treats it as not accepted. That is proven only where the rejection is a local refusal before dispatch or one the provider documents as non-acceptance (a Codex `turn/start` error), not by a rejected promise alone.
- **Reservations.** For each accepted `prompt` (and native `queued`) the runtime holds one reservation for a future `turn_started`, so input that arrives before the turn starts is not treated as idle. `hasPendingWork()` stays true while any reservation is held. A `steer` never holds one.
- **Retiring reservations.** A driver without `sendWithReceipt` retires one reservation per `turn_started`. A driver with `sendWithReceipt` retires a submission's reservation when its receipt names a native turn that has already started, is running or has completed, or names none (a steer, a command). Otherwise the reservation is retired when that turn's `turn_started` arrives (#3783).
- **Merged submissions must not leave phantom debt.** If a provider can fold a prompt sent while one of its operations is open into that operation, the driver's accounting must settle every submission. A driver can do that with a receipt that names the operation, or by reporting the second submission as a `steer`, or with another mapping backed by the provider's documented behavior. A shared stop reason or prompt response is not native operation identity. A driver without receipts whose provider merges prompts leaves one reservation behind per merge (the #3782 mechanism). Later causal input then queues with nothing to drain it.
- **Client queue.** Messages held in the runtime's own queue (no steer, Actions, causal input) are sent one at a time at turn end, each exactly once. An Action's `onSettled` reports `delivered` once it is handed over. It reports `dropped`, `expired` or `replaced` only for items that were never handed over.

### Stop, interrupt and settlement

- **A turn ends when the provider says so.** `interrupt()` asks. The turn ends with whatever the driver later reports (`cancelled`, `end_turn`, `error`). The runtime never ends a turn on its own, and a provider that reports nothing leaves the turn running.
- **Requests.** The runtime writes `permission_resolved` / `question_resolved` only for an answer it gave (`by: 'user'` or `'annex'`), once, and drops the driver's echo of it. A driver's own resolution of a request the runtime never answered (a provider cancel or timeout, an interrupt) is written as the driver reports it, and closes the request in Clubhouse: its options and desktop/Annex queue entry are withdrawn (reason `closed by provider`), the state returns to `running`, and a later answer is refused without reaching the provider. If the provider closes a request while Clubhouse's answer to it is in flight and the driver then refuses that answer, the provider's record is written and the request stays closed.
- **Stale sessions.** After `clearContext()` the old driver session's events are ignored, and its late receipts cannot re-grant a reservation in the new conversation.

### Disconnect and unknown outcomes

- When a driver's event stream ends, the runtime writes `session_ended` and settles its own records. Mirrored permission entries are withdrawn, open questions forgotten, the client queue discarded (`dropped`), reservations and the open turn retired (`hasPendingWork()` is false), and the state becomes `sleeping`.
- **Held input stays unsent.** A driver reports `isClosed()` once its transport is ending. The runtime then dispatches nothing more from its own queue, so input held there when a driver closes its turn on exit is dropped with the session, never sent into the dead transport. A Codex request made after app-server exited rejects at once (`ProcessExitedError`) rather than waiting for the RPC timeout. It writes no `turn_ended`, `permission_resolved` or `question_resolved` of its own. Accepted input keeps its `user_message` as written, and its outcome is unknown.
- **Nothing is retried automatically.** A submission whose send failed, or that was in flight when the transport ended, is never sent again by Clubhouse.
- **Local closure is not a provider outcome.** Codex, Claude and Copilot close their own open turn (`turn_ended` with `error`, or `cancelled` after an interrupt or a close) and requests (`permission_resolved` `cancelled` by `agent`) when the process exits. That records the driver's bookkeeping. The provider reported none of it. The schema cannot mark the difference: `TurnStopReason` and `permission_resolved.by` have no "outcome unknown" or "closed by Clubhouse" value. Consumers must not read those events as proof of what the provider did. A new driver that has nothing from the provider emits nothing.

### Bounded output

Today the runtime and transcript keep driver events whole; the driver event queue (`AsyncQueue`) is unbounded. Size bounds apply where events leave the desktop: `annex-chat-bounds.ts` previews oversized tool calls, tool updates and permission inputs over Annex, with a visible note in the text. The live transcript is never cut.

### Known gaps (#3804)

The conformance matrix in each `*.conformance.test.ts` lists what each driver runs, skips by trait, or is blocked on.

- **Copilot requests settled elsewhere.** SDK 2.0.0 reports them as `permission.completed` and `user_input.completed`; the driver does not map them, and its permission handler is given no request id (only `toolCallId`). Blocked for Copilot and pinned in its conformance file.
- **Questions.** A question the provider closes while Clubhouse's answer is in flight, then refused by the driver, is reopened as before; only permissions handle that race.
- **Provenance.** A driver's local closure on disconnect still reads like a provider outcome in the transcript (see "Local closure is not a provider outcome").
