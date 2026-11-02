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
{"version":1,"epoch":"uuid","controlAuth":"mtls-pinned-client","controlAvailable":true,"commands":["chat.send","chat.interrupt","chat.permission","chat.question","chat.queue.remove","agent.start","agent.stop","agent.spawn","agent.create","agent.update","project.setPinned","project.setInactive","helper.approve","helper.decline","chat.setModel","chat.setLevel","quick.dismiss","quick.clear","dispatcher.setEnabled"],"pairing":{"sessionRevokePath":"/api/v1/mobile/pairing"},"attachments":{"version":1,"imageTypes":["image/png","image/jpeg","image/gif","image/webp"],"maxImageBytes":3932160,"maxCount":10},"events":{"transport":"annex-websocket","replayRequest":"mobile:replay","queueState":"queue_state"},"createOptions":{"version":1,"path":"/api/v1/mobile/projects/{projectId}/create-options"},"agentSettings":{"version":1,"path":"/api/v1/mobile/agents/{agentId}/settings"},"helperRequests":{"version":1,"snapshotField":"helperRequests","commands":["helper.approve","helper.decline"]},"chatControls":{"version":1},"slashCommands":{"version":1,"snapshotField":"slashCommands","event":"commands_available","maxCommands":200},"permissions":{"version":1,"persistentApprovals":true,"freeAgentMode":true},"orchestration":{"version":1},"idempotency":{"scope":"peer-and-epoch","maxEntries":2048,"ttlMs":3600000},"projectState":{"version":1},"finishedQuickAgents":{"version":1},"terminal":{"version":1,"projectShell":true,"agentShell":true,"agentAttach":true,"maxShellsPerConnection":8,"maxInputLength":65536},"dispatcher":{"version":1,"enabled":true,"flagOn":true,"newLayout":true,"projectId":"__dispatcher__","snapshotField":"dispatcher","event":"dispatcher:changed","commands":["dispatcher.setEnabled"]}}
```

A 404 means unsupported: do not send mobile commands. Gate durable-agent creation on `commands` including `agent.create` and `createOptions.version >= 1`, settings on `agent.update` and `agentSettings.version >= 1`, and helper requests on `helperRequests.version >= 1`; older desktops offer quick agents (`agent.spawn`) only. Gate project pins and inactive marks on `projectState.version >= 1` (`projectState:{version:1}`); without it, keep them on the phone. See [Project state](#project-state). Gate the finished quick agents list ("Finished, waiting on you") on `finishedQuickAgents.version >= 1`; without it, keep the phone's own list of quick agents it saw exit. See [Finished quick agents](#finished-quick-agents). Gate the composer's model, effort and level controls on `chat.setModel` / `chat.setLevel` and `chatControls.version >= 1` ([Chat controls](#chat-controls)). Gate terminals on `terminal.version >= 1` ([Terminals](#terminals)). Gate the composer's `/` menu on `slashCommands.version >= 1` ([Slash commands](#slash-commands)). Gate an agent's orchestration policy on `orchestration.version >= 1` ([Orchestration](#orchestration)). Gate the Dispatcher on `dispatcher.version >= 1` ([Dispatcher](#dispatcher)). A new epoch invalidates command retries and replay cursors. A paired phone is a full controller, so it may open a shell on the desktop; there are still no arbitrary filesystem paths (a shell's directory comes from a registered project or agent), credentials, or gateway provisioning commands.

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
- `agent.create`: `{projectId, name, color, orchestrator?, model?, persona?, freeAgentMode?, useWorktree?, mcpIds?, branchName?, branchFrom?, folderName?, orchestration?}`; durable agent, as the desktop New agent page makes one. See [Durable agents](#durable-agents).
- `agent.update`: `{agentId, name?, color?, emoji?, orchestrator?, model?, runtime?, persona?, clubhouseMode?, freeAgentMode?, idleSleep?, orchestration?}`; at least one setting. See [Durable agents](#durable-agents).
- `project.setPinned`: `{projectId, pinned}`; pin or unpin a project in the desktop sidebar. See [Project state](#project-state).
- `project.setInactive`: `{projectId, inactive}`; mark a project inactive (idle until marked active) or active. See [Project state](#project-state).
- `quick.dismiss`: `{projectId, agentId}`; dismiss one finished quick agent. See [Finished quick agents](#finished-quick-agents).
- `quick.clear`: `{projectId}`; dismiss all of a project's finished quick agents. See [Finished quick agents](#finished-quick-agents).
- `dispatcher.setEnabled`: `{enabled}`; turn the app-wide Dispatcher on or off, as Settings > Dispatcher does. See [Dispatcher](#dispatcher).

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
- The Dispatcher (`dispatcher.agent`): the durable shape, and in `agentIcons` too. It isn't in `agents`.

Each `snapshot` is complete, so replace the agent rows and `agentIcons` rather than merging them: an image that was removed is simply absent. A new snapshot follows any change to an agent's name, color, emoji or image, wherever it was made: Settings, `agent.update`, the `update_agent` MCP tool, the `clubhouse` CLI, or an edit to `agents.json`. An image's bytes are also at `GET /api/v1/icons/agent/:agentId`, the Dispatcher's too while it is on. See [Drawing a sender](#drawing-a-sender) for how to draw these.

### Snapshot size

Clubhouse Go closes a WebSocket with code 1009 on a frame over 16 MiB, and a phone that reconnects into the same frame never recovers. So a snapshot stays well under it:

- `agentIcons` and `projectIcons` are still data URLs, but of thumbnails: a PNG within 128 by 128 pixels, or a PNG, JPEG, GIF or WebP file as it is when that's 64 KiB or less and within 256 by 256. They're always raster: an SVG is sent as a PNG copy or left out, because `UIImage` can't draw one. Don't assume a size. A generated PNG is a still image, already upright. A file sent as it is keeps its own frames and EXIF, so draw a GIF's first frame and honor a JPEG's orientation.
- Icons in one snapshot total at most 4 MiB of data URL characters. Past that, icons are left out: the Dispatcher's is kept first, then projects', then agents', in list order.
- A snapshot frame over 8 MiB is sent with both maps empty. The other fields are always sent.
- An image that can't be made small enough is left out too: on Linux, that's any SVG, and any GIF or WebP that's large.

So `icon` set with no `agentIcons[id]` is normal. Use `GET /api/v1/icons/agent/:agentId` or `GET /api/v1/icons/project/:projectId`, or draw initials. Those routes serve the same thumbnail, or a 404 when there's none, so draw initials then. Images set through `update_agent`, `update_project` or the CLI that are over 256 KiB, or wider or taller than 256 pixels, are stored as a PNG within 256 by 256. Files on disk are otherwise left as they are.

## Chat state and history

Authenticated `GET /api/v1/mobile/agents/:agentId/chat` returns `{version:1,epoch,agentId,sessionId,state,capabilities,events,lastSeq,truncated,pendingPermissions,pendingQuestions}`. Events use the existing ChatEvent schema. LastSeq here is **session-local**, distinct from Annex's global WS seq. Returned history is a bounded tail; pending interactions are included separately even when their events predate the tail. GET `/api/v1/mobile/agents/:agentId/chat/sessions` returns `{version,epoch,agentId,sessions:ChatSessionSummary[]}`. The chat snapshot accepts `sessionId` (optional), `beforeSeq` (exclusive, positive integer) and `limit` (1–2000, default 2000). It also returns `currentSessionId`, `readOnly`, and `nextBeforeSeq` (null when no older page). `lastSeq` always describes the full session, not the current page. Never send actions for a readOnly historical session. Pending interactions are independent of the requested page.

### Agent state

Capabilities advertise `agentState:{version:1,path:"/api/v1/mobile/agents/state"}`. Authenticated `GET /api/v1/mobile/agents/state` returns every agent's live state in one read: `{version:1,epoch,agents:[{agentId,projectId,kind,status,sessionId,sessionState,hasSession,detailedStatus,pendingPermission,pendingQuestion,lastActivityAt}]}`. `status` is `running` or `sleeping` for a durable agent and the run status for a tracked quick agent. `sessionId` and `sessionState` (a `ChatSessionState`) are null without a live chat session. It reads runtime state and agent configs only, never transcripts, so a phone can call it after every reconnect: events it missed while away (a sleep, a turn's end, a resolved request) never reach it, and replay starts from the reconnect snapshot. Treat it as newer than any status cached from chat events; reload history only for conversations on screen.

When a durable agent's process exits (stopped, idle-slept, crashed; terminal or chat), the desktop broadcasts `pty:exit` and then `{type:"agent:status",payload:{id,agentId,kind:"durable",status:"sleeping",detailedStatus:null,lastActivityAt},seq}`. Exiting drops the agent's earlier events from replay, so this frame is what a replaying phone sees.

## Live events and replay

### Order on connect

A socket's first frame is always its `snapshot`, or `{type:"error",payload:{message:"snapshot_failed"}}` if one can't be built. Nothing comes before it, not even a reply to something you've already sent. Everything from the build follows, in order, then live frames.

After `snapshot_failed` the socket stays open, and replies to what you send still arrive. Events don't: without a snapshot you have nothing to read them against. They're held on the desktop, up to 10,000 frames or 32 MiB. Past that, what's held is dropped but `lastSeq` stays where it was, so you'll see a jump in seq after the snapshot: replay as for any gap. A successful try sends the snapshot and then what's held. Reconnect whenever your own grace period ends.

- If building failed, the desktop tries again after 2, 8 and 30 seconds and then every minute.
- A snapshot too large to send (over 16 MiB) is never sent. For the next 5 minutes, across every socket, a connecting phone gets `snapshot_failed` without a new attempt. A change to what a snapshot shows brings a recheck, at most every 30 seconds. So does the end of the 5 minutes, once however many are waiting. When one fits, every waiting socket gets it. A connected phone keeps what it has until then.
- For 5 seconds after a failed build, a new socket gets `snapshot_failed` without a new attempt, so reconnecting doesn't mean rebuilding.

The desktop never closes a socket for any of this. A phone can't rely on a close code: on iOS, `URLSession` reports 1013 as 1005.

- The first snapshot's `lastSeq` is the seq when the socket connected. Events during the build follow it with no gap. The snapshot's state may already include some of them, so applying one must be safe.
- A later `snapshot`'s `lastSeq` says what its state includes. If what it shows changed while it was being built, it's the seq from before that, so a phone that has seen the change drops it as a duplicate, and a fresh `snapshot` follows within a moment. `pty:data` and `chat:event` don't count, because they don't change a snapshot's fields. While a socket waits for its first snapshot, only the newest refresh is kept.

### Authoritative local queue

Chat snapshots add `queuedMessageIds: string[]`, `queueStateSeq: number`, and `queueRemovalSupported: boolean`. The IDs are the last published state of the runtime-owned queue, independent of history pagination. `queueStateSeq` is the session-local sequence of that state (zero before the first queue event), not the global Annex replay cursor. Native provider queues and historical sessions return `[]`, `0`, and `false`; do not offer local removal for provider-managed submissions.

Capabilities advertise `events.queueState: "queue_state"`. The additive rich event is `{type:"queue_state",data:{queuedMessageIds:["id"],transition:{messageIds:["id"],status:"queued"|"dispatching"|"delivered"|"failed"|"removed"}}` inside the normal ChatEvent envelope. The full ID list is authoritative for local cancellation. `dispatching` removes the item before sending; `delivered` means the driver send resolved, not that its turn completed. `failed` does not guarantee no provider effect, so do not automatically retry. Existing `user_message` and `queue_removed` events are unchanged. Merged MCP submissions share their original queue item ID via queuedWith.

`user_message` also carries an optional, additive `routed: [{sender?: {agentId?, name}, fromClubhouse?, text}]` on messages from other agents and Clubhouse. Each part is one message, with its sender and without routing text such as `[FROM:...]`; a burst of updates has several. `content` still holds exactly what the agent received. A client that wants to show the sender should prefer `routed`, and can ignore it to keep showing `content` as today. Older transcripts don't have it. A part's text can still start with the reply marker `TASK_RESULT:<id>:` or `TASK_ACK:<id>:`; don't show it. See [Who sent a message](#who-sent-a-message).

For each session, apply a queue snapshot or event only if its queueStateSeq/event.seq is at least as new as the queue state already applied. Snapshot queue state can be newer than the returned transcript page, so track this watermark separately from chat history and Annex replay cursors. Don't infer that a runtime-owned queue item was consumed from turn_started; [Queued messages](#queued-messages) has the one exception. Session termination makes remaining IDs non-cancellable and [settles them as not delivered](#queued-messages); a new session resets the queue watermark.

Existing WebSocket `{type:"chat:event",payload:{agentId,event:ChatEvent},seq}` stays unchanged. Deduplicate rich events by `(agentId,sessionId,event.seq)`. Annex `seq` is the transport cursor.

Send `{type:"mobile:replay",epoch:"capabilities epoch",since:123}`. Replies use existing top-level `replay:start`, original event frames with `replayed:true`, and `replay:end`; each replay control frame includes `epoch`. Invalid/stale epoch, cursor beyond lastSeq, or missing retained events produces top-level `{type:"replay:gap",epoch,oldestAvailable,lastSeq}`. Resnapshot chat and project state on gap. Buffer live events while applying a snapshot/replay and deduplicate; do not advance the cursor to a snapshot's lastSeq before its data has been applied.

Chat event definitions: src/shared/chat/events.ts. Driver capabilities: src/shared/chat/capabilities.ts. Existing snapshots/projects/agents: src/main/services/annex-server.ts. Read runtime state/driver capabilities before presenting steer/approval actions. Errors, cancellation, waiting_input, waiting_permission, turn_ended and session_ended remain normal rich events.

## Who sent a message

How a phone shows `user_message`, so it matches the desktop's chat (`messageDisplay` and `findSenderAgent` in `src/shared/chat/message-routing.ts`, `agentAvatarSpec` in `src/shared/agent-avatar.ts`). `sender-identity.json` has a case for each row here, with what the desktop's code draws for it.

### Reading a message

Decide who it is from in this order. The first match wins.

| Message | Reads as |
|---|---|
| `source` is `user` or `annex` | You. The text is never parsed, whatever it looks like. |
| `routed` has parts | One entry per part, in order. |
| `source` is `system` | Clubhouse. |
| `source` is `group_project` | "Group project", no avatar. |
| `source` is `shoulder_tap` | Parse `content` (below): the sender `user` means you. |
| Anything else | Parse `content`. A `mission` with no tag is you. |

**Parsing** is only for older transcripts and deliveries with no `routed`; new messages from agents and Clubhouse carry it. Each line is a prefix on `content` text. The sender has a name, and an id only where the tag has one. `sender-identity.json` has an example of each, except the bursts.

- `[Clubhouse] text`: Clubhouse.
- `[FROM HELPER:name (id)] text`: the helper, with its id.
- `[TASK:id] [FROM:name@project] text`, with or without the task: `name`, with no id. Drop the reply instructions after a `\n\n---\n`.
- `Group Project notification — shoulder tap from "name@project" in "group"\ntext\n\n---\nRESPONSE INSTRUCTIONS:...`: `name`, with no id.
- `N updates, oldest first:\n\n--- 1 of N ---\n...`: one part per section.

If you don't parse, show the part with no sender as "Another agent".

Strip a leading `TASK_RESULT:<id>:` or `TASK_ACK:<id>:` from a part's text in every case.

### Finding the sender's agent

Build one list from the latest snapshot: every row of `agents[*]` in every project, every row of `quickAgents[*]`, and `dispatcher.agent` when it isn't null. A snapshot holds all registered projects, so a sender in another project is there too. `GET /api/v1/projects/:id/agents` is one project and isn't enough.

1. With `sender.agentId`: the row with that id, or nothing. Never fall back to the name, even if another agent has it. `agentId` is the id in the catalog, so a miss means that agent is gone or isn't available. Examples: a deleted agent, a disposed helper, a quick agent that finished, the Dispatcher while it is off.
2. With only `sender.name`: the row with that name if exactly one row has it, otherwise nothing.

Look the sender up again on each snapshot, so a rename or new look shows on messages already on screen.

### Drawing a sender

| Part | Name | Avatar |
|---|---|---|
| Sender found | The row's current `name` | From the row, below |
| Sender not found | `sender.name` | Initials of `sender.name` on indigo |
| `fromClubhouse` | "Clubhouse" | None |
| No sender | "Another agent", or "Group project" for that `source` | None |

`sender.name` is the sender's name when the message was sent. When a wire had no name recorded it can be the agent's id.

An avatar is always a circle, with images clipped to it and filling it. Use the first that applies:

1. **Quick agent** (`kind` isn't `durable`): a lightning bolt on a neutral surface. Ignore `color`, `emoji` and the name.
2. **Emoji** (`emoji` set): the emoji on the agent's color at alpha `0x20`, about 12.5%. This comes before an image.
3. **Image** (`icon` set and `agentIcons[id]` present): `agentIcons[id]`, a data URL.
4. **Initials**: bold on the agent's solid color.

**Initials:** split the name on `-`, take the first character of each piece, skip empty pieces, uppercase, keep the first two. `-` is the only separator. So `Dispatcher` is `D`, not `DI`; `clever-fox` is `CF`; `one-two-three` is `OT`; `my_agent` and `Two Words` are `M` and `T`. The `initials` list in `sender-identity.json` has more.

**Colors:** `color` is an id. An unknown or missing one is indigo.

| id | hex | id | hex |
|---|---|---|---|
| `indigo` | `#6366f1` | `violet` | `#8b5cf6` |
| `emerald` | `#10b981` | `orange` | `#f97316` |
| `amber` | `#f59e0b` | `teal` | `#14b8a6` |
| `rose` | `#f43f5e` | `cyan` | `#06b6d4` |

The desktop draws initials in white. Clubhouse Go draws them in whichever of dark or light contrasts more; that difference is known and open.

### Laying out a message

- **You:** on the right, in a bubble, labelled "You".
- **Others:** on the left, one entry per part: the avatar, then the name above a bubble. Parts of one message stay together, even with different senders. The active agent's replies aren't in this layout.
- **Color:** agent color appears only in the avatar. Don't tint bubbles, names or message backgrounds with it. The desktop draws both bubbles on the same neutral surface.
- **Long messages:** a part over 800 characters or 14 lines starts collapsed, as "`name` sent a long message".
- **Text:** a part with a `sender` is Markdown. A Clubhouse notice or a part with no sender is plain text.

### Queued messages

There is **no `user_message` when a queued message is delivered**. Delivery is only `queue_state`, so a burst's combined parts exist only if you build them from the queued events. `queued-bursts.json` has each case below as the real runtime emits it.

**Building the row.** On `user_message` with `delivery: "queued"`, the row's id is `queuedWith`, or `messageId` when there is none.

- **Joining:** if that row exists, append this event's `routed` parts and content to it. A join has its own `messageId` and no `queue_state` of its own, and only the row's id appears in `queuedMessageIds`.
- **Missing target:** if the row doesn't exist, as when a page starts mid-burst, create it under the `queuedWith` id. Later joins and its `queue_state` then find it.
- **No `routed`:** an event without it is parsed, so the parts stay in step with the content.

Only MCP messages join, and only an MCP row at the end of the queue. `queuedWith` means nothing on any other `delivery`: treat that event as a normal message. `user_message` in `chat-events.json` has `queuedWith` with `delivery: "steer"` so that a decoder sees every optional field. The runtime never sends that combination.

**Delivery of a runtime-owned queue** follows `queue_state`:

| `transition.status` | What to do |
|---|---|
| `queued` | The row waits. |
| `dispatching` | Move it into the timeline, so it comes before that turn's output. |
| `delivered` | The send resolved. Don't assume this comes before `turn_started`. |
| `failed` | Mark it not delivered, and don't retry: the provider may still have acted on it. |
| `removed` | Drop it (with `queue_removed`). |

`delivered` and `failed` also move a row still in the queue, for when its `dispatching` was cut off. For a row already in the timeline they only update its state. A `queue_state` naming a row you don't have changes nothing.

`queuedMessageIds` is the whole queue on every event. A row a newer list has dropped is no longer queued, even if you missed why, so a missed event is not a reason to use `turn_started`. After a `replay:gap`, reload the chat and apply its `queuedMessageIds`.

**The `turn_started` exception.** Some rows have no `queue_state` at all: a provider-held queue (capability `queue: "native"`, where `delivery: "queued"` comes with no queue events), and older desktops or transcripts (no `events.queueState` in capabilities). On `turn_started`, consume the oldest row that no `queue_state` has named, in `transition.messageIds` or `queuedMessageIds`. A runtime-owned row is always named before its turn starts, so this never takes one. Don't require `trigger: "queued"`: older transcripts drained their queue with `prompt`.

**System turns.** A `turn_started` with `trigger: "system"` consumes no row, including under the exception above. It is the agent's own work (`/compact`, a permission or question with no turn open, an agent starting on its own), so the row stays for the next turn that isn't `system`.

**Settling.** When the run that held a row is over, the row becomes not delivered. This covers rows still queued, named or not, and rows at `dispatching` with no `delivered` or `failed` yet. They go at the end of the timeline. It happens on:

- **`session_ended`.**
- **A new run in the same session:** a `session_started` whose `sessionId` is the one already on screen. That is normally `resumed: true`, but the desktop doesn't check the flag. After a crash no `session_ended` comes first, so this is the only event that settles the row.
- **History of a dead session:** after building the view from a transcript that nothing runs now, which may stop without a `session_ended`. The desktop does this in `settleDeadSession`. On a phone, the signal is `readOnly: true` on the chat snapshot.

A `session_started` with a different `sessionId` is a new conversation: start from an empty view, with no rows carried over. If `delivered` arrives for a row after it settled, the send did resolve, so clear the mark.

For a native queue this is best evidence, not proof. The CLI's queue dies with its process and no turn opened for the row, but a CLI that folded the message into a running turn without opening a new one would make the label wrong. A row at `dispatching` is similar: its send never reported back, so the provider may have received it. Don't retry either one. The desktop adds `Not delivered` to the message's label line (`You · Not delivered`), with no other styling.

**Matching is by id only, never by text.** Two sends with the same words are two messages, so a `user_message` with the same text as a row leaves the row alone. If a `user_message` with another `delivery` arrives with the same `messageId` as a row, it replaces the row. The runtime doesn't send one today.

The desktop's chat follows this section too (`foldChatEvents` in `src/renderer/stores/chatStore.ts`). It acts on `transition` alone and doesn't compare `queuedMessageIds`, because it reads every event in order and has no replay gap to recover from.

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

## Slash commands

Desktops that support them advertise `slashCommands: {version:1, snapshotField:"slashCommands", event:"commands_available", maxCommands:200}` in capabilities. They are the desktop composer's `/` menu: the CLI's own commands, project and user skills, custom commands and MCP prompts, as the session reports them.

**Read.** A live chat snapshot carries `slashCommands`, the session's latest list (even when the page of `events` doesn't reach back to it); it is `null` for a sleeping agent or a readOnly historical session:

```json
"slashCommands":[{"name":"compact","description":"Clear conversation history but keep a summary in context","inputHint":"<optional custom summarization instructions>","startOnly":true},
 {"name":"review","description":"Review a pull request","inputHint":"<pr>"}]
```

- `name` is typed after the `/`, without it. `description` (≤160 characters, whitespace collapsed, cut with `…`) and `inputHint` (≤64) are optional.
- `startOnly: true` runs only at the start of a message (the CLI's own commands, #2135); mid-message the text goes to the model as is, so don't offer these there. Absent: it works anywhere.
- At most `maxCommands`, in the session's order. A name longer than 64 characters or containing whitespace is left out.

**Live updates.** A `commands_available` chat event (`{commands:[…]}`, bounded the same way) replaces the whole list. It arrives when a session starts and when its commands change.

**Composer.** Show the menu only when the session's `capabilities.slashCommands` is true. While the caret ends a `/word` that starts the message or follows whitespace, offer up to 8 commands whose name starts with `word` (case-insensitive), skipping `startOnly` ones unless only whitespace comes before the `/`. Picking one replaces the word with `/name ` and leaves the caret after the space. The placeholder reads "Message {name}… / for commands". Without the capability, `/` is plain text.

## Permissions from a phone

A paired phone has full control of the desktop's permission settings, the same as the desktop's own controls. A paired phone can already approve every request one by one, so these controls don't widen what it can do; they save it the taps. Pinned mTLS, idempotency and capability gating are unchanged.

Capabilities advertise what the desktop accepts: `permissions: {version:1, persistentApprovals, freeAgentMode}`. Older desktops have no `permissions`: they refuse persistent options (403 `persistent_approval_not_supported`) and `freeAgentMode` (403 `free_agent_mode_not_allowed`), and have no `chat.setLevel`.

- `persistentApprovals`: `chat.permission` answers persistent options (allow for the session, always allow, always reject).
- `chat.setLevel` accepts any live level, raising included (`chatControls.version >= 1`).
- `freeAgentMode`: `agent.create` and `agent.update` accept `freeAgentMode` (boolean), with the desktop's rules: see [Durable agents](#durable-agents).

## Durable agents

Create (#2451) and settings (#2452) follow the desktop New agent page and the Details → Settings card. Both reads need an authenticated client; the commands need the pinned client certificate like every mobile command.

**Helpers** are durable agents another agent started. They carry `parentAgentId`, the id of that agent, in the snapshot's `agents[projectId][]`, `GET /api/v1/projects/:id/agents` and the [settings route](#settings). Top-level agents leave it out, so its presence is what marks a helper. The parent can be in another project (#2511), so it may not be in the same `agents[projectId]` list. A helper handed off as a normal agent loses the field. Additive: older desktops never send it, and older phones ignore it.

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
- **orchestration**: the policy fields to set, without nulls ([Orchestration](#orchestration)); 400 `invalid_orchestration` before anything is created.

A conflict found at creation, such as a folder or branch already in use or a missing base branch, is 409 `create_refused` with the reason in `message`.

The receipt returns as soon as the agent's record exists. Its worktree is made in the background, as on the desktop:

`result: {agentId, projectId, name, branch, worktreePath, state:"creating"|"sleeping"}`

The snapshot (via `snapshot:refresh`) shows the agent, then its creation ending as ready (sleeping) or failed. To give it a first prompt, wait for it to leave `creating`, then send `agent.start {agentId, message}`.

### Settings

We chose a route rather than snapshot fields. The settings need disk and CLI reads: personas, model lists, CLI availability, the Clubhouse mode state. The snapshot is rebuilt on every refresh for every client, and an agent's settings change rarely.

`GET /api/v1/mobile/agents/:agentId/settings` (404 `agent_not_found`; durable agents only):

```json
{"version":1,"epoch":"uuid","agentId":"durable_1","projectId":"p1","parentAgentId":"durable_0",
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
 "orchestration":{…},
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

- **orchestrator**: `value` null means the project default. `resolved` is what it runs on. `changeStartsNewSession` is true when the agent has a saved session that a new CLI can't resume. Warn before sending the change, as the desktop does: "<Agent> starts a new session on <CLI> the next time it wakes. Its current conversation can't move to another CLI." Older desktops omit the field.
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
- **orchestrator**: one of `orchestrators` (409 `orchestrator_unavailable`). A different CLI resets the model to default unless `model` is in the same command, and starts a new session on the next wake. No conversation or context moves over, and the agent's `hasSession` becomes false. When that drops a saved session, the result has `sessionReset:true`; otherwise the field is absent.
- **model**: `"default"` clears it.
- **runtime**: `default`, `chat` or `terminal`. `chat` and `terminal` need chat to be available (409 `runtime_unavailable`).
- **persona**: one of `personas`, or `null` for the project default.
- **clubhouseMode**: boolean. Needs a Clubhouse mode project (409 `clubhouse_mode_unavailable`).
- **freeAgentMode**: boolean. `true` needs an orchestrator with permission support (409 `free_agent_mode_unavailable`).
- **idleSleep**: `"inherit"`, `"never"`, or one of `options.idleSleep.minutes`.
- **orchestration**: a partial policy, or `null` to clear every override ([Orchestration](#orchestration)). It changes at any time, also while the agent runs, and is written first: a refused policy change saves nothing else.

Rejections:

- A `sleeping` setting on an awake or starting agent is 409 `agent_running`, and nothing is saved.
- An agent still being created is 409 `agent_creating`.
- Instructions, skills, agent definitions, MCP JSON, permission rules, the launch wrapper and helpers are not accepted. Any unknown field is 400 `invalid_command`.

The receipt `result` is the settings payload above, without `version`, `epoch` and `options`. The desktop windows and other clients are told about the change through `snapshot:refresh`.

## Orchestration

An agent's orchestration policy (#2228), as the desktop's Orchestration card and the agent's Helpers settings edit it. Gated on `orchestration: {version: 1}` in capabilities.

Every durable agent in the snapshot (`agents[projectId][]`), `GET /api/v1/projects/:id/agents` and the [Settings](#settings) payload (so the `agent.update` result) has:

```json
"orchestration":{"orchestrate":false,"access":"same","control":"hands-off","maxHelpers":5,
 "crossProjectHelpers":false,"connectToDispatcher":false,"mcpEnabled":true,
 "sources":{"orchestrate":"default","access":"default","control":"persona","maxHelpers":"agent","crossProjectHelpers":"default","connectToDispatcher":"default"},
 "maxHelpersCap":20,"controls":["hands-off","ask-before-start","ask-everything"],"accessLevels":["same","standard","auto","bypass"]}
```

- **orchestrate**: "Let this agent orchestrate".
- **access**: "Helpers get": one of `accessLevels`. `same` follows the orchestrator; a fixed level is a ceiling request, and a helper never gets more than its orchestrator runs with.
- **control**: one of `controls` (hands-off, ask before starting helpers, ask about everything).
- **maxHelpers**: "Helpers at once", a whole number from 1 to `maxHelpersCap` (the app-wide helper cap, at most 100).
- **crossProjectHelpers**: "Cross-project helpers" (#2512): the agent may start helpers in other registered projects. The desktop shows it while `orchestrate` is on; turning it off leaves helpers already running elsewhere alone.
- **connectToDispatcher**: "Connect to Dispatcher" (#2534): the Dispatcher may message this agent and get its reports. The desktop shows it while the [Dispatcher](#dispatcher) is on, with `orchestrate` on or off; turning it on while the Dispatcher is off is 409 `dispatcher_off`. Unset (source `default`), it follows `orchestrate` (#2578). A helper (an agent with `parentAgentId`) talks only to its parent, so on a helper it is always `false` with source `default`, and a value sent for one has no effect while it is a helper. Don't offer the switch on a helper. So an agent can report `true` with the Dispatcher off: send this field only when the user changes it.
- **mcpEnabled**: whether Clubhouse MCP is on for this agent (#2589), following its own setting, then its project's, then the app's. A helper always has it (#2610). No Clubhouse MCP means no orchestration: while it is `false`, `orchestrate`, `crossProjectHelpers` and `connectToDispatcher` read `false`, the agent gets no Dispatcher wire and isn't in the Dispatcher's `list_agents`. Their `sources` still describe the saved settings, which are kept and come back when MCP does. Disable those switches and say they need Clubhouse MCP. Helpers already running keep running. The snapshot refreshes when an MCP setting changes.
- **sources**: where each field comes from. `agent` is an override on the agent, which `null` clears; `persona` is the persona's front-matter; `default` is the built-in default.

`agent.update` takes `orchestration` as a partial object: `{"orchestrate"?: bool|null, "access"?: string|null, "control"?: string|null, "maxHelpers"?: int|null, "crossProjectHelpers"?: bool|null, "connectToDispatcher"?: bool|null}`. Each key sets that field; `null` clears it back to the persona or default. `"orchestration": null` clears all six. Phones gate `crossProjectHelpers` and `connectToDispatcher` on the payload having them (and Connect to Dispatcher on `dispatcher.enabled`); a phone that doesn't know them ignores them. `agent.create` takes the same object without nulls. Writes go through the desktop's own policy service, so the desktop UI updates live.

Rejections:

- 400 `invalid_orchestration`, with the reason in `message`: an unknown field, a bad `access` or `control`, `maxHelpers` outside 1 to `maxHelpersCap`, an empty object, or a null on create.
- 409 `orchestration_has_helpers`: turning `orchestrate` off while the agent has live helpers. Nothing changes; the desktop asks whether to keep or dispose them.
- 409 `dispatcher_off`: `connectToDispatcher: true` while the Dispatcher is off.
- 409 `mcp_off`: `orchestrate`, `crossProjectHelpers` or `connectToDispatcher` set to `true` while `mcpEnabled` is `false` (on `agent.create`, while Clubhouse MCP is off for the project), with the reason in `message`. Nothing is created or changed. Setting them to `false`, clearing them with `null`, and the other fields are still accepted.
- A non-object `orchestration` (or `null` on create) is 400 `invalid_command`.

## Dispatcher

The app-wide Dispatcher (#2533): one durable agent that coordinates the orchestrators in every project. It lives in its own folder under the Clubhouse base dir, which is no git repo, and is in no project, so it never appears in `projects`, `agents{}`, `GET /api/v1/projects` or `GET /api/v1/projects/:id/agents`. It is on only when the desktop's experimental flag (`flagOn`) and the switch in Settings > Dispatcher are both on. Gated on `dispatcher.version >= 1` in capabilities:

```json
"dispatcher":{"version":1,"enabled":false,"flagOn":true,"newLayout":true,"projectId":"__dispatcher__",
 "snapshotField":"dispatcher","event":"dispatcher:changed","commands":["dispatcher.setEnabled"]}
```

- **enabled**: the flag and the switch are both on.
- **flagOn**: the experimental flag. A phone never changes it; without it, the switch says "Turn on Dispatcher in Settings > Experimental on the desktop".
- **newLayout**: the desktop runs the New layout this session. The Dispatcher's view is in the new layout only, so turning it on needs it; one that is still on can always be turned off.

### Snapshot

The snapshot's `dispatcher` is `null` while the Dispatcher is off (or was never created). While it is on:

```json
"dispatcher":{"enabled":true,"flagOn":true,"projectId":"__dispatcher__",
 "agent":{"id":"durable_dispatcher","projectId":"__dispatcher__","name":"Dispatcher","kind":"durable","isDispatcher":true,"color":"indigo",
  "emoji":null,"branch":null,"model":null,"orchestrator":"claude-code","freeAgentMode":true,"icon":null,"status":"sleeping",
  "detailedStatus":null,"executionMode":null,"hasSession":true,"lastActivityAt":1800000000000}}
```

`agent` is the `agents[projectId][]` shape with `projectId: "__dispatcher__"` and `isDispatcher: true`, and no `orchestration` (its orchestration settings are locked). It is in `agentIcons` when it has an image icon and in `agentsMeta` while it runs. `GET /api/v1/mobile/agents/state` has a row for it (`projectId: "__dispatcher__"`, `isDispatcher: true`) while it is on.

### Live changes

`dispatcher:changed` is broadcast and buffered for `mobile:replay` whenever `enabled`, `flagOn` or the agent id change, from the desktop or a phone: `{"enabled":bool,"flagOn":bool,"agentId":"id"|null}` (`agentId` is null while it is off). A fresh `snapshot` follows it, and also follows any change to its config (its CLI or model changed on the desktop). Add or drop the Dispatcher from that snapshot.

### dispatcher.setEnabled

`{type:"dispatcher.setEnabled", enabled:bool}` is Settings > Dispatcher's switch. Result `{enabled, flagOn, agentId}`, as `dispatcher:changed`. Turning it off stops the agent and keeps its folder, notes and config, so turning it on again carries on. Refusals (409): `dispatcher_flag_off` (turning it on with the flag off) and `dispatcher_layout_off` (turning it on while the desktop runs the classic layout). Turning on one that is on, or off one that is off, succeeds with the current state.

### Its agent

While it is on, its id works wherever an agent id does: the chat snapshot, chat history pages, `/chat/sessions`, `/content`, attachments, `/settings`, every `chat.*` command, `agent.start`, `agent.stop`, `agent.update`, `pty:attach`, and `GET /api/v1/agents/:id/sessions…` with `projectId=__dispatcher__`. While it is off, GET routes answer 404 `agent_not_found` and commands 409 `dispatcher_off`.

- **Shells.** `pty:spawn-shell` with `projectId: "__dispatcher__"` (with or without its `agentId`) opens a shell in its folder while it is on; otherwise `project_not_found`.
- **No git.** Git routes for `__dispatcher__` answer 409 `{"error":"not_git_repo"}`. Its settings' `details.changes`, `branch` and `worktree` are null.
- **No project.** `agent.create`, `agent.spawn`, `project.*` and `quick.*` with `projectId: "__dispatcher__"` are 409 `dispatcher_locked`.
- **Settings.** `GET /mobile/agents/:id/settings` has `isDispatcher: true` and `orchestration: null`. `orchestrator`, `model`, `runtime` and `freeAgentMode` are `editable: "always"` (as on Settings > Dispatcher they apply the next time it starts), `idleSleep` `"always"`, and `name`, `color`, `emoji`, `persona` and `clubhouseMode` `"never"`.
- **agent.update.** Only `orchestrator`, `model`, `runtime`, `freeAgentMode` and `idleSleep`, at any time. A new `orchestrator` resets `model` to `default` unless the command sets one; `model` must be `default` or one the CLI lists (400 `invalid_model`). `name`, `color`, `emoji`, `persona`, `clubhouseMode` or `orchestration` are 409 `dispatcher_locked`, the desktop's own rules.

The Dispatcher can change its own color, emoji and image through the `update_agent` MCP tool, and the `clubhouse` CLI can change them too (#2645). A phone can't: `agent.update` stays `dispatcher_locked` for them. A fresh `snapshot` carries the new look. Its name stays "Dispatcher", whichever look it has. Messages it sends name it as the sender like any agent; find it in `dispatcher.agent`, not `agents`.

Messages other agents send the Dispatcher arrive as `user_message` with `source: "mcp"` and [`routed`](#live-events-and-replay) naming the sender, as for any agent. `content` is what the Dispatcher received, with a `[FROM:<name>@<project>]` tag in the text, and that tag is all older transcripts have.

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

## Contract fixtures

`test/fixtures/annex-mobile/` holds a canonical example of every message in this document: capabilities, the WebSocket snapshot (agents, quick agents, `projectState`, `finishedQuickAgents`, `helperRequests`, theme), the chat snapshot with `chatControls`, `slashCommands` and `contentRoots`, create options and agent settings, a request and receipt for every `MOBILE_COMMAND_TYPES` command with each refusal its code path can reach, one `chat:event` of every chat event type followed by `user_message` with each form of `routed` (one sender, a burst, `fromClubhouse`, no `sender`), every kind of sender and how to draw it, queued bursts, every `pty:*` message and error, `mobile:replay`, and the attachment upload's answers. The phone (Clubhouse Go) vendors these files and decodes each one in its contract tests, and checks that the commands it builds match the requests here. Neither side tests only against its own fakes.

`src/main/services/annex-mobile-contract.test.ts` writes them. It runs the real annex-server, mobile-control, mobile-agents, mobile-helper-requests, mobile-attachments and chat echo code over pinned mTLS and the WebSocket handler. Only the leaves are faked (disk, git, CLIs, PTYs, the orchestrator side of helper requests). The output is deterministic: fixed ids and clock, sorted keys, and random UUIDs (epochs, tokens, attachment and helper request ids) renumbered `00000000-0000-4000-8000-<n>` in order of first appearance.

- `npm run fixtures:annex-mobile` rewrites the files. Commit them with the change that caused them.
- `npm run fixtures:annex-mobile -- --check` (and the suite itself, in `npm test`) fails when a file is stale or extra.
- A changed fixture is a protocol change: keep it additive, update this document, and tell the phone side.
- A new command type or chat event type fails the suite until it has an example.

A helper is `durable_docs` in `snapshot.json` and `agent-settings-helper.json`; the other agents there are top-level.

`sender-identity.json` is for [Who sent a message](#who-sent-a-message). `catalog` is the snapshot's agent rows and `agentIcons`, `frames` are the live `chat:event`s, and `expected` is, for each event, what the desktop's code draws given only `catalog` and that event: `{from:"you", text}` or `{from:"others", parts:[{name, agentId, text, avatar}]}`, where `agentId` is the row it found or null. `avatar` is null, `{type:"quick"}`, `{type:"emoji", emoji, background}`, `{type:"image", image}` or `{type:"initials", initials, background}`, with `background` a CSS hex color. `history` and `replay` carry the same messages through the chat route and `mobile:replay`. `colors` and `initials` are the tables to check against. `queued-bursts.json` is for [Queued messages](#queued-messages): events from the real chat runtime for a burst, the same burst missing its first event, a failed send and a provider-held queue, with `rowId` and the combined `routed` to expect.

The Dispatcher has its own files: `snapshot-dispatcher.json` (the snapshot's `dispatcher` and its `agent-state` row while it is on), `dispatcher-changed.json` (the event), `agent-settings-dispatcher.json` and `dispatcher-routes.json` (its chat and sessions while on, its GET routes while off, git, and a shell in its folder).

`commands/<type>.json` lists `cases` of `{name, request, response:{status, body}}`; `name` is `accepted…` or the error code. `commands/_common.json` has the refusals any command can get (`invalid_command`, `unsupported_version`, `epoch_mismatch`, `command_conflict`, `client_certificate_required`, `command_capacity`) and an identical retry. Not covered: `authorization_revoked`, `start_cancelled` and the upload `quota_exceeded` / `authorization_revoked`, which need races or a day of uploads; `/content` previews and git routes.
