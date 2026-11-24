# Gate 3: changing effort when the agent offers no model choice

Status: implemented; the gate stays open until the proof below passes on the
composed head. This is registration gate 3 in `src/main/chat/acp/README.md`.

## The case

An ACP session can offer a `thought_level` select option without a `model`
option. Antigravity documents both pickers (Model and Thinking level), so its
normal path is `setModel(model, effort)`. This case only arises when a
session offers no model option, for example because the account gets a
single model. Then:

- `session_info.model` is `null` and `models` is `[]`, while `efforts` isn't
  empty and `capabilities.effortSwitch` is `'live'`.
- `setModel` can't help, because there's no model id to pass (it throws
  `This agent offers no model choice`).

## Decisions (integrator, 2026-11-24)

- The caller shape: an optional `setEffort` from the session up to the
  composer. Callers that have a model keep using `setModel`.
- The event: `model_changed.modelId` stays required, because existing
  consumers assume a string. The effort goes in an optional, additive
  `effort` field on `session_info`. Consumers that don't know the field
  ignore it.
- Mobile: `chat.setModel` with `model` omitted is an additive wire change.
  The phone team gets a separate note through the parent.

## What is implemented

| Layer | Change |
|---|---|
| Contract | `session_info.effort?: string \| null` (`shared/chat/events.ts`). `ChatDriverSession.setEffort?` and `AgentRuntime.setEffort?` (`shared/chat/runtime.ts`) |
| Neutral ACP driver | `setEffort(effort)`: the value must be one the `thought_level` option offers, and `null` throws because ACP has no unset. With no model id, the opening `session_info` carries `effort`, and later effort changes come as `session_info { effort }`. With a model id, nothing changes: `model_changed` as before |
| Runtime | `ChatAgentRuntime.setEffort` delegates, and refuses drivers without it |
| IPC and preload | `chat:set-effort` `[agentId, effort]` and `chat.setEffort` |
| Renderer | `chatStore.setEffort`: local over IPC, remote over `remoteChatBackend.setEffort`. The reducer takes `session_info.effort`. `useChatActions.setEffort`. `Composer` `onEffortChange`: `EffortPill` can change effort with no model and calls it then. `ChatView` passes it in |
| Mobile and Annex | `chat.setModel` with `model` omitted changes the effort alone through `runtime.setEffort`. Neither model nor effort is `invalid_command`. Refusals: `effort_switch_not_supported` (also when the runtime has no `setEffort`), `effort_default_not_supported`, `unknown_effort`. `chatControls` reads `session_info.effort`. `docs/mobile-control-v1.md` is updated |

Claude, Codex and Copilot don't implement `setEffort` and always report a
model, so nothing changes for them.

## Proof (tests on the branch)

- `acp/driver-claims.test.ts`, "effort without a model choice": the opening
  `session_info.effort`, `setEffort` sends `session/set_config_option` and
  reports `session_info { effort }` with no `model_changed`, refusals, and a
  session with a model still using `model_changed`.
- `mobile-chat-controls.test.ts`, "chat.setModel without a model": parsing,
  `chatControls`, setEffort only (never setModel), the refusals, and the
  model path unchanged.
- `chat-handlers.test.ts`: `chat:set-effort` passes the value through and
  rejects bad input.
- `chatStore.test.ts`: the reducer takes `session_info.effort`.
- `Composer.models.test.tsx`: with no model, the pill uses `onEffortChange`.
  Without it, it stays read-only as before. With a model, it uses
  `onModelChange`.
- `antigravity/driver.test.ts`: the Antigravity driver refuses `setModel`
  when there's no model option.

The gate closes when these pass on the composed head with typecheck and
lint, alongside the integrator's registration.
