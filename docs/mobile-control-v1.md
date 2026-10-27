# Mobile control v1 (additive Annex contract)

Implemented on codex/mobile-control-v1, desktop base eecbe20bf.

Existing Annex protocolVersion stays 2. Existing routes and WebSocket frames stay unchanged.
Discovery remains `_clubhouse-annex._tcp` with main TLS port and pairingPort TXT. Manual LAN / Tailscale host entry uses the same HTTPS/WSS protocol. No gateway is deployed.

## Trust and pairing

Mobile MUST pin SHA-256 of the server leaf certificate DER (uppercase colon-separated hex) after the user compares it with desktop Settings > Annex > TLS certificate fingerprint. Discovery and unauthenticated identity responses are hints, never trust roots. Never accept arbitrary TLS certificates or send a PIN over HTTP.

New `POST https://host:mainPort/pair` uses existing `{pin, publicKey, alias, icon, color}`. `publicKey` is base64 Ed25519 SPKI DER. Optional `pairingMode:"session"` stores peer trust only in memory until server stop/disconnect; no peer record is persisted. `pairingMode:"persistent"` (default) uses the existing peer store. The response echoes pairingMode. Integration must explicitly use session mode; a product UI must label it accurately and obtain user consent before persistent enrollment. Present a self-signed RSA client certificate whose CN is the lowercase colon-separated **first 16 bytes of SHA-256** of that publicKey (existing desktop identity format; 32 hex characters, not the full TLS pin). On HTTPS pairing desktop binds the *actual presented certificate* fingerprint to this peer. Once bound, the certificate pin is enforced on **all** REST and WebSocket mTLS authentication for that peer, including legacy routes; preexisting unpinned desktop peers retain their behavior. Tokens minted by HTTPS pairing are tied to the peer and invalidated on removal. Mobile commands require this pinned client certificate; bearer tokens alone never control agents, including HTTP fallback. The existing HTTP `/pair` remains for legacy desktops. No live pairing is performed as part of code implementation.

## Capability negotiation

Authenticated `GET /api/v1/mobile/capabilities` returns:

```json
{"version":1,"epoch":"uuid","controlAuth":"mtls-pinned-client","controlAvailable":true,"commands":["chat.send","chat.interrupt","chat.permission","chat.question","chat.queue.remove","agent.start","agent.stop","agent.spawn","agent.create","agent.update"],"pairing":{"sessionRevokePath":"/api/v1/mobile/pairing"},"events":{"transport":"annex-websocket","replayRequest":"mobile:replay","queueState":"queue_state"},"createOptions":{"version":1,"path":"/api/v1/mobile/projects/{projectId}/create-options"},"agentSettings":{"version":1,"path":"/api/v1/mobile/agents/{agentId}/settings"},"idempotency":{"scope":"peer-and-epoch","maxEntries":2048,"ttlMs":3600000}}
```

A 404 means unsupported: do not send mobile commands. Gate durable-agent creation on `commands` including `agent.create` and `createOptions.version >= 1`, and settings on `agent.update` and `agentSettings.version >= 1`; older desktops offer quick agents (`agent.spawn`) only. A new epoch invalidates command retries and replay cursors. No permission-level changes, raw shell commands, arbitrary filesystem paths, credentials, or gateway provisioning commands exist.

## Commands

`POST /api/v1/mobile/commands` JSON base `{version:1, commandId:"UUID-or-other-unique-id", epoch:"capabilities epoch", type:"..."}`. Commands reject unknown fields. Retry identical JSON with the same commandId; never assign a new ID after a lost reply. IDs are scoped to paired client identity and epoch. Reusing an ID for different content returns conflict. Receipts are retained for one hour, bounded at 2048 entries; capacity rejects new commands instead of evicting valid receipts. After expiry or host restart the result can be uncertain: reconcile state, do not blindly retry.

- `chat.send`: `{agentId, sessionId, text, delivery?}`; delivery `auto|prompt|steer|queued` (default auto).
- `chat.queue.remove`: `{agentId, sessionId, messageIds:["id"]}`; removes only messages still held in the runtime queue, returns `{removed:["id"]}`. A native-provider queue may return no removed IDs.
- `chat.interrupt`: `{agentId, sessionId}`; cancels the turn and keeps the session.
- `chat.permission`: `{agentId, sessionId, requestId, optionId}`; exact pending option required. Mobile only permits one-time allow/reject/cancel options, not persistent approval changes.
- `chat.question`: `{agentId, sessionId, requestId, answers}`; question-ID to string/string-array map.
- `agent.start`: `{agentId, message?, resume?}`; wake durable agent using desktop's configured runtime and permissions.
- `agent.stop`: `{agentId}`; stops agent process, including a start in progress.
- `agent.spawn`: `{projectId, prompt, model?, orchestrator?}`; quick agent under registered project with ask-first permission mode.
- `agent.create`: `{projectId, name, color, orchestrator?, model?, persona?, useWorktree?, mcpIds?, branchName?, branchFrom?, folderName?}`; durable agent, as the desktop New agent page makes one. See [Durable agents](#durable-agents).
- `agent.update`: `{agentId, name?, color?, emoji?, orchestrator?, model?, runtime?, persona?, clubhouseMode?, idleSleep?}`; at least one setting. See [Durable agents](#durable-agents).

For `chat.send`, `result` is `{delivery:"prompt"|"steer"|"queued",messageId:"authoritative runtime ID"}`. The matching `user_message.data` additionally echoes `clientCommandId` equal to the request commandId, including queued/steered sends. The event may arrive before the receipt: reconcile by clientCommandId immediately, then by messageId; never guess by text or timestamps. Local/legacy sends omit the optional field.

Receipt on success: `{version:1,commandId,epoch,status:"completed",result:{...}}`. Completion means command dispatch completed, not agent turn completion. Errors: `{version:1,commandId?,epoch,status:"rejected"|"failed",error:{code,message}}`. `message` is the code, or for some refusals (`invalid_name`, `create_refused`, `agent_running`) a sentence the desktop would show; branch on `code` only. HTTP 400 invalid_command/unsupported_version; 403 client_certificate_required; 404 agent_not_found/project_not_found; 409 epoch_mismatch/command_conflict/session_mismatch/not_chat/pending_request_not_found; 429 command_capacity; 500 command_failed. A failed command can have partial effects; retain its receipt and reconcile.

## Chat state and history

Authenticated `GET /api/v1/mobile/agents/:agentId/chat` returns `{version:1,epoch,agentId,sessionId,state,capabilities,events,lastSeq,truncated,pendingPermissions,pendingQuestions}`. Events use the existing ChatEvent schema. LastSeq here is **session-local**, distinct from Annex's global WS seq. Returned history is a bounded tail; pending interactions are included separately even when their events predate the tail. GET `/api/v1/mobile/agents/:agentId/chat/sessions` returns `{version,epoch,agentId,sessions:ChatSessionSummary[]}`. The chat snapshot accepts `sessionId` (optional), `beforeSeq` (exclusive, positive integer) and `limit` (1–2000, default 2000). It also returns `currentSessionId`, `readOnly`, and `nextBeforeSeq` (null when no older page). `lastSeq` always describes the full session, not the current page. Never send actions for a readOnly historical session. Pending interactions are independent of the requested page.

## Live events and replay

### Authoritative local queue

Chat snapshots add `queuedMessageIds: string[]`, `queueStateSeq: number`, and `queueRemovalSupported: boolean`. The IDs are the last published state of the runtime-owned queue, independent of history pagination. `queueStateSeq` is the session-local sequence of that state (zero before the first queue event), not the global Annex replay cursor. Native provider queues and historical sessions return `[]`, `0`, and `false`; do not offer local removal for provider-managed submissions.

Capabilities advertise `events.queueState: "queue_state"`. The additive rich event is `{type:"queue_state",data:{queuedMessageIds:["id"],transition:{messageIds:["id"],status:"queued"|"dispatching"|"delivered"|"failed"|"removed"}}` inside the normal ChatEvent envelope. The full ID list is authoritative for local cancellation. `dispatching` removes the item before sending; `delivered` means the driver send resolved, not that its turn completed. `failed` does not guarantee no provider effect, so do not automatically retry. Existing `user_message` and `queue_removed` events are unchanged. Merged MCP submissions share their original queue item ID via queuedWith.

For each session, apply a queue snapshot or event only if its queueStateSeq/event.seq is at least as new as the queue state already applied. Snapshot queue state can be newer than the returned transcript page, so track this watermark separately from chat history and Annex replay cursors. Never infer consumption from turn_started. Session termination makes remaining IDs non-cancellable; a new session resets the queue watermark.

Existing WebSocket `{type:"chat:event",payload:{agentId,event:ChatEvent},seq}` stays unchanged. Deduplicate rich events by `(agentId,sessionId,event.seq)`. Annex `seq` is the transport cursor.

Send `{type:"mobile:replay",epoch:"capabilities epoch",since:123}`. Replies use existing top-level `replay:start`, original event frames with `replayed:true`, and `replay:end`; each replay control frame includes `epoch`. Invalid/stale epoch, cursor beyond lastSeq, or missing retained events produces top-level `{type:"replay:gap",epoch,oldestAvailable,lastSeq}`. Resnapshot chat and project state on gap. Buffer live events while applying a snapshot/replay and deduplicate; do not advance the cursor to a snapshot's lastSeq before its data has been applied.

Chat event definitions: src/shared/chat/events.ts. Driver capabilities: src/shared/chat/capabilities.ts. Existing snapshots/projects/agents: src/main/services/annex-server.ts. Read runtime state/driver capabilities before presenting steer/approval actions. Errors, cancellation, waiting_input, waiting_permission, turn_ended and session_ended remain normal rich events.

## Review clarifications

- Transport loss does not cancel an accepted command. Reconnect and retry its exact commandId within the receipt window. Use chat.interrupt or agent.stop to cancel work deliberately.
- `failed/start_cancelled` means a stop or Annex shutdown interrupted startup; the process may briefly have existed. Reconcile agent state, and never treat this as a no-effect rejection.
- `rejected/authorization_revoked` means peer trust or the server epoch changed before a command reached its next side-effect boundary. Authorization and runtime identity are rechecked after asynchronous prerequisites.
- Mobile replay treats interior holes (including events purged when an agent exits) as replay:gap and requires resnapshot. Legacy replay behavior remains unchanged.
- A paired mobile certificate is a full Annex controller identity, not a restricted role. Its certificate pin applies across legacy routes too, but those routes retain their existing controller powers. Enrollment UI must describe that trust; no persistent enrollment is performed by this implementation work.

### Session-only self-revocation

Capabilities now includes `pairing: {sessionRevokePath:"/api/v1/mobile/pairing"}`. `DELETE` that path using the paired pinned client certificate to revoke **only the caller's in-memory session pairing**. Response: `{version:1,epoch,revoked:true,pairingMode:"session"}`. It invalidates that peer's bearer tokens and closes its mTLS and bearer WebSockets. No body or target identity is accepted. A persistent peer (including one shadowed by a session peer) receives HTTP 409 `{error:"persistent_pairing_requires_desktop"}` with no trust change; remove it in desktop settings. An unpaired caller receives 401, and bearer-only callers receive 403. If the phone is offline, local removal alone cannot revoke desktop memory: explain that it lasts until explicit desktop disconnect or Annex stop. Repeated DELETE after success is unauthorized because trust is already gone.

## Durable agents

Create (#2451) and settings (#2452) follow the desktop New agent page and the Details → Settings card. Both reads need an authenticated client; the commands need the pinned client certificate like every mobile command.

**Free Agent Mode is never settable from a phone.** `agent.create` and `agent.update` reject a `freeAgentMode` field, with any value, with 403 `free_agent_mode_not_allowed`: remote commands cannot elevate permissions. Created agents ask before edits. The current value is readable, as `editable:"never"`; change it on the desktop.

### Create options

`GET /api/v1/mobile/projects/:projectId/create-options` (404 `project_not_found`):

```json
{"version":1,"epoch":"uuid","projectId":"p1",
 "orchestrators":[{"id":"claude-code","displayName":"Claude Code","shortName":"CC","badge":"…","available":true,"unavailableReason":"…","permissions":true,"chat":true,"models":[{"id":"default","label":"Default"},{"id":"opus","label":"Opus"}]}],
 "personas":[{"id":"qa","name":"QA","source":"builtin"|"user"|"project"}],
 "colors":[{"id":"indigo","label":"Indigo","hex":"#6366f1"}],
 "mcp":{"catalog":[{"id":"ado","name":"Azure DevOps","description":"…"}],"defaults":["ado"]},
 "isGitRepo":true,"suggestedName":"brave-otter",
 "defaults":{"orchestrator":"claude-code","color":"indigo","model":"default","useWorktree":true},
 "freeAgentMode":{"allowed":false}}
```

`orchestrators` are the enabled ones, narrowed to the project's profile when it covers any, in the desktop's order; the first is the default. `available:false` (with `unavailableReason`) means the CLI isn't found; the desktop still lets you create such an agent. `permissions:false` means the CLI sets access itself. `chat` means the agent can run in chat (Chat preview on, and the provider has a chat driver). `models` may include custom IDs; any model string is accepted. `badge` and `unavailableReason` are omitted when absent. `suggestedName` is a fresh random name per request.

### agent.create

Validation matches the desktop. All of it runs before anything is created:

- **name**: trimmed. With a worktree it becomes a folder and a git branch (unless `folderName` is given), so it must be a valid git name: 400 `invalid_name`, with the reason in `message`.
- **color**: one of the `colors` ids (400 `invalid_color`).
- **orchestrator**: one of `orchestrators` (409 `orchestrator_unavailable`). The default is `defaults.orchestrator`.
- **model**: `"default"` or omitted means the provider default.
- **persona**: one of `personas` (400 `unknown_persona`). It is applied to the new worktree as the desktop does.
- **mcpIds**: unique catalog ids (400 `unknown_mcp`). Omitted means the project defaults when the agent starts.
- **useWorktree**: defaults to `isGitRepo`. `true` outside a git repo is 409 `not_git_repo`.
- **folderName, branchName, branchFrom**: need a worktree (400 `worktree_options_require_worktree`). They are git-name checked (400 `invalid_folder_name` / `invalid_branch_name`).

A conflict found at creation, such as a folder or branch already in use or a missing base branch, is 409 `create_refused` with the reason in `message`.

The receipt returns as soon as the agent's record exists. Its worktree is made in the background, as on the desktop:

`result: {agentId, projectId, name, branch, worktreePath, state:"creating"|"sleeping"}`

The snapshot (via `snapshot:refresh`) shows the agent, then its creation ending as ready (sleeping) or failed. To give it a first prompt, wait for it to leave `creating`, then send `agent.start {agentId, message}`.

### Settings

We chose a route rather than snapshot fields. The settings need disk and CLI reads: personas, model lists, CLI availability, the Clubhouse mode state. The snapshot is rebuilt on every refresh for every client, and an agent's settings change rarely.

`GET /api/v1/mobile/agents/:agentId/settings` (404 `agent_not_found`; durable agents only):

```json
{"version":1,"epoch":"uuid","agentId":"durable_1","projectId":"p1",
 "state":"sleeping"|"running"|"starting"|"creating"|"failed","sleeping":true,
 "settings":{
  "name":{"value":"brave-otter","editable":"sleeping"},
  "color":{"value":"indigo","editable":"sleeping"},
  "emoji":{"value":null,"editable":"sleeping"},
  "hasImageIcon":false,
  "orchestrator":{"value":null,"resolved":"claude-code","editable":"sleeping"},
  "model":{"value":"default","editable":"sleeping"},
  "runtime":{"value":"default"|"chat"|"terminal","resolved":"chat"|"terminal","editable":"sleeping"|"never"},
  "persona":{"value":null,"editable":"sleeping"},
  "clubhouseMode":{"value":true|false|null,"projectEnabled":true,"editable":"sleeping"|"never"},
  "freeAgentMode":{"value":false,"editable":"never"},
  "idleSleep":{"value":"inherit"|"never"|30,"minutes":30,"source":"agent"|"app","applies":true,"editable":"always"}},
 "options":{"orchestrators":[…],"personas":[…],"colors":[…],"idleSleep":{"minutes":[15,30,60,240],"appMinutes":30}}}
```

`options` uses the same shapes as create options.

`editable` says when a setting can change:

- `always`: at any time, applied live.
- `sleeping`: only while `sleeping` is true. These are read at spawn and applied on the next wake. Show the desktop's hint: "Sleep the agent to change these".
- `never`: not from a phone.

Field notes:

- **orchestrator**: `value` null means the project default. `resolved` is what it runs on.
- **runtime**: `resolved` is the runtime the agent runs in now (awake), or the one its next wake uses (asleep). It is `never` when chat isn't available for the agent's CLI.
- **clubhouseMode**: `true` means Clubhouse mode manages the agent. `false` means it keeps local overrides. `null` with `never` means the project isn't in Clubhouse mode.
- **idleSleep**: `minutes` and `source` are the resolved timeout, where 0 means never. An inherited value follows the app's chat idle timeout (`options.idleSleep.appMinutes`). Desktop copy: "After 30 min idle" / "Never", summary "Sleeps after 30 min" / "Never sleeps". Only chat agents idle-sleep (`applies`), but the value is kept either way.
- **hasImageIcon**: image icons are read-only from a phone. Setting an emoji replaces an image icon.

### agent.update

Send only what changed:

- **name**: trimmed. Git-name checked when the agent has a worktree (400 `invalid_name`).
- **color**: a `colors` id.
- **emoji**: up to 16 UTF-16 units. `null` clears it.
- **orchestrator**: one of `orchestrators` (409 `orchestrator_unavailable`).
- **model**: `"default"` clears it.
- **runtime**: `default`, `chat` or `terminal`. `chat` and `terminal` need chat to be available (409 `runtime_unavailable`).
- **persona**: one of `personas`, or `null` for the project default.
- **clubhouseMode**: boolean. Needs a Clubhouse mode project (409 `clubhouse_mode_unavailable`).
- **idleSleep**: `"inherit"`, `"never"`, or one of `options.idleSleep.minutes`.

Rejections:

- A `sleeping` setting on an awake or starting agent is 409 `agent_running`, and nothing is saved.
- An agent still being created is 409 `agent_creating`.
- Instructions, skills, agent definitions, MCP JSON, permissions, the launch wrapper, helpers and Free Agent Mode are not accepted. Any unknown field is 400 `invalid_command`.

The receipt `result` is the settings payload above, without `version`, `epoch` and `options`. The desktop windows and other clients are told about the change through `snapshot:refresh`.

