# Gate 3: changing effort when the agent offers no model choice

Status: open. This is a proposal for review, and no code here implements it.
It closes registration gate 3 in `src/main/chat/acp/README.md`.

## The case

An ACP session can offer a `thought_level` select option without a `model`
option. Antigravity documents both pickers (Model and Thinking level), so its
normal path is `setModel(model, effort)`. The case comes up only when a
session offers no model option, for example because the account gets a
single model. When that happens:

- `session_info.model` is `null` and `models` is `[]`, but `efforts` is
  not empty and `capabilities.effortSwitch` is `'live'`.
- The neutral driver's `setModel` throws `This agent offers no model choice`
  for every model id (`driver.ts`, `setModel`).

## Callers today (base 6984704eb)

| Caller | Path | Behaviour in this case |
|---|---|---|
| Desktop composer | `Composer.tsx` `EffortPill` (`canChange = !!model && ...`) → `ChatView.tsx:402` `actions.setModel(m, e)` → `chatStore.ts:1350` → IPC `chat:set-model` (`chat-handlers.ts:338`) → `ChatAgentRuntime.setModel` (`chat-runtime.ts:1403`) → `session.setModel` | The pill is hidden because `model` is null, so effort can't be changed |
| Desktop as Annex client | `chatStore.ts:1351` → `remoteChatBackend.ts:151` `setModel(ns, session, model, effort)` → the satellite's mobile-control | Same pill, also hidden |
| Phone and Annex | `mobile-control.ts:329` `chat.setModel { model, effort }`, which requires a `model` (`shared/mobile-control.ts:50`) | Sending the current model `null` isn't possible. Any model id the phone sends fails at the driver |

## Proposal

Add one optional runtime and session method, `setEffort(effort: string | null)`.
A driver implements it only when it can change effort on its own.

1. `ChatDriverSession.setEffort?(effort: string | null): Promise<void>` in
   `shared/chat/runtime.ts`. The neutral ACP driver implements it with
   `session/set_config_option` on the `thought_level` option. `null` throws,
   as `setModel` does today, because ACP has no "unset".
2. `ChatAgentRuntime.setEffort` and `AgentRuntime.setEffort?` delegate to it.
3. IPC `chat:set-effort` with `[agentId, effortArg]`, and preload
   `chat.setEffort`.
4. `chatStore.setEffort`: local goes through IPC. Remote goes through
   `remoteChatBackend.setEffort`, which sends mobile `chat.setModel` with
   `model` omitted (step 5).
5. Mobile contract: in `chat.setModel`, `model` becomes optional. With
   `model` absent, mobile-control checks `effortSwitch !== 'none'` and that
   the effort is in `efforts`, then calls `runtime.setEffort`. This is an
   additive wire change, so older phones keep sending a model. The mobile
   contract doc and its fixtures need the same edit, and the phone team gets
   a note.
6. Composer: `EffortPill` gets `canChange = efforts.length > 0 && effortSwitch !== 'none' && (!!model || !!onEffortChange)`
   and calls `onEffortChange(effort)` when `model` is null. `ChatView`
   passes `actions.setEffort`.

Callers that pass a model keep using `setModel`, so nothing changes for
Claude, Codex or Copilot. None of them implements `setEffort`, and none
reports `model: null` together with efforts.

## Proof needed to close the gate

- Driver: `setEffort('high')` on a session with only a `thought_level`
  option sends `session/set_config_option` and emits `model_changed` only
  when a model id exists. Otherwise it emits a `session_info` effort update,
  which needs a decision on the event.
- Runtime, IPC and mobile-control unit tests for the effort-only path,
  including refusing an effort the session doesn't offer.
- A Composer test: the effort pill shows and works with `model` null.
- The existing setModel tests for the other drivers stay unchanged.

## Open question for the integrator

`model_changed` requires a `modelId`. An effort change with no model needs
either `model_changed` with an optional `modelId`, or a `session_info`
`effort` field. Which shape do you want? The event change touches the
transcript and Annex, so it belongs to the shared event contract.
