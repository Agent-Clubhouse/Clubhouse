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
{"version":1,"epoch":"uuid","controlAuth":"mtls-pinned-client","controlAvailable":true,"commands":["chat.send","chat.interrupt","chat.permission","chat.question","chat.queue.remove","agent.start","agent.stop","agent.spawn","agent.create","agent.update","project.setPinned","project.setInactive","helper.approve","helper.decline","chat.setModel","chat.setLevel","quick.dismiss","quick.clear"],"pairing":{"sessionRevokePath":"/api/v1/mobile/pairing"},"attachments":{"version":1,"imageTypes":["image/png","image/jpeg","image/gif","image/webp"],"maxImageBytes":3932160,"maxCount":10},"events":{"transport":"annex-websocket","replayRequest":"mobile:replay","queueState":"queue_state"},"createOptions":{"version":1,"path":"/api/v1/mobile/projects/{projectId}/create-options"},"agentSettings":{"version":1,"path":"/api/v1/mobile/agents/{agentId}/settings"},"helperRequests":{"version":1,"snapshotField":"helperRequests","commands":["helper.approve","helper.decline"]},"chatControls":{"version":1},"permissions":{"version":1,"persistentApprovals":true,"freeAgentMode":true},"idempotency":{"scope":"peer-and-epoch","maxEntries":2048,"ttlMs":3600000},"projectState":{"version":1},"finishedQuickAgents":{"version":1},"terminal":{"version":1,"projectShell":true,"agentShell":true,"agentAttach":true,"maxShellsPerConnection":8,"maxInputLength":65536}}
```

A 404 means unsupported: do not send mobile commands. Gate durable-agent creation on `commands` including `agent.create` and `createOptions.version >= 1`, settings on `agent.update` and `agentSettings.version >= 1`, and helper requests on `helperRequests.version >= 1`; older desktops offer quick agents (`agent.spawn`) only. Gate project pins and inactive marks on `projectState.version >= 1` (`projectState:{version:1}`); without it, keep them on the phone. See [Project state](#project-state). Gate the finished quick agents list ("Finished, waiting on you") on `finishedQuickAgents.version >= 1`; without it, keep the phone's own list of quick agents it saw exit. See [Finished quick agents](#finished-quick-agents). Gate the composer's model, effort and level controls on `chat.setModel` / `chat.setLevel` and `chatControls.version >= 1` ([Chat controls](#chat-controls)). Gate terminals on `terminal.version >= 1` ([Terminals](#terminals)). A new epoch invalidates command retries and replay cursors. A paired phone is a full controller, so it may open a shell on the desktop; there are still no arbitrary filesystem paths (a shell's directory comes from a registered project or agent), credentials, or gateway provisioning commands.

## Commands

`POST /api/v1/mobile/commands` JSON base `{version:1, commandId:"UUID-or-other-unique-id", epoch:"capabilities epoch", type:"..."}`. Commands reject unknown fields. Retry identical JSON with the same commandId; never assign a new ID after a lost reply. IDs are scoped to paired client identity and epoch. Reusing an ID for different content returns conflict. Receipts are retained for one hour, bounded at 2048 entries; capacity rejects new commands instead of evicting valid receipts. After expiry or host restart the result can be uncertain: reconcile state, do not blindly retry.

- `chat.send`: `{agentId, sessionId, text, delivery?, attachmentIds?}`; delivery `auto|prompt|steer|queued` (default auto). `attachmentIds` (1–10 distinct ids from the upload route below) sends images; `text` may then be `""` for an image-only message. See [Image attachments](#image-attachments).
- `chat.queue.remove`: `{agentId, sessionId, messageIds:["id"]}`; removes only messages still held in the runtime queue, returns `{removed:["id"]}`. A native-provider queue may return no removed IDs.
- `chat.interrupt`: `{agentId, sessionId}`; cancels the turn and keeps the session.
- `chat.permission`: `{agentId, sessionId, requestId, optionId}`; exact pending option required. Any offered option, persistent ones (`allow_session`, `allow_always`, `reject_always`) included, is answered as the desktop's approval dock answers it, when capabilities have `permissions.persistentApprovals`. Older desktops refuse persistent options with 403 `persistent_approval_not_supported`.
- `chat.question`: `{agentId, sessionId, requestId, answers}`; question-ID to string/string-array map.
- `chat.setModel`: `{agentId, sessionId, model, effort?}`; the composer's model and effort pills. See [Chat controls](#chat-controls).
- `chat.setLevel`: `{agentId, sessionId, level}`; the composer's permission level menu. See [Chat controls](#chat-controls).
- `agent.start`: `{agentId, message?, resume?}`; wake durable agent using desktop's configured runtime and permissions.
- `agent.stop`: `{agentId}`; stops agent process, including a start in progress.
- `agent.spawn`: `{projectId, prompt, model?, orchestrator?}`; quick agent under registered project with ask-first permission mode.
- `agent.create`: `{projectId, name, color, orchestrator?, model?, persona?, freeAgentMode?, useWorktree?, mcpIds?, branchName?, branchFrom?, folderName?}`; durable agent, as the desktop New agent page makes one. See [Durable agents](#durable-agents).
- `agent.update`: `{agentId, name?, color?, emoji?, orchestrator?, model?, runtime?, persona?, clubhouseMode?, freeAgentMode?, idleSleep?}`; at least one setting. See [Durable agents](#durable-agents).
- `project.setPinned`: `{projectId, pinned}`; pin or unpin a project in the desktop sidebar. See [Project state](#project-state).
- `project.setInactive`: `{projectId, inactive}`; mark a project inactive (idle until marked active) or active. See [Project state](#project-state).
- `quick.dismiss`: `{projectId, agentId}`; dismiss one finished quick agent. See [Finished quick agents](#finished-quick-agents).
- `quick.clear`: `{projectId}`; dismiss all of a project's finished quick agents. See [Finished quick agents](#finished-quick-agents).

- `helper.approve`: `{requestId, force?}`; approve a helper start or dispose an orchestrator asked the user to decide. `force:true` is the desktop's "Dispose anyway". See [Helper requests](#helper-requests).
- `helper.decline`: `{requestId}`; decline it. The orchestrator is told, as from the desktop.

For `chat.send`, `result` is `{delivery:"prompt"|"steer"|"queued",messageId:"authoritative runtime ID"}`. The matching `user_message.data` additionally echoes `clientCommandId` equal to the request commandId, including queued/steered sends. The event may arrive before the receipt: reconcile by clientCommandId immediately, then by messageId; never guess by text or timestamps. Local/legacy sends omit the optional field.

Receipt on success: `{version:1,commandId,epoch,status:"completed",result:{...}}`. Completion means command dispatch completed, not agent turn completion. Errors: `{version:1,commandId?,epoch,status:"rejected"|"failed",error:{code,message}}`. `message` is the code, or for some refusals (`invalid_name`, `create_refused`, `agent_running`) a sentence the desktop would show; branch on `code` only. HTTP 400 invalid_command/unsupported_version; 403 client_certificate_required; 404 agent_not_found/project_not_found; 409 epoch_mismatch/command_conflict/session_mismatch/not_chat/pending_request_not_found/images_not_supported/attachment_unavailable, and the [chat controls](#chat-controls) refusals; 429 command_capacity; 500 command_failed. A failed command can have partial effects; retain its receipt and reconcile.

## Helper requests

An orchestrator whose control level asks before starting or disposing helpers sends those requests to the user (#159). The desktop shows them under Needs you; desktops that advertise `helperRequests: {version:1}` also list them in the Annex snapshot as `helperRequests`, and accept `helper.approve` / `helper.decline`. A paired phone has the desktop's full say. Without the capability, don't show them and don't send the commands.

`helperRequests` is every waiting request in a registered project, oldest first. A fresh snapshot is broadcast whenever one is added, answered (from the desktop or a phone), expires, or changes; replace the whole list from each snapshot.

```json
{"requestId":"hstart_…","kind":"start","projectId":"proj_1",
 "requester":{"agentId":"durable_orch","name":"Planner"},"helper":{"agentId":null,"name":"impl-ipc"},
 "requestedAt":"2026-10-26T09:00:00.000Z","expiresAt":"2026-10-27T09:00:00.000Z",
 "summary":"Wants to start the helper impl-ipc",
 "start":{"task":"Wire the IPC","persona":null,"model":"opus","access":null,"branchFrom":null}}
{"requestId":"hdispose_…","kind":"dispose","projectId":"proj_1",
 "requester":{"agentId":"durable_orch","name":"Planner"},"helper":{"agentId":"durable_docs","name":"Docs"},
 "requestedAt":"2026-10-26T10:00:00.000Z","expiresAt":null,
 "summary":"Planner asked to dispose this helper (forced). 2 uncommitted files, 1 unpushed commit.",
 "dispose":{"uncommittedFiles":2,"unpushedCommits":1,"unmergedCommits":0,"checkError":null,"forceRequested":true,"workAtRisk":true,"canDispose":true}}
```

`summary` is the desktop's Needs you line. A start's helper has no id until it is approved; `start.access` is `null` for "same as the orchestrator". A start expires at `expiresAt` (24 hours); a dispose waits until it is answered. Unmerged commits are information only: disposing never deletes a remote branch.

The rules are the desktop's:

- **Start.** Approve runs every start check except the control level. If the orchestrator isn't running, or orchestration is off for it, the request stays waiting and the command is rejected with `helper_start_blocked`; wake the orchestrator and approve again. Result `{requestId, kind:"start", approved:true, helperId}`.
- **Dispose.** The desktop checks the helper again, stops it if it runs (waiting for it to exit), checks once more, then disposes. `canDispose:false` (a check couldn't run, `checkError`) means only Decline; approve is rejected with `helper_check_failed`. `workAtRisk:true` (uncommitted files or unpushed commits) needs `force:true`, labelled "Dispose anyway"; without it approve is rejected with `helper_work_at_risk`. Never send `force` because the orchestrator asked for it (`forceRequested`): only the user's own Dispose anyway counts. If more is at risk than the phone was shown, nothing is disposed (`helper_work_changed`). Result `{requestId, kind:"dispose", approved:true, stopped}`.
- **Decline.** Nothing changes. Result `{requestId, kind, declined:true}`.

When a dispose finds new facts the request is reissued under a **new `requestId`** with the new checks, and a snapshot is broadcast. An answer to the old id is `helper_request_not_found`, so a phone can never confirm facts it didn't show. Refetch the snapshot after any `helper_*` rejection.

Errors (`message` is the desktop's sentence for all but `helper_request_not_found`): 404 `helper_request_not_found` (answered, expired, dropped or reissued); 409 `helper_start_blocked`, `helper_check_failed`, `helper_work_at_risk`, `helper_work_changed` (`status:"rejected"`, the request still waits); 409 `helper_start_refused`, `helper_dispose_failed` (`status:"failed"`; a refused start was used up; a failed dispose may have stopped the helper).

## Image attachments

Desktops that support them advertise `attachments: {version:1, imageTypes, maxImageBytes, maxCount}` in capabilities; without it, send text only. Images go in two steps: upload each one, then name the ids in `chat.send`.

**Upload:** `POST /api/v1/mobile/agents/:agentId/attachments` with the raw image bytes as the body and `Content-Type` set to one of `imageTypes` or `application/octet-stream`. Same pinned client certificate as commands (a bearer token alone gets 403). No JSON wrapper, no base64. The desktop sniffs the bytes (the declared type never counts) and stores the image exactly as a desktop paste. Success, HTTP 200:

```json
{"version":1,"attachmentId":"uuid","mimeType":"image/png","bytes":123456,"width":1179,"height":2556}
```

`width`/`height` are omitted when the header can't be read. Errors are `{version:1,error:"code"}`:

| HTTP | error | meaning |
| --- | --- | --- |
| 400 | `empty_body` / `upload_failed` | no bytes / unreadable request |
| 403 | `client_certificate_required` / `authorization_revoked` | not the pinned client certificate, or trust changed mid-upload |
| 404 | `agent_not_found` | unknown or disposed agent |
| 409 | `not_chat` | the agent isn't a running chat agent (start it first) |
| 409 | `images_not_supported` | the agent's `capabilities.images` isn't `true` |
| 413 | `too_large` | over `maxImageBytes` (3.75 MB; checked from Content-Length before reading, the connection then closes) |
| 415 | `unsupported_media_type` / `unsupported_image` | wrong Content-Type / bytes aren't PNG, JPEG, GIF or WebP |
| 429 | `rate_limited` / `quota_exceeded` | per-peer limits below; honor `Retry-After` (seconds) |

Limits per paired peer: 20 uploads a minute, and 200 uploads or 256 MB per rolling 24 hours (refused uploads with a valid Content-Type count too). Downscale or recompress on the phone to fit `maxImageBytes`; the desktop never resizes.

An `attachmentId` belongs to the peer and agent that uploaded it and lives 24 hours (or until desktop restart). It can be sent more than once. Uploading is not idempotent: retrying an upload after a lost reply gives a new id, which is harmless.

**Send:** `chat.send` with `attachmentIds`. The ids are part of the command fingerprint, so a retry must repeat them in the same order. Rejections (`status:"rejected"`, HTTP 409): `images_not_supported` (the running session can't take images; check `capabilities.images` in the chat snapshot), and `attachment_unavailable` (an id that is unknown, expired, another peer's or another agent's, or whose file vanished). Nothing is sent when any id fails.

**Echo:** the `user_message` event carries the images as content blocks `{type:"image", mimeType, mediaRef?, width?, height?, path?}`. `path` is only the file name. Fetch the bytes through `/content?mediaRef=` ([mobile-phone-content.md](mobile-phone-content.md)). Reconcile with your optimistic bubble by `clientCommandId` as for text.

## Snapshot agent avatars

The Annex snapshot carries what the desktop's `AgentAvatar` draws, so a phone can match it. These fields are additive; older desktops omit them.

- Durable agents (`agents[projectId][]`, and `GET /api/v1/projects/:id/agents`): `color`, `emoji` (a string, or `null` when unset; set through `agent.update`), and the icon as `agentIcons[agentId]`. When `emoji` is set the desktop draws it in place of initials.
- Quick agents (`quickAgents[projectId][]`): `color`, always `"gray"`. Quick agents don't inherit their parent's colour.

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

## Chat controls

Desktops that support them (#2462) advertise `chat.setModel` and `chat.setLevel` in `commands` and `chatControls: {version:1}` in capabilities. They are the desktop composer's level, model and effort pills.

**Read.** A live chat snapshot carries `chatControls`; it is `null` for a sleeping agent or a readOnly historical session:

```json
"chatControls":{"model":"opus","modelUnknown":false,"effort":"high","effortIsDefault":false,"effortReported":true,
 "level":"ask","models":[{"id":"opus","label":"Opus","description":"…","costHint":"1x"}],"efforts":["low","medium","high"],
 "levelNames":{"ask":"default","plan":"plan"},"liveLevels":["plan","ask","auto_edit","full_access"],
 "modelSwitch":"live"|"per_turn"|"restart"|"none","effortSwitch":"live"|"per_turn"|"restart"|"none","effortDefault":true,
 "switchNote":"Applies from the next message."|null}
```

- `model` is `null` with `modelUnknown:true` while the session runs the provider's default and hasn't named it: show "Default model".
- `efforts` belong to the current model. Another model's efforts are only known once the session runs it (a `session_info` replaces the list).
- `effortReported:false`: the session hasn't reported its effort yet; hide the effort chip rather than show "Default effort".
- `effortIsDefault`: `effort` is the level the provider picked, not one chosen. The menu checks "Default" when `effortDefault` is true.
- `level` labels are the desktop's: Plan, Ask first, Auto-accept edits, Auto, Full access. `levelNames` is the provider's own name for a level, shown under it. Offer the current level plus `liveLevels`, in that ladder order; the current level stays listed even when it can't be re-entered.
- Offer the model menu only when `models` is non-empty and `modelSwitch` isn't `none`; the effort menu only when `efforts` is non-empty and `effortSwitch` isn't `none`. Show `switchNote` under them.

**Live updates.** These fields change with the session's own chat events, which every client receives: `session_info` (lists, capabilities, `model`), `model_changed` (`modelId`, `effort`, `effortIsDefault`) and `mode_changed` (`level`). Fold them in the same way, or resnapshot. A change made from a phone or the desktop arrives the same way, once the driver applies it.

**`chat.setModel {agentId, sessionId, model, effort?}`.** `effort` is a string, `null` (the provider's default, only when `effortDefault`), or omitted. Omitted while switching model does what the desktop menu does: a chosen effort the current list still offers is kept; a default effort follows the new model's default. Result: `{model, effort, changed}`, where `effort` is what was sent (`null`: the provider's default) and `changed:false` means nothing was asked of the agent (same model, no effort). The change takes effect per `modelSwitch` / `effortSwitch`. Refusals (409): `model_switch_not_supported` (no model menu: `modelSwitch:"none"` or no `models`), `unknown_model` (not in `models`), `effort_switch_not_supported`, `effort_default_not_supported` (`null` without `effortDefault`), `unknown_effort` (not in the current model's `efforts`; checked only when the model stays the same).

**`chat.setLevel {agentId, sessionId, level}`.** `level` is one of `plan|ask|auto_edit|auto|full_access` (400 otherwise). Any level in `liveLevels`, raising included, is accepted: see [Permissions from a phone](#permissions-from-a-phone). Result: `{level, changed}`; the current level is `changed:false`. Refusals (409): `level_not_live` (not in `liveLevels`), `level_switch_not_supported`.

Both are idempotent like every command; every field is part of the fingerprint.

## Permissions from a phone

A paired phone has full control of the desktop's permission settings, the same as the desktop's own controls. A paired phone can already approve every request one by one, so these controls don't widen what it can do; they save it the taps. Pinned mTLS, idempotency and capability gating are unchanged.

Capabilities advertise what the desktop accepts: `permissions: {version:1, persistentApprovals, freeAgentMode}`. Older desktops have no `permissions`: they refuse persistent options (403 `persistent_approval_not_supported`) and `freeAgentMode` (403 `free_agent_mode_not_allowed`), and have no `chat.setLevel`.

- `persistentApprovals`: `chat.permission` answers persistent options (allow for the session, always allow, always reject).
- `chat.setLevel` accepts any live level, raising included (`chatControls.version >= 1`).
- `freeAgentMode`: `agent.create` and `agent.update` accept `freeAgentMode` (boolean), with the desktop's rules: see [Durable agents](#durable-agents).

## Durable agents

Create (#2451) and settings (#2452) follow the desktop New agent page and the Details → Settings card. Both reads need an authenticated client; the commands need the pinned client certificate like every mobile command.

**Free Agent Mode** (skip all permission prompts) is settable from a phone when capabilities have `permissions.freeAgentMode` ([Permissions from a phone](#permissions-from-a-phone)). As on the desktop, it needs an orchestrator with `permissions:true`: turning it on for one without is 409 `free_agent_mode_unavailable`; turning it off is always allowed. Omitted on create, the agent follows the project's agent defaults, as on the desktop. Older desktops refuse the field with 403 `free_agent_mode_not_allowed`.

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
 "freeAgentMode":{"allowed":true}}
```

`orchestrators` are the enabled ones, narrowed to the project's profile when it covers any, in the desktop's order; the first is the default. `available:false` (with `unavailableReason`) means the CLI isn't found; the desktop still lets you create such an agent. `permissions:false` means the CLI sets access itself. `chat` means the agent can run in chat (Chat preview on, and the provider has a chat driver). `models` may include custom IDs; any model string is accepted. `badge` and `unavailableReason` are omitted when absent. `suggestedName` is a fresh random name per request. `freeAgentMode.allowed` means `agent.create` takes `freeAgentMode`; offer the toggle only for orchestrators with `permissions:true`, as the desktop page does ("Free Agent Mode (skip all permissions)", otherwise "(not supported)").

### agent.create

Validation matches the desktop. All of it runs before anything is created:

- **name**: trimmed. With a worktree it becomes a folder and a git branch (unless `folderName` is given), so it must be a valid git name: 400 `invalid_name`, with the reason in `message`.
- **color**: one of the `colors` ids (400 `invalid_color`).
- **orchestrator**: one of `orchestrators` (409 `orchestrator_unavailable`). The default is `defaults.orchestrator`.
- **model**: `"default"` or omitted means the provider default.
- **freeAgentMode**: `true` skips all permission prompts. Needs an orchestrator with `permissions:true` (409 `free_agent_mode_unavailable`). Omitted follows the project defaults.
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
  "freeAgentMode":{"value":false,"editable":"sleeping"|"never"},
  "idleSleep":{"value":"inherit"|"never"|30,"minutes":30,"source":"agent"|"app","applies":true,"editable":"always"}},
 "options":{"orchestrators":[…],"personas":[…],"colors":[…],"idleSleep":{"minutes":[15,30,60,240],"appMinutes":30}},
 "details":{"branch":"brave-otter/standby","worktreePath":"/work/app/.clubhouse/agents/brave-otter","worktree":".clubhouse/agents/brave-otter",
  "mcpIds":["github"],
  "changes":{"available":true,"base":"main","noBase":false,"files":6,"additions":94,"deletions":51,"ahead":2,"uncommitted":1}}}
```

`options` uses the same shapes as create options.

`details` is what Agent details shows besides the settings: the agent's hover card and Changes card. Older desktops leave it out, so treat it as optional:

- **branch**, **worktreePath**: null when the agent has no worktree. **worktree** is the worktree relative to the project folder, as the hover card shows it, or the whole path when it's elsewhere.
- **mcpIds**: the MCP servers set for the agent in Clubhouse. Which ones a running chat agent loaded, with their status, comes from the chat session's `session_info.mcpServers`.
- **changes**: the branch against main, as the Changes card's summary: counts only, never file names or diffs. `available` is false outside a git work tree; `noBase` means there's no main line to compare with. `ahead` is commits since the branch left main, `uncommitted` is uncommitted and untracked files. `null` while the agent is being created or when git can't be read. It isn't part of the `agent.update` result.

`editable` says when a setting can change:

- `always`: at any time, applied live.
- `sleeping`: only while `sleeping` is true. These are read at spawn and applied on the next wake. Show the desktop's hint: "Sleep the agent to change these".
- `never`: not from a phone.

Field notes:

- **orchestrator**: `value` null means the project default. `resolved` is what it runs on.
- **runtime**: `resolved` is the runtime the agent runs in now (awake), or the one its next wake uses (asleep). It is `never` when chat isn't available for the agent's CLI.
- **clubhouseMode**: `true` means Clubhouse mode manages the agent. `false` means it keeps local overrides. `null` with `never` means the project isn't in Clubhouse mode.
- **idleSleep**: `minutes` and `source` are the resolved timeout, where 0 means never. An inherited value follows the app's chat idle timeout (`options.idleSleep.appMinutes`). Desktop copy: "After 30 min idle" / "Never", summary "Sleeps after 30 min" / "Never sleeps". Only chat agents idle-sleep (`applies`), but the value is kept either way.
- **freeAgentMode**: `sleeping` when the agent's orchestrator has permission support, else `never` (the Settings card's Access row: "Free agent" / "Ask before edits").
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
- **freeAgentMode**: boolean. `true` needs an orchestrator with permission support (409 `free_agent_mode_unavailable`).
- **idleSleep**: `"inherit"`, `"never"`, or one of `options.idleSleep.minutes`.

Rejections:

- A `sleeping` setting on an awake or starting agent is 409 `agent_running`, and nothing is saved.
- An agent still being created is 409 `agent_creating`.
- Instructions, skills, agent definitions, MCP JSON, permission rules, the launch wrapper and helpers are not accepted. Any unknown field is 400 `invalid_command`.

The receipt `result` is the settings payload above, without `version`, `epoch` and `options`. The desktop windows and other clients are told about the change through `snapshot:refresh`.

## Project state

The desktop sidebar folds projects into "N idle projects" (docs/chrome-redesign-spec.md §5.4). The state behind it now lives in the desktop's main process (`project-state.json` in userData), not renderer localStorage, so a phone sees the same pins, inactive marks and idle projects. Older desktops don't advertise `projectState` and don't send these fields; keep local pins and idle there.

The snapshot adds, for every project in `projects`:

```json
"projectState": {"proj_1": {"lastActivityAt": 1800000000000, "pinned": false, "inactive": false, "idle": true}},
"idleDays": 7
```

- `lastActivityAt`: epoch ms of the last project activity (an agent running or waking, a quick agent starting, a desktop tab opened), or `null` before the desktop has seen the project. Written at most once a minute per project.
- `idle`: computed by the desktop, so the phone doesn't re-implement the rule. A project is idle when it is unpinned, has no agent with status `running`, and is either marked inactive or had no activity for more than `idleDays` days. `idleDays` 0 means only marked projects are idle. The desktop also keeps its own selected project out of the idle section; that doesn't apply to a phone.
- Both fields are left out until the desktop has moved the state out of localStorage. That happens once, when a desktop window first opens after the update.

Commands follow the desktop's rules:

- `project.setPinned {projectId, pinned}`: pinning puts the project last among the pinned.
- `project.setInactive {projectId, inactive:true}`: refused with 409 `project_pinned` for a pinned project (unpin it first).
- `project.setInactive {projectId, inactive:false}`: clears the mark and counts as activity now, as on the desktop, so the project stops being idle.

Both return the project's entry, `{projectId, lastActivityAt, pinned, inactive, idle}`. Asking for the state the project already has succeeds. Errors: 404 `project_not_found`; 409 `project_state_unavailable` before the state has moved into main. After each command, and after every change made on the desktop, connected clients get a fresh `snapshot`.

## Finished quick agents

The desktop's project start page lists quick agents that have exited under "Finished, waiting on you", with Dismiss and Clear all. The list now lives in the desktop's main process (`finished-quick-agents.json` in userData), not renderer localStorage, so a phone sees the same list. It covers every quick agent, whether started on the desktop, by another agent, or from a phone, and outlives the ~60 s that an exited quick agent stays in `quickAgents`. Older desktops don't advertise `finishedQuickAgents` and don't send the field; keep the phone's own list there.

The snapshot adds, for every project in `projects` (an empty array when it has none):

```json
"finishedQuickAgents": {"proj_1": [{"agentId": "quick_1", "name": "swift-fox", "prompt": "Fix the flaky test", "summary": "Fixed the race in …", "exitCode": 0, "finishedAt": 1800000000000, "parentAgentId": "durable_1"}]}
```

- Newest first, at most 50 per project; older ones drop off, as on the desktop.
- `prompt` is the mission the agent was started with. `summary` is the agent's own summary, or `null` when it left none.
- `exitCode` is 0 when the agent left a summary, whatever its process exit code (quick agents are often stopped after finishing). `cancelled: true` is added when the user stopped it.
- `parentAgentId` is present when another agent started it.
- `finishedAt` is epoch ms.
- The field is left out until the desktop has moved the list out of localStorage. That happens once, when a desktop window first opens after the update.

Commands:

- `quick.dismiss {projectId, agentId}`: removes one entry. Dismissing one that isn't in the list succeeds.
- `quick.clear {projectId}`: empties the project's list.

Both return `{projectId, finishedQuickAgents: [...]}`, the project's list after the change. Errors: 404 `project_not_found`; 409 `finished_quick_agents_unavailable` before the list has moved into main. After each command, and after every change on the desktop (an agent finishing, a dismissal), connected clients get a fresh `snapshot`.

## Terminals

A paired phone is a full controller (maintainer decision, #2476), so it can open the same terminals as the desktop's Terminal tab: a shell at a project root or at an agent's worktree. It can also view and type into a terminal-mode agent's own PTY. Everything here is WebSocket-only and needs the pinned mTLS connection; a bearer connection gets `error {message: "Control messages require mTLS authentication"}`.

Capabilities: `terminal: {version:1, projectShell:true, agentShell:true, agentAttach:true, maxShellsPerConnection:8, maxInputLength:65536}`. Older desktops have no `terminal`. They accept `pty:spawn-shell` at the project root only (an `agentId` is ignored), send shell output to every client through replay, and have no `pty:close` or `pty:attach`.

### Shells

- `pty:spawn-shell {sessionId, projectId, agentId?}` → `pty:spawn-shell:ack {sessionId, cwd}`.
  - The phone picks `sessionId`: any string of 1–128 characters, unique among its open shells. A random UUID is a good choice.
  - The shell opens where the desktop's Terminal tab opens for the same selection. Without `agentId`, that's the project root. A durable agent opens at its worktree, or at the project root when it has none. A quick agent opens at the folder it runs in. `cwd` is the resolved absolute directory.
  - It's an interactive login shell (`$SHELL -il`, or the default shell on Windows), starting at 120×30. Send `pty:resize` once the view knows its size.
  - Spawning a `sessionId` the phone already owns replaces that shell.
- `pty:input {agentId: sessionId, data}` and `pty:resize {agentId: sessionId, cols, rows}`. These are the existing messages, keyed by `agentId`. `data` is at most `maxInputLength` UTF-16 code units.
- `pty:data {agentId: sessionId, data, outputSeq}` and `pty:exit {agentId: sessionId, exitCode}` go **only to the connection that spawned the shell**. They carry no top-level `seq` and are never kept for replay, so `replay` and `mobile:replay` never return shell output.
- `pty:close {sessionId}` → `pty:close:ack {sessionId}`. The shell is killed, and no `pty:exit` follows.
- Lifetime: a shell lives until it exits (`pty:exit`), the phone closes it, or **its connection drops**. Shells are not carried across reconnects; after one, spawn again. They also end when Annex stops.
- At most `maxShellsPerConnection` shells per connection.

### Attaching to an agent's PTY

For agents running in a terminal (`executionMode: "pty"`; chat and headless agents have no PTY):

- `pty:attach {agentId}` → `pty:attach:ack {agentId, buffer, outputSeq, cols?, rows?}`. `buffer` is the agent's current screen and scrollback, serialized as terminal output. `cols`/`rows` is the PTY's size, when known.
- Live output is the existing broadcast `pty:data {agentId, data, outputSeq}`, which every controller already receives. There is no subscription and no `pty:detach`: to stop viewing, stop rendering. `outputSeq` counts output in UTF-16 code units and is the count after its chunk. Drop frames with `outputSeq <= ack.outputSeq`; of a frame that straddles it, only the last `outputSeq - ack.outputSeq` units are new. Frames may arrive before the ack, so buffer them until it does.
- `pty:input {agentId, data}` types into the agent. `pty:resize {agentId, cols, rows}` resizes the agent's **real** PTY, and the desktop's view reflows with it. A phone shouldn't resize an agent PTY unless the user asks to; render at the snapshot's `cols`/`rows` instead.
- `pty:exit {agentId, exitCode}` (broadcast, as before) ends the view.

### Errors

Errors use the existing envelope with correlation fields: `error {message, op, sessionId?, agentId?}`. `op` is the request type. Shell errors carry `sessionId`, except input and resize, which carry the `agentId` they were sent with. Attach errors carry `agentId`.

| `message` | `op` | Meaning |
| --- | --- | --- |
| `invalid_session_id` | `pty:spawn-shell` | `sessionId` is missing, not a string, or longer than 128 characters. |
| `project_not_found` | `pty:spawn-shell` | No such project. |
| `agent_not_found` | `pty:spawn-shell`, `pty:attach` | Spawn: the agent isn't a durable agent of the project or a running quick agent in it. Attach: `agentId` is missing. |
| `session_in_use` | `pty:spawn-shell` | The id belongs to an agent, a desktop terminal, or another connection's shell. |
| `too_many_shells` | `pty:spawn-shell` | The connection already has `maxShellsPerConnection` shells. |
| *(spawn error text)* | `pty:spawn-shell` | The shell failed to start, for example when the worktree folder is missing. |
| `internal_error` | `pty:spawn-shell`, `pty:attach` | An unexpected desktop failure. |
| `session_not_found` | `pty:close`, `pty:input`, `pty:resize` | Close: the connection doesn't own this shell. Input/resize: it's another connection's shell. |
| `pty:input data exceeds 64KB limit` | `pty:input` | `data` is longer than `maxInputLength`. |
| `agent_not_terminal` | `pty:attach` | A chat or headless agent. |
| `agent_not_running` | `pty:attach` | No running PTY by that id, or the id is a shell rather than an agent. |
