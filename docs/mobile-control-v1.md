# Mobile control v1 (additive Annex contract)

Implemented on codex/mobile-control-v1, desktop base eecbe20bf.

Existing Annex protocolVersion stays 2. Existing routes and WebSocket frames stay unchanged.
Discovery remains `_clubhouse-annex._tcp` with main TLS port and pairingPort TXT. Manual LAN / Tailscale host entry uses the same HTTPS/WSS protocol. No gateway is deployed.

## Trust and pairing

Mobile MUST pin SHA-256 of the server leaf certificate DER (uppercase colon-separated hex) after the user compares it with desktop Settings > Annex > TLS certificate fingerprint. Discovery and unauthenticated identity responses are hints, never trust roots. Never accept arbitrary TLS certificates or send a PIN over HTTP.

Pairing is only `POST https://host:mainPort/pair` with `{pin, publicKey, alias, icon, color}`. `publicKey` is base64 Ed25519 SPKI DER. Optional `pairingMode:"session"` stores peer trust only in memory until server stop/disconnect; no peer record is persisted. `pairingMode:"persistent"` (default) uses the existing peer store. The response echoes pairingMode. Integration must explicitly use session mode; a product UI must label it accurately and obtain user consent before persistent enrollment. Present a self-signed RSA client certificate whose CN is the lowercase colon-separated **first 16 bytes of SHA-256** of that publicKey (existing desktop identity format; 32 hex characters, not the full TLS pin); without one that matches, pairing is 400 `client_certificate_required`. Desktop pins the *actual presented certificate* (its SHA-256) to this peer. Response fields: `token, tlsCertificateFingerprint, mobileProtocolVersion:1, pairingMode, publicKey, alias, icon, color, fingerprint`; `token` is kept for older clients and authenticates nothing. No live pairing is performed as part of code implementation.

The PIN pairs one identity, then desktop replaces it; it also expires after 10 minutes. Refusals carry `{error, message}`, and `message` is a sentence to show: 409 `invalid_pin` (wrong PIN), 410 `pin_expired` (expired or replaced), 410 `pin_used` (already used by another identity). The same identity and certificate retrying a used PIN while it would still have been live gets 200 with the same response, so a lost reply can be retried. 429 `rate_limited`/`pairing_locked` are unchanged per address. Each attempt counts as it starts. After 10 wrong PINs in all, from any address, pairing is paused for every device: 429 `pairing_locked` with a `message`, until someone allows pairing again in desktop Settings (or turns Annex off and on). Pairing an identity that already has a pinned certificate with a different certificate is 409 `peer_already_paired`, unless the body has `certBinding`: base64 of the identity key's Ed25519 signature over `"annex-cert-binding/v1" || SHA-256(certificate DER)`. On the plain HTTP pairing port, `POST /pair` is 410 `update_required` and pairs nothing; if it carried the current PIN, that PIN is replaced. That port only answers `GET /api/v1/identity`, a discovery hint.

Every REST route and the `/ws` upgrade on the main port require a paired controller's pinned client certificate, and nothing else authenticates (an `Authorization` header or `?token=` is ignored). Refusals are JSON `{error, message}`, with the same status and body on a WebSocket upgrade: 401 `unauthorized` (no client certificate; `/api/v1/mobile/*` routes keep their 403 `client_certificate_required` for that case), 401 `peer_not_paired` (not paired, removed, or a certificate other than the pinned one), 401 `needs_pairing` (an older pairing with no pinned certificate: pair again), 403 `peer_role_not_allowed`. When a pairing is removed, its open WebSockets close with code 4401, reason `peer_not_paired`, and are cut shortly after; nothing more sent on them is acted on; treat both 401s as "pair again", not as a reason to retry. If desktop can't start TLS, the main port answers 503 `tls_unavailable` to everything and serves nothing over plain HTTP.

## Capability negotiation

Authenticated `GET /api/v1/mobile/capabilities` returns:

```json
{"version":1,"epoch":"uuid","controlAuth":"mtls-pinned-client","controlAvailable":true,"commands":["chat.send","chat.interrupt","chat.permission","chat.question","chat.queue.remove","agent.start","agent.stop","agent.spawn","agent.create","agent.update","project.setPinned","project.setInactive","helper.approve","helper.decline","chat.setModel","chat.setLevel","quick.dismiss","quick.clear","dispatcher.setEnabled","dispatcher.update","dispatcher.setModels","dispatcher.clearChat","dispatcher.forgetEverything"],"pairing":{"sessionRevokePath":"/api/v1/mobile/pairing"},"attachments":{"version":1,"imageTypes":["image/png","image/jpeg","image/gif","image/webp"],"maxImageBytes":3932160,"maxCount":10},"events":{"transport":"annex-websocket","replayRequest":"mobile:replay","queueState":"queue_state"},"createOptions":{"version":1,"path":"/api/v1/mobile/projects/{projectId}/create-options"},"agentSettings":{"version":1,"path":"/api/v1/mobile/agents/{agentId}/settings"},"contextWindow":{"version":1},"helperRequests":{"version":1,"snapshotField":"helperRequests","commands":["helper.approve","helper.decline"]},"chatControls":{"version":1},"slashCommands":{"version":1,"snapshotField":"slashCommands","event":"commands_available","maxCommands":200},"permissions":{"version":1,"persistentApprovals":true,"freeAgentMode":true},"access":{"version":1},"orchestration":{"version":1},"idempotency":{"scope":"peer-and-epoch","maxEntries":2048,"ttlMs":3600000},"projectState":{"version":1},"finishedQuickAgents":{"version":1},"terminal":{"version":1,"projectShell":true,"agentShell":true,"agentAttach":true,"maxShellsPerConnection":8,"maxInputLength":65536},"dispatcher":{"version":1,"enabled":true,"flagOn":true,"newLayout":true,"projectId":"__dispatcher__","snapshotField":"dispatcher","event":"dispatcher:changed","commands":["dispatcher.setEnabled","dispatcher.update","dispatcher.setModels","dispatcher.clearChat","dispatcher.forgetEverything"],"settings":{"version":1,"path":"/api/v1/mobile/dispatcher/settings"}}}
```

A 404 means unsupported: do not send mobile commands. Gate durable-agent creation on `commands` including `agent.create` and `createOptions.version >= 1`, settings on `agent.update` and `agentSettings.version >= 1`, and helper requests on `helperRequests.version >= 1`; older desktops offer quick agents (`agent.spawn`) only. Gate project pins and inactive marks on `projectState.version >= 1` (`projectState:{version:1}`); without it, keep them on the phone. See [Project state](#project-state). Gate the finished quick agents list ("Finished, waiting on you") on `finishedQuickAgents.version >= 1`; without it, keep the phone's own list of quick agents it saw exit. See [Finished quick agents](#finished-quick-agents). Gate the composer's model, effort and level controls on `chat.setModel` / `chat.setLevel` and `chatControls.version >= 1` ([Chat controls](#chat-controls)). Gate terminals on `terminal.version >= 1` ([Terminals](#terminals)). Gate the composer's `/` menu on `slashCommands.version >= 1` ([Slash commands](#slash-commands)). Gate an agent's orchestration policy on `orchestration.version >= 1` ([Orchestration](#orchestration)). Gate saved Access on `access.version >= 1` ([Access](#access)). Gate the Dispatcher on `dispatcher.version >= 1` ([Dispatcher](#dispatcher)). A new epoch invalidates command retries and replay cursors. A paired phone is a full controller, so it may open a shell on the desktop; there are still no arbitrary filesystem paths (a shell's directory comes from a registered project or agent), credentials, or gateway provisioning commands.

## Commands

`POST /api/v1/mobile/commands` JSON base `{version:1, commandId:"UUID-or-other-unique-id", epoch:"capabilities epoch", type:"..."}`. Commands reject unknown fields. Retry identical JSON with the same commandId; never assign a new ID after a lost reply. IDs are scoped to paired client identity and epoch. Reusing an ID for different content returns conflict. Receipts are retained for one hour, bounded at 2048 entries; capacity rejects new commands instead of evicting valid receipts. After expiry or host restart the result can be uncertain: reconcile state, do not blindly retry.

- `chat.send`: `{agentId, sessionId, text, delivery?, attachmentIds?}`; delivery `auto|prompt|steer|queued` (default auto). `attachmentIds` (1–10 distinct ids from the upload route below) sends images; `text` may then be `""` for an image-only message. See [Image attachments](#image-attachments).
- `chat.queue.remove`: `{agentId, sessionId, messageIds:["id"]}`; removes only messages still held in the runtime queue, returns `{removed:["id"]}`. A native-provider queue may return no removed IDs.
- `chat.interrupt`: `{agentId, sessionId}`; cancels the turn and keeps the session.
- `chat.permission`: `{agentId, sessionId, requestId, optionId, reviewedDigest?}`; exact pending option required. `reviewedDigest` approves a request sent only as a preview, after fetching it whole (see "Large permission requests"). Any offered option, persistent ones (`allow_session`, `allow_always`, `reject_always`) included, is answered as the desktop's approval dock answers it, when capabilities have `permissions.persistentApprovals`. Older desktops refuse persistent options with 403 `persistent_approval_not_supported`.
- `chat.question`: `{agentId, sessionId, requestId, answers}`; question-ID to string/string-array map. Send each key exactly as the question's `id`, with no trimming or normalizing: a Claude question's `id` is its full text. Up to 100 keys, each key and answer string 1 to 65536 UTF-16 code units (an emoji is two), and up to 100 strings in an array. Older desktops refuse a key over 256 with 400 `invalid_command`.

  The whole request also has to fit the route's 1 MiB (1048576 bytes) limit, measured as UTF-8 JSON. Over it, the desktop [refuses it with 413 `too_large`](#oversized-commands). One key at the limit always fits, but a request can only hold so many: 15 of ASCII text, 7 of emoji, 5 of three-byte text such as CJK, or 2 when every character is escaped as `\uXXXX`. Answers count toward the same limit.
- `chat.setModel`: `{agentId, sessionId, model, effort?}`; the composer's model and effort pills. See [Chat controls](#chat-controls).
- `chat.setLevel`: `{agentId, sessionId, level}`; the composer's permission level menu. See [Chat controls](#chat-controls).
- `agent.start`: `{agentId, message?, resume?}`; wake durable agent using desktop's configured runtime and permissions.
- `agent.stop`: `{agentId}`; stops agent process, including a start in progress.
- `agent.spawn`: `{projectId, prompt, model?, orchestrator?}`; quick agent under registered project with ask-first permission mode.
- `agent.create`: `{projectId, name, color, orchestrator?, model?, persona? (a value is refused), freeAgentMode?, access?, useWorktree?, mcpIds?, branchName?, branchFrom?, folderName?, orchestration?}`; durable agent, as the desktop New agent page makes one. See [Durable agents](#durable-agents).
- `agent.update`: `{agentId, name?, color?, emoji?, orchestrator?, model?, runtime?, persona? (a value is refused, `null` is a no-op), clubhouseMode? (refused), freeAgentMode?, access?, idleSleep?, contextWindow?, orchestration?}`; at least one setting. See [Durable agents](#durable-agents).
- `project.setPinned`: `{projectId, pinned}`; pin or unpin a project in the desktop sidebar. See [Project state](#project-state).
- `project.setInactive`: `{projectId, inactive}`; mark a project inactive (idle until marked active) or active. See [Project state](#project-state).
- `quick.dismiss`: `{projectId, agentId}`; dismiss one finished quick agent. See [Finished quick agents](#finished-quick-agents).
- `quick.clear`: `{projectId}`; dismiss all of a project's finished quick agents. See [Finished quick agents](#finished-quick-agents).
- `helperRouting.update`: `{revision, scope, cells?, reset?}`; change or reset the app-wide helper presets. See [Helper presets](#helper-presets).
- `dispatcher.setEnabled`: `{enabled}`; turn the app-wide Dispatcher on or off, as Settings > Dispatcher does. See [Dispatcher](#dispatcher).
- `dispatcher.update`: `{behavior?, name?, color?, emoji?, personality?}`; at least one. Settings > Dispatcher's Behavior, name, look and personality. See [Dispatcher settings](#dispatcher-settings).
- `dispatcher.setModels`: `{byHand}` or `{role, provider?, model?, effort?, contextWindow?}`; Choose models yourself. See [Dispatcher settings](#dispatcher-settings).
- `dispatcher.clearChat`: `{expectedState}`; start its conversation over, confirmed. See [Dispatcher settings](#dispatcher-settings).
- `dispatcher.forgetEverything`: `{expectedState}`; clear its memory, confirmed separately. See [Dispatcher settings](#dispatcher-settings).

- `helper.approve`: `{requestId, force?}`; approve a helper start or dispose an orchestrator asked the user to decide. `force:true` is the desktop's "Dispose anyway". See [Helper requests](#helper-requests).
- `helper.decline`: `{requestId}`; decline it. The orchestrator is told, as from the desktop.

For `chat.send`, `result` is `{delivery:"prompt"|"steer"|"queued",messageId:"authoritative runtime ID"}`. The matching `user_message.data` additionally echoes `clientCommandId` equal to the request commandId, including queued/steered sends. The event may arrive before the receipt: reconcile by clientCommandId immediately, then by messageId; never guess by text or timestamps. Local/legacy sends omit the optional field.

Receipt on success: `{version:1,commandId,epoch,status:"completed",result:{...}}`. Completion means command dispatch completed, not agent turn completion. Errors: `{version:1,commandId?,epoch,status:"rejected"|"failed",error:{code,message}}`. `message` is the code, or for some refusals (`invalid_name`, `create_refused`, `agent_running`) a sentence the desktop would show; branch on `code` only. HTTP 400 invalid_command/unsupported_version; 403 client_certificate_required; 404 agent_not_found/project_not_found; 409 epoch_mismatch/command_conflict/session_mismatch/wrong_machine (the agent's address names another machine, which `machine` gives; see `docs/annex-network-phone.md`)/not_chat/pending_request_not_found/images_not_supported/attachment_unavailable, and the [chat controls](#chat-controls) refusals; 413 too_large; 429 command_capacity; 500 command_failed. A failed command can have partial effects; retain its receipt and reconcile.

### Oversized commands

A request body over 1 MiB (1048576 bytes, measured as sent, whether from `Content-Length` or as a chunked body arrives) is refused before it is parsed, after the client certificate check. The command doesn't run, nothing changes, no receipt is kept and no receipt capacity is used.

`HTTP 413`, `Connection: close`, `{version:1,epoch,status:"rejected",error:{code:"too_large",message:"too_large"}}`

The body can't be read, so this answer has no `commandId`, and `epoch` is the desktop's current one rather than an echo of the request's. Branch on `error.code`; `message` can change. It answers the request on that HTTP exchange, so it needs no id to correlate. Clubhouse Go 147 applies its general rule: a version 1 `rejected` 4xx with no `commandId` is a refusal when its epoch matches, otherwise an unknown outcome. A later Clubhouse Go adds a narrow exception for pinned mTLS, 413, `rejected`, `too_large`, version 1 and no `commandId`.

Don't resend the same bytes, since they can only be refused again. No receipt holds the id, so changed content can go out under a new commandId. Anything else stays an unknown outcome: a transport error, a mismatched commandId, or an older desktop, which drops the connection instead of answering.

The answer is written as soon as the limit is passed, while the upload may still be running. The desktop then discards what the client sends and closes the connection when the upload ends, when the client closes, after 16 MiB more, or after 10 seconds, whichever is first. A client still uploading at that point can see a transport error, even if it never got to read the answer. That is an unknown outcome, so reconcile.

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

Errors (`message` is the desktop's sentence for all but `helper_request_not_found`): 404 `helper_request_not_found` (answered, expired, dropped or reissued); 409 `helper_start_blocked`, `helper_check_failed`, `helper_work_at_risk`, `helper_work_changed` (`status:"rejected"`, the request still waits); 409 `no_valid_mapping`, `no_candidate`, `auto_off` (`status:"rejected"`, nothing was created and the request is gone); 409 `helper_start_refused`, `helper_dispose_failed` (`status:"failed"`; a refused start was used up; a failed dispose may have stopped the helper).

`no_valid_mapping` means nothing valid is offered for the start's difficulty, its presets. Show `error.message`, a sentence for a person, and offer no retry. `rejected` here says nothing was done, and only the next snapshot says whether a request still waits: a snapshot without the row is sent when the request is used up, and it can arrive before or after the receipt. Sending the same `commandId` again replays the receipt. A new one gets 404 `helper_request_not_found`.

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
| 403 | `client_certificate_required` / `authorization_revoked` | no client certificate, or trust changed mid-upload |
| 404 | `agent_not_found` | unknown or disposed agent |
| 409 | `not_chat` | the agent isn't a running chat agent (start it first) |
| 409 | `images_not_supported` | the agent's `capabilities.images` isn't `true` |
| 413 | `too_large` | over `maxImageBytes` (3.75 MB; checked from Content-Length before reading). The answer goes out at once, and the desktop drains the rest of the upload within the same bounds as [an oversized command](#oversized-commands), then closes the connection |
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

Each `snapshot` is complete, so replace the agent rows and `agentIcons` rather than merging them: an image that was removed is simply absent. A new snapshot follows any change to an agent's name, color, emoji or image, wherever it was made: Settings, `agent.update`, the `update_agent` MCP tool, the `clubhouse` CLI, or an edit to `agents.json`. The same goes for a project's name, color, emoji or image, and for a project being added or removed. An icon file replaced directly on disk under the same name is the exception: nothing sends a snapshot for that, and the next one has the new image. An image's bytes are also at `GET /api/v1/icons/agent/:agentId`, the Dispatcher's too while it is on. See [Drawing a sender](#drawing-a-sender) for how to draw these.

### Snapshot size

Clubhouse Go closes a WebSocket with code 1009 on a frame over 16 MiB, and a phone that reconnects into the same frame never recovers. So a snapshot stays well under it:

- `agentIcons` and `projectIcons` are still data URLs, but of thumbnails: a PNG within 128 by 128 pixels, or a PNG, JPEG, GIF or WebP file as it is when that's 64 KiB or less and within 256 by 256. They're always raster: an SVG is sent as a PNG copy or left out, because `UIImage` can't draw one. Don't assume a size. A generated PNG is a still image, already upright. A file sent as it is keeps its own frames and EXIF, so draw a GIF's first frame and honor a JPEG's orientation.
- Icons in one snapshot total at most 4 MiB of data URL characters. Past that, icons are left out: the Dispatcher's is kept first, then projects', then agents', in list order.
- A snapshot frame over 8 MiB gives things up in this order, until it fits: first `canvasState` and `appCanvasState`, which are left out; then both icon maps, sent empty. It adds `snapshotTruncated`: `{"version":1,"reason":"frame_limit","omitted":["canvasState","appCanvasState"],"bytes":9234567}`, where `bytes` is the frame's size before giving anything up. When it's there, a field in `omitted` is unknown rather than empty: keep what you have. Get canvases from `GET /api/v1/mobile/canvas/:projectId` and `GET /api/v1/mobile/canvas`, which answer `{"projectId":"…","state":{…}|null}` and `{"state":{…}|null}`. Capabilities has `snapshotTruncation: {version:1, canvasPaths}`. A desktop controller fetches these itself, once per connection, and once for a project that appears later with none known.
- Everything else is always sent, so a frame can still be over 8 MiB if those fields alone are that large. Over 16 MiB it isn't sent at all: see [Order on connect](#order-on-connect).
- An image that can't be made small enough is left out too: on Linux, that's any SVG, and any GIF or WebP that's large.

So `icon` set with no `agentIcons[id]` is normal. Use `GET /api/v1/icons/agent/:agentId` or `GET /api/v1/icons/project/:projectId`, or draw initials. Those routes serve the same thumbnail, or a 404 when there's none, so draw initials then. Images set through `update_agent`, `update_project` or the CLI that are over 256 KiB, or wider or taller than 256 pixels, are stored as a PNG within 256 by 256. Files on disk are otherwise left as they are.

### Icon refs

A phone that opts in gets image references in its snapshots and fetches images separately, so unchanged images are never sent again. A phone that doesn't is unaffected.

**Opting in:** when `GET /api/v1/mobile/capabilities` has `iconRefs.version >= 1`, connect with `wss://…/ws?iconRefs=1&client=mobile`, on every connection including reconnects. It's on the URL because a snapshot follows the upgrade immediately. It lasts for that socket and covers every snapshot on it. An older desktop ignores both. `client` is for metrics only, and nothing trusts it: a socket that doesn't say is counted as unknown.

**The snapshot:** `agentIcons` and `projectIcons` are always `{}` for this socket, so ignore them. `iconRefs` is new:

```json
"iconRefs": {
  "agents":   {"<agentId>":   {"version":"<64 hex>","type":"image/png","bytes":21034,"width":128,"height":128}},
  "projects": {"<projectId>": {"version":"<64 hex>","type":"image/png","bytes":18211,"width":128,"height":96}}
}
```

- `version` is the lowercase SHA-256 of the bytes the route serves. Compare it for equality only. Don't rely on it staying the same for the same picture: a file sent as it is keeps its version, but a generated thumbnail comes from the desktop's image code, so an app or OS update can change its bytes, and a restart isn't promised to keep them. A new `version` just means one refetch.
- `type` is `image/png`, `image/jpeg`, `image/gif` or `image/webp`, read from the bytes. Never SVG. `bytes`, `width` and `height` describe the served image too.
- **`iconRefs` has three states.** Absent means unknown, so keep what you have: a snapshot over its limit leaves it out and `snapshotTruncated.omitted` says so, and so does a snapshot built while an icon can't be read for a reason that can pass, with no `snapshotTruncated`. The desktop sends a fresh snapshot once that icon can be tried again (about 30 seconds), up to 3 in a row, and an icon that fails 3 tries in a row with no change to its file counts as no image. Present means complete, so replace. No entry for an id in a present map means no image, so drop what you cached. A different `version` means fetch. `icon` set with no entry is normal, and draws initials until a later snapshot gives a `version`.
- Projects are in `iconRefs.projects`. Durable agents **and the Dispatcher** are in `iconRefs.agents`. That isn't the snapshot's own `agents` map, which doesn't list the Dispatcher. A quick agent never has an entry, and draws its lightning bolt. An emoji still comes before an image.
- REST catalogs don't carry `iconRefs`, so a catalog response must not clear them. Only a snapshot on the socket changes them.
- A snapshot follows a change to an agent's or project's image and the Dispatcher turning on or off, as soon as the change is noticed. An image file replaced directly on disk under the same name has nothing to notice it: the next snapshot picks it up, whatever causes that.

**Fetching:** `GET /api/v1/icons/agent/:agentId?v=<version>` and `/project/:projectId?v=<version>`, authenticated as today.

| Case | Answer |
|---|---|
| `?v=` is current | 200, `Cache-Control: private, max-age=31536000, immutable` |
| `If-None-Match` exactly equals the current ETag | 304, no body |
| `?v=` is stale | 200 with the current image, `Cache-Control: private, no-cache` |
| No `?v=` | 200, `Cache-Control: private, max-age=3600` |
| No image | 404 `{"error":"icon_not_found"}` |
| Can't be read right now, which says nothing about the image | 503 `{"error":"icon_unavailable"}`, with `Retry-After` |

Every 200 and 304 has the current version as a strong, quoted `ETag`. Show an image only if its ETag equals the current snapshot's `version`. If it differs the response is stale: keep what you draw now and don't refetch until a new snapshot changes the `version`. Send `If-None-Match` only for an image you've validated and kept.

**Guarantees:** the desktop sends nothing, by socket or route, over 72 KiB or over 256 pixels on a side, checked on the bytes it sends. A generated thumbnail is within 128 by 128.

**What to check and keep:** check the body's SHA-256 against the ETag, its byte count, and its Content-Type, decoded type and size. Treat anything else as bad. Fetch at most 4 at once. Keep at most 32 MiB of images on disk **in total across all hosts**, least recently used first, keyed on the desktop's identity, the kind, the id and the `version`. Cap decoded images in memory at 16 MiB, at width by height by 4 bytes each: about 62 at 256 by 256, or 250 at 128 by 128.

**When anything fails** (network, 5xx, a bad decode, too large), draw initials and back off. It must never affect chat or the socket.

**Drawing:** a generated PNG is a still image and already upright. A file sent as it is keeps its frames and EXIF, so draw a GIF's first frame and honor a JPEG's orientation.

`icon-refs-cases.json` lists what to do with each kind of snapshot and response.

## Chat state and history

Authenticated `GET /api/v1/mobile/agents/:agentId/chat` returns `{version:1,epoch,agentId,sessionId,state,capabilities,events,lastSeq,truncated,pendingPermissions,pendingQuestions}`. Events use the existing ChatEvent schema. LastSeq here is **session-local**, distinct from Annex's global WS seq. Returned history is a bounded tail; pending interactions are included separately even when their events predate the tail. GET `/api/v1/mobile/agents/:agentId/chat/sessions` returns `{version,epoch,agentId,sessions:ChatSessionSummary[]}`. The chat snapshot accepts `sessionId` (optional), `beforeSeq` (exclusive, positive integer) and `limit` (1–2000, default 2000). It also returns `currentSessionId`, `readOnly`, and `nextBeforeSeq` (null when no older page). `lastSeq` always describes the full session, not the current page. Never send actions for a readOnly historical session. Pending interactions are independent of the requested page.

### Agent state

Capabilities advertise `agentState:{version:1,path:"/api/v1/mobile/agents/state"}`. Authenticated `GET /api/v1/mobile/agents/state` returns every agent's live state in one read: `{version:1,epoch,agents:[{agentId,projectId,kind,status,sessionId,sessionState,hasSession,detailedStatus,pendingPermission,pendingQuestion,lastActivityAt}]}`. `status` is `running` or `sleeping` for a durable agent and the run status for a tracked quick agent. `sessionId` and `sessionState` (a `ChatSessionState`) are null without a live chat session. It reads runtime state and agent configs only, never transcripts, so a phone can call it after every reconnect: events it missed while away (a sleep, a turn's end, a resolved request) never reach it, and replay starts from the reconnect snapshot. Treat it as newer than any status cached from chat events; reload history only for conversations on screen.

When a durable agent's process exits (stopped, idle-slept, crashed; terminal or chat), the desktop broadcasts `pty:exit` and then `{type:"agent:status",payload:{id,agentId,kind:"durable",status:"sleeping",detailedStatus:null,lastActivityAt},seq}`. Exiting drops the agent's earlier events from replay, so this frame is what a replaying phone sees.

## Live events and replay

### Order on connect

Until a socket's first `snapshot` (or `{type:"error",payload:{message:"snapshot_failed"}}` if one can't be built), it gets no events: nothing sequenced, no replay and no broadcast. WebSocket replies aren't held, so `pty:attach:ack`, the other `*:ack` frames, `error`, `replay:gap`, `telemetry:hello:ack` and a shell's `pty:data` can arrive before it. They have no `seq`, so you have no cursor to move. HTTP isn't affected at all: `POST /api/v1/mobile/commands` and every route answer whatever the socket is doing. After the snapshot come the held events in order, then live frames.

After `snapshot_failed` the socket stays open. Events still don't arrive: without a snapshot you have nothing to read them against. They're held on the desktop, up to 10,000 frames or 32 MiB. Past that, what's held is dropped but `lastSeq` stays where it was, so you'll see a jump in seq after the snapshot: replay as for any gap. A successful try sends the snapshot and then what's held. Reconnect whenever your own grace period ends.

Snapshots are built one at a time for the whole desktop, so several phones or quick reconnects don't add work: a socket connecting during a build is served by it, with its own `lastSeq`. Trying again works the same way. Inside the window a connecting phone gets `snapshot_failed` straight away and nothing is built. When the window ends, one build serves every socket waiting, each with its own `lastSeq`.

- If building failed, or took over 15 seconds, the window is 2, 8 and 30 seconds and then a minute each time, until a build works. Changes wait for the end of the window.
- A snapshot too large to send (over 16 MiB) is never sent. The window is 5 minutes, and a change to what a snapshot shows brings a look at most every 30 seconds. A connected phone keeps what it has until one fits.

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

## Chat pages and overflow

One `GET …/chat` response is at most 8 MiB encoded, whatever `limit` asks for, because real TLS rejects a response over 16 MiB, and retrying the same page fails the same way.

**Pages:** newest events first, until the page is full. `truncated` says there's more, and `nextBeforeSeq` is where the next page starts. A page can hold fewer than `limit`. An event over 1 MiB has a preview, as for live tool output, and each page is worked out afresh from the transcript, so an event reads the same each time. It doesn't carry the appended note a live update can have.

**Nothing is skipped without saying so.** An event that still doesn't fit once nothing else on the page has taken room comes in its smallest form, at its own `seq`, with `truncated` set, so paging moves on:

| Event | Smallest form |
|---|---|
| `question_resolved` | Same type: `requestId`, `cancelled`, and `answers: {}`. The answers are on the desktop. |
| `permission_resolved` | Same type: `requestId`, `decision`, `by`, and `optionId` if short. |
| `user_message` that isn't queued | Same type: `messageId`, `clientCommandId`, `source`, `delivery`, `queuedWith`, short text, and its first `routed` part. |
| `tool_call`, `tool_call_update` | Same type: `toolCallId`, `status`, `kind` or `title`, `durationMs`, exit code, and a note in `content`. |
| Text and thinking output, `usage`, `notice`, and a question or permission request that's no longer pending | `{"type":"notice","data":{"level":"info","code":"event_omitted","message":"…","omitted":{"type":"…","originalBytes":N}}}`, with the event's `requestId`, `messageId` or `toolCallId` if short. |
| Anything else, including `queue_state`, `queue_removed` and a type added later | No smaller form. If it can't fit, the page is a 503. |

Fold a `question_resolved` or `permission_resolved` as usual: empty `answers` with `truncated` still means answered. A smaller form depends on what's pending, because that shares the page: read it again once less is pending and the event comes back whole. A request or question still pending is in the lists, so a tail copy with no room is simply left out.

**Queued rows are always there.** Every `user_message` a row in `queuedMessageIds` is built from comes on the page, however old, in `seq` order at the front of `events`, so `events` can jump in `seq` there. `nextBeforeSeq` doesn't count them, so you can see one again on an older page: match by `seq`. They're whole if they fit. Otherwise only their text is shortened, to share the room left, with `truncated` set: `messageId`, `queuedWith`, `source`, `delivery`, and every block and `routed` part stay. A queued row is never a stub. If that can't fit, it's a 503.

**What's pending is all or nothing.** A partial list would read as requests being answered.

1. Up to 1 MiB of permissions: each whole, or a preview within its cap.
2. Over that, every row is minimal: `requestId`, `toolCallId`, `toolName`, `title`, a `description` starting with the warning, and only its deny options, with `reject_always` only while `persistentApprovals` is on. A row with none of those can only be viewed. Approve is refused for all of them.
3. Over 4 MiB of minimal rows, or if pending questions, queued rows or an event with no smaller form can't fit, there's no page: 503 `{"error":"pending_overflow","pendingCount":N,"message":"…"}`. If whole rows are what doesn't fit, rows go minimal first.

A question is never shortened or sent without its text, so it stays whole or the page is a 503. The full question stays on the desktop.

**A 503 leaves a phone read-only.** On build 147 it keeps its cached state but sets `requiresResync`, which disables chat send, deny and question answers until a refresh succeeds, so the desktop has to reduce what's pending. It shows only "Desktop request failed (503): pending_overflow". A cold open shows unavailable, with Try again. A refresh recovers once it's smaller.

## Frames over the limit

No frame is meant to go over 8 MiB. Most have a bound of their own, in the sections here. These are the rest.

**`canvas:state`** over the limit comes with no `state`: `{"type":"canvas:state","payload":{"projectId":"…","stateOmitted":{"version":1,"reason":"frame_limit","bytes":N}}}`, and `"projectId":null,"scope":"global"` for the app's. Ignore a `canvas:state` with no `state`, or fetch the canvases through `snapshotTruncation.canvasPaths`.

**`frame:omitted`** is the last resort, at the `seq` the event would have had, live and on replay: `{"type":"frame:omitted","seq":N,"payload":{"version":1,"originalType":"chat:event","eventType":"agent_message","agentId":"…","sessionId":"…","eventSeq":N,"bytes":N}}`.

- Advance your cursor past it, as for any `seq`. A reader that doesn't know the type loses nothing else.
- It only stands in for `agent_message`, `agent_message_chunk`, `agent_thought` and `agent_thought_chunk`: text that changes no state. A new type is never added by default. Never an approval, a question, a queue change or a status.
- It isn't fetched for you. A later `agent_message` that fits is a normal event, with its whole text, so an omitted chunk is restored by its final message, which replaces it once.
- If that final message is itself over the limit, it's omitted too, and `turn_ended` still comes. **A phone then shows the earlier text as if complete, with no live warning, until a history read.** Clubhouse Go measured this on build 147 and on its main branch: the chat goes idle with the prefix. A read of `/chat` shows that message as a preview of about 256 KiB with a note, or a stub. The whole text stays on the desktop.

**Still sent whole.** A live `chat:event` carrying a `user_message`, `question`, `question_resolved`, `plan_document` or `queue_state` over 8 MiB goes as it is and is reported, because each holds facts that can't be left out. A `hook:event` with a very long `message` is the same. Up to 16 MiB, a phone receives it.

**Over 16 MiB, a phone can't receive it.** The transport closes the socket.

- Live, it's sent once. The phone reconnects, and the new connection's first `snapshot` has a `lastSeq` at or past it, so nothing brings it back.
- On replay it's never sent. A `mobile:replay` or `replay` from before it gets `replay:gap`.
- **Recovery depends on that fresh checkpoint on each connection, not on `replay:gap`'s `lastSeq`.** Clubhouse Go measured that build 147 and its main branch ignore `gap.lastSeq`: they close once, then adopt the next connection's snapshot. So every connection's first snapshot captures its cursor when that socket connects, including one joining a running build or waiting on a retry, and tests hold that in place. A phone that kept using an older snapshot would cycle with backoff.
- The event itself doesn't reach that phone. A question that size is a 503 on `/chat` while it's pending, so it's answered on the desktop.
- Each new event of that size closes the socket once more. Nothing re-sends the same one.

## Large tool output

A `tool_call_update` whose `chat:event` is over 1 MiB goes out as a preview, live and on replay:

- `toolCallId`, `status`, `durationMs` and `exitCode` are kept.
- `content` is the start and end of each block, with a plain note between them saying how much is omitted. `contentMode` is `replace`, so it replaces what you have rather than adding to it.
- A `diff` block too large to send becomes a `text` block, because part of a diff would read as the whole change.
- `rawOutput` is left out unless it's small. If no block was cut, a text block says it's a preview, because a client may ignore `truncated`. With no `content` at all, that note is the only `content`, with `contentMode: append` so what's shown stays, and only one update for a call carries it. After a desktop restart a call can get one more. These notes are in the tool's content, so on a client that collapses tool cards they're seen when a card is opened. The always-visible warning is the permission request's `description`, below.
- `truncated: {originalBytes}` is the whole event's size.

The transcript on the desktop is whole. `GET …/chat` still returns the full event, so this recovers the output only if the whole response fits in what you can receive. With `fullEvents` in capabilities, fetch one event whole instead (see "The whole of an event"). Permission requests have their own rules, below. Other `chat:event` types aren't bounded yet (#2673).

Conditions from Clubhouse Go's tests on build 147, for any later change here: a preview must keep the id and final status, and must replace rather than append. A frame may only be left out entirely if it carries no critical fact, so never a permission, question, queue or status frame.

## Large permission requests

A permission request over 256 KiB is too large to review on a phone, wherever it arrives. For a `chat:event` `permission_request`, and `pendingPermissions` in `GET …/chat`, a phone gets:

- `description` starting with the warning below, so it's the first thing shown. `content` is one text block starting with it too, then a preview.
- `rawInput` with only its small plain fields, such as the path. `requestId`, `title`, `toolName`, `toolCallId` and `options` are kept. `truncated: {originalBytes}`.

The warning is: "Incomplete input: this request is too large to show in full here. Review it on the desktop to approve it. You can still deny it here." That last sentence is only there when a phone has a deny it supports: `reject_once`, `cancel_turn`, or `reject_always` while `persistentApprovals` is on. With none of those it's: "Incomplete input: this request is too large to show in full here. Review it on the desktop." The refused approve's message follows the same rule.

**Approve is refused:** `chat.permission` with anything but a deny option answers 409, `status:"rejected"`, `error:{code:"incomplete_representation",message}`. Denying still works. Full review is on the desktop, and the pending call itself is never changed. Approve is also refused when the desktop can't establish you were shown the whole request: one left pending across its restart, unless the whole original request, options included, is at most 4 KiB, which is whole on every path. It's refused too if the options the agent would act on aren't the ones you were sent.

**Approving after fetching it whole (#2731):** a desktop with `fullEvents` in capabilities lets a phone fetch the request and then approve it. Fetch it as described in "The whole of an event", below, and keep the response's `digest`. Then send `chat.permission` with `reviewedDigest` set to that digest. The approval is taken when all of these hold, and refused with `incomplete_representation` otherwise:
- this same paired device fetched the request, since the desktop last started and since it was last paired;
- the request still pending is exactly what it fetched;
- the options the agent would act on are the ones in the request.

The record is in memory, so after a desktop restart, fetch it again.

**The `tool_call` for it:** over 256 KiB, a `tool_call` keeps its id, title, kind, status and locations. Its `rawInput` has only small plain fields, its `content` starts with a text note saying it's a preview, then a preview of any content, and it has `truncated: {originalBytes}`.

**All pending, together:** the permissions in `/chat` total at most 1 MiB. Past that each gets a share, and one forced below its own cap counts as incomplete, with the same warning and refusal. None is ever left out.

**Paths that draw no card** (`hook:event`, outer `permission:request` and the snapshot's `pendingPermissions`) carry at most 64 KiB of `toolInput`: its small plain fields, and `toolInputTruncated: {originalBytes}`. `POST …/permission-response` refuses `allow` with 409 `incomplete_representation` for a call that's over that. `hook:event` keeps `detailedStatus`.

## The whole of an event

Capabilities `fullEvents: {version:1, path, maximumBytes, approvalField:"reviewedDigest"}` (#2731). Any `chat:event`, or event in `GET …/chat`, that came with `truncated` can be fetched whole:

`GET /api/v1/mobile/agents/{agentId}/chat/events/{seq}?sessionId={sessionId}`, with pinned mTLS like `/content`.

It answers `{"version":1,"agentId":"…","sessionId":"…","seq":7,"digest":"sha256:…","event":{…}}`, where `event` is the original from the desktop's transcript.

Errors:
- 400 `invalid_query`: the seq or `sessionId` is missing or bad.
- 404 `agent_not_found` or `event_not_found`.
- 413 `event_too_large` with `bytes` and `maximumBytes`: the response would be over `maximumBytes`, 32 MiB.
- 403 `client_certificate_required` or `authorization_revoked`.

It's an HTTP response, not a frame, so it isn't held to the socket's 16 MiB. A permission request's `digest` is what `chat.permission` takes as `reviewedDigest` (see "Large permission requests").

Events over 16 MiB that carry a fact that can't be left out (a `user_message`, `question` or `plan_document`, for example) still close the socket. That part of #2731 waits for `clubhouse.annex.frames.over_limit` to show it happens.

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
4. **Initials**: bold on the agent's solid color, in the [text color](#initials-text-color) for that color.

**Initials:** split the name on `-`, take the first code point of each piece, skip empty pieces, uppercase, keep the first two code points. `-` is the only separator. So `Dispatcher` is `D`, not `DI`; `clever-fox` is `CF`; `one-two-three` is `OT`; `my_agent` and `Two Words` are `M` and `T`; `🦊-fox` is `🦊F`. Never cut a surrogate pair: in Swift or Kotlin, count code points rather than UTF-16 units. The `initials` list in `sender-identity.json` has more.

**Colors:** `color` is an id. An unknown or missing one is indigo.

| id | hex | id | hex |
|---|---|---|---|
| `indigo` | `#6366f1` | `violet` | `#8b5cf6` |
| `emerald` | `#10b981` | `orange` | `#f97316` |
| `amber` | `#f59e0b` | `teal` | `#14b8a6` |
| `rose` | `#f43f5e` | `cyan` | `#06b6d4` |

#### Initials text color

The text color comes from the background, with no field on the wire. `initialsTextColor` in `src/shared/agent-avatar.ts` is the desktop's copy, and every place the desktop draws initials on a solid agent color uses it. For a background `#rrggbb`:

1. For each channel, `c = value / 255`, then `c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4`.
2. `L = 0.2126 * r + 0.7152 * g + 0.0722 * b`.
3. `onWhite = 1.05 / (L + 0.05)` and `onBlack = (L + 0.05) / 0.05`.
4. Draw `#ffffff` when `onWhite >= onBlack`, otherwise `#000000`.

These are exactly white and black, not a theme's light and dark, so one of them always reaches at least 4.58:1. Every color in the table above gets `#000000` today. `colors[].initialsText` in `sender-identity.json` has the result for each color. This covers initials on a solid color only: an emoji's tinted background and images are unaffected.

### Laying out a message

- **You:** on the right, in a filled bubble, labelled "You".
- **Others:** on the left, one entry per part: the avatar, then the name above an unfilled bubble with a neutral hairline border. Parts of one message stay together, even with different senders. The active agent's replies aren't in this layout.
- **Color:** agent color appears only in the avatar. Don't tint bubbles, borders, names or message backgrounds with it. The desktop fills your bubble with a neutral surface and draws the others with no fill and a 1px neutral border, so the fill alone says who wrote it.
- **Long messages:** see [Chat reading rules](#chat-reading-rules). Desktop collapses a part with a newline or over 120 characters to one row with a first-line preview; phones collapse every routed part.
- **Text:** a part with a `sender` is Markdown. A Clubhouse notice or a part with no sender is plain text.

### Chat reading rules

Desktop and phones apply the same rules to a busy transcript (#2664). They are computed on the client from existing events, with no contract change. Chronology is always preserved.

**What groups.** A run of adjacent groupable items with at least 2 counted items becomes one expandable row, for example "Made 6 tool calls, 2 messages from Orchestrator and go-helper". With fewer than 2, the item shows as its normal row.

- Counted: a top-level `tool_call` that hasn't failed, didn't exit non-zero, has no open permission request and shows no images; and a routed message (`messageDisplay` says it's from others) with no `sendState` that isn't a helper question (text starting `[QUESTION FROM HELPER:`).
- Carried: a thought, and a finished, non-streaming `agent_message` with no text. These stay in the group, in order, uncounted, and only when something counted follows. Otherwise they show after it.

A group's identity is its first item's id, so it survives growing. Its rows aren't built until it opens, and each keeps its own open state.

**What breaks a group and always stays visible.** An `agent_message` with text, and one still streaming even with no text yet; the user's own message; a question, plan, error, every notice, a turn end and a subagent card; a failed tool, a command that exited non-zero, a tool awaiting approval and a tool with visible images; a routed message with `sendState`, and a helper question; a change of subagent id. A tool that later fails or needs approval leaves its group and splits it. Compaction stays one notice row, in progress and then settled.

**Failed output.** The row, exit status and error always show. Output of 6 lines or fewer starts open. Longer output starts closed with its last line showing. Blank lines, including lines of only whitespace, are left out of both the length and that last line, on the desktop and in Clubhouse-Go#217. The user's toggle wins.

**Navigation stops.** One stop per item, never merged, landing on the item's top:

- an `agent_message` with no `subagentId` and non-empty text once the task marker is stripped (`messageId`), which counts while streaming once it has text, and includes slash command output
- a `plan_document` (`planId`)
- a `question` (`requestId`)

Tools, thoughts, routed messages, the user's messages and subagent work aren't stops, and a stop is never inside a group. Previous goes to the top of a stop partly scrolled past, otherwise the stop before. Next goes to the first stop below the viewport's top.

**Reading position.** The anchor is the first row reaching into the viewport and its offset, identified by key. It is restored after streaming, expansion, history loading, a window move or a layout change.

**Following and Latest.** The bottom means within 16 of the end. An upward scroll of more than 1 stops following, even inside that band, and Latest shows while paused there. At the true bottom with every row mounted, following resumes and Latest hides, whether the reader scrolled there or content shrank, with no scroll event. Latest shows only when not following or when later rows aren't mounted, and an explicit Latest resumes following.

**Platform differences.**

| | Desktop | Phones |
| --- | --- | --- |
| Routed message | Collapsed when it has a newline or is over 120 characters; shorter ones show in full | Always compact, whatever the length |
| Single routine item | Its normal row | Compact |
| Routed attachments | Shown on the message | Counted in the summary |
| Finished thoughts | Carried in a group | Finished system messages stay as boundaries, because the wire has no reliable thought marker |
| Bottom tolerance | 16px | 16pt initial tolerance |
| Plans as stops | A plan row | A `plan_document` reaches the phone as an assistant message, so it stops there |
| Previous and next | Buttons, and Cmd+Opt+Up/Down (Ctrl+Alt off macOS) | Touch controls |
| Sender faces on a closed activity row | None. The label names the first two senders, then "and N others" | Clubhouse Go keeps the first three unique sender faces, then a count of the rest |

Tool images break a group on both. Phones have no subagent rows.

**On Clubhouse Go's main, not in a phone build yet.** Clubhouse-Go#217 merged at `edab44e` with these shared rules, but they aren't in a phone build yet: the long failed output fold (status or exit code, with a last-line preview), and telling the true bottom from paused near the bottom for Latest. The evidence so far is from the Mac and the simulator only, with no test on a phone by hand.

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

**System turns.** A `turn_started` with `trigger: "system"` consumes no row, including under the exception above. It is the agent's own work (`/compact`, a permission or question with no turn open, an agent starting on its own), so the row stays for the next turn that isn't `system`. `systemTurn` in `queued-bursts.json` shows this on a provider-held queue, with `rowId` naming the row that stays.

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

Capabilities now includes `pairing: {sessionRevokePath:"/api/v1/mobile/pairing"}`. `DELETE` that path using the paired pinned client certificate to revoke **only the caller's in-memory session pairing**. Response: `{version:1,epoch,revoked:true,pairingMode:"session"}`. It closes that peer's WebSockets (code 4401, reason `peer_not_paired`). No body or target identity is accepted. A persistent peer (including one shadowed by a session peer) receives HTTP 409 `{error:"persistent_pairing_requires_desktop"}` with no trust change; remove it in desktop settings. An unpaired caller, or one with a certificate other than the pinned one, receives 401; one with no client certificate receives 403. If the phone is offline, local removal alone cannot revoke desktop memory: explain that it lasts until explicit desktop disconnect or Annex stop. Repeated DELETE after success is unauthorized because trust is already gone.

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

- `context` is what the running session reports: `{"effectiveTokens":300000|null,"compactAtTokens":267000|null,"reservedTokens":33000|null,"note":"…"|null}`, or `null` until it reports anything. A null field isn't reported, so omit that line and show no estimate. `note` is plain text or null, for example that Claude's figure is a working window and not the model's capacity. It changes with `session_info.contextLimits` and `usage.context.size`, which arrive at session start, after a model change and at turn end. Claude reports all three numbers; Codex and Copilot report `effectiveTokens` only. See [Context choice](#context-choice) for how this differs from the saved choice.
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
- Saved Access is its own capability, `access: {version:1}`: see [Access](#access).

## Durable agents

Create (#2451) and settings (#2452) follow the desktop New agent page and the Details → Settings card. Both reads need an authenticated client; the commands need the pinned client certificate like every mobile command.

**Helpers** are durable agents another agent started. They carry `parentAgentId`, the id of that agent, in the snapshot's `agents[projectId][]`, `GET /api/v1/projects/:id/agents` and the [settings route](#settings). Top-level agents leave it out, so its presence is what marks a helper. The parent can be in another project (#2511), so it may not be in the same `agents[projectId]` list. A helper handed off as a normal agent loses the field. Additive: older desktops never send it, and older phones ignore it.

**Free Agent Mode** (skip all permission prompts) is settable from a phone when capabilities have `permissions.freeAgentMode` ([Permissions from a phone](#permissions-from-a-phone)). As on the desktop, it needs an orchestrator with `permissions:true`: turning it on for one without is 409 `free_agent_mode_unavailable`; turning it off is always allowed. Omitted on create, the agent follows the project's agent defaults, as on the desktop. Older desktops refuse the field with 403 `free_agent_mode_not_allowed`.

**Access (#2761).** The desktop now stores one Access level per agent (Plan, Ask first, Auto-accept edits, Auto, Full access) instead of Free Agent Mode. The phone contract keeps `freeAgentMode` unchanged. It reads `true` when the agent is at Auto or Full access, and `false` at the other levels. Setting it from a phone moves the agent to the nearest level: `true` keeps a level that is already Auto or Full access, or takes the level the desktop's old free agent permission mode gives (Full access, or Auto when that mode was Auto); `false` keeps a level that is already below Auto, or becomes Ask first. Omitted on create, the agent starts at the desktop's Default access, which replaces the project's agent defaults for this. A phone that knows `access.version >= 1` reads and sets the level itself instead: see [Access](#access).

### Access

Saved Access (#3207): the level an agent's CLI starts at, the same setting as the desktop's Access picker on the New agent page and the Settings card. Gated on `access: {version: 1}` in capabilities. Older desktops refuse an `access` field with 400 `invalid_command`.

| id | label | description |
|---|---|---|
| `plan` | Plan | Reads and plans. Makes no changes. |
| `ask` | Ask first | Asks before edits and commands. |
| `auto_edit` | Auto-accept edits | Makes file edits without asking. Asks before commands. |
| `auto` | Auto | A check decides what needs your approval. It can be wrong. |
| `full_access` | Full access | Runs everything without asking. |

The ids are the chat composer's levels (`chat.setLevel`, `chatControls.level`). The labels and descriptions come with every list (`accessLevels`, `settings.access.choices`), so draw those rather than this table.

- **Agent rows.** The snapshot's `agents[projectId][]`, the Dispatcher's `agent` and `GET /api/v1/projects/:id/agents` carry `access`, the saved level. `freeAgentMode` stays beside it, `true` at Auto or Full access, so older phones read what they always did. Don't show `true` as "every permission skipped": Auto asks when its check says to.
- **Create options.** `accessLevels` lists all five as `{id, label, description}`. Each orchestrator's `accessLevels` holds the ids a new agent on that CLI can be given (the levels either runtime has, since the runtime isn't decided yet), and only `["ask"]` when `permissions` is false. `defaults.access` is the desktop's Default access, which a new agent gets when the command sets neither `access` nor `freeAgentMode`.
- **Settings.** `settings.access` is `{value, editable, choices, startsAt, default, applies}`. `value` is the saved level. `choices` are the levels its CLI can start at in the runtime it starts in (`settings.runtime.resolved`), as `{id, label, description}`. `startsAt` is the level it really starts at: the saved one, or when the runtime lacks it, the nearest lower one it has (Copilot in a terminal has no Auto, so Auto starts at Ask first). Show `value` even when it isn't in `choices`, as the desktop marks it "not available for this CLI". `default` is the desktop's Default access. `editable` follows the spawn settings: `sleeping` for an ordinary agent, `always` for the Dispatcher, `never` when the CLI sets access itself.
- **When it applies.** `applies` is always `next_start`: saving never changes a running session. The running session's level is `chatControls.level`, which `chat.setLevel` changes for that session only. The desktop's details card shows both when they differ ("Auto now, starts at Ask first"), and a phone should too.
- **agent.create `access`** sets the level. It must be one of that orchestrator's `accessLevels`, else 409 `access_unavailable` with a sentence in the message, before anything is created. It wins over `freeAgentMode` in the same command, which is then ignored.
- **agent.update `access`** saves a level for the next start. It is a spawn setting, so it is 409 `agent_running` while an ordinary agent is awake, and accepted at any time on the Dispatcher. It must be one of the `choices` for the CLI and runtime the agent will start on, counting a new `orchestrator` or `runtime` in the same command, else 409 `access_unavailable`. Sending the saved level back unchanged is always accepted. It wins over `freeAgentMode` in the same command. The result's `settings.access` is fresh.

Fixtures: `create-options.json`, every `agent-settings*.json`, the agent rows in `snapshot.json`, `rest-catalog.json` and `snapshot-dispatcher.json`, and the `access` cases in `commands/agent.create.json` and `commands/agent.update.json`.

### Create options

`GET /api/v1/mobile/projects/:projectId/create-options` (404 `project_not_found`):

```json
{"version":1,"epoch":"uuid","projectId":"p1",
 "orchestrators":[{"id":"claude-code","displayName":"Claude Code","shortName":"CC","badge":"…","available":true,"unavailableReason":"…","permissions":true,"accessLevels":["plan","ask","auto_edit","auto","full_access"],"chat":true,"models":[{"id":"default","label":"Default"},{"id":"opus","label":"Opus"}]}],
 "personas":[],
 "colors":[{"id":"indigo","label":"Indigo","hex":"#6366f1"}],
 "accessLevels":[{"id":"plan","label":"Plan","description":"Reads and plans. Makes no changes."}],
 "mcp":{"catalog":[{"id":"ado","name":"Azure DevOps","description":"…"}],"defaults":["ado"]},
 "isGitRepo":true,"suggestedName":"brave-otter",
 "defaults":{"orchestrator":"claude-code","color":"indigo","model":"default","useWorktree":true,"access":"ask"},
 "freeAgentMode":{"allowed":true}}
```

`orchestrators` are the enabled ones, in the desktop's order (provider profiles were removed in #2749, so a project no longer narrows them); the first is the default. `available:false` (with `unavailableReason`) means the CLI isn't found; the desktop still lets you create such an agent. `permissions:false` means the CLI sets access itself. `chat` means the agent can run in chat (Chat preview on, and the provider has a chat driver). `models` may include custom IDs; any model string is accepted. `badge` and `unavailableReason` are omitted when absent. `suggestedName` is a fresh random name per request. `freeAgentMode.allowed` means `agent.create` takes `freeAgentMode`; offer the toggle only for orchestrators with `permissions:true`, as the desktop page does ("Free Agent Mode (skip all permissions)", otherwise "(not supported)").

### agent.create

Validation matches the desktop. All of it runs before anything is created:

- **name**: trimmed. With a worktree it becomes a folder and a git branch (unless `folderName` is given), so it must be a valid git name: 400 `invalid_name`, with the reason in `message`.
- **color**: one of the `colors` ids (400 `invalid_color`).
- **orchestrator**: one of `orchestrators` (409 `orchestrator_unavailable`). The default is `defaults.orchestrator`.
- **model**: `"default"` or omitted means the provider default.
- **freeAgentMode**: `true` skips all permission prompts. Needs an orchestrator with `permissions:true` (409 `free_agent_mode_unavailable`). Omitted follows the project defaults.
- **access**: the level it starts at, one of the orchestrator's `accessLevels` (409 `access_unavailable`). Wins over `freeAgentMode`. See [Access](#access).
- **persona**: a value is refused with 409 `managed_agent` and a sentence in the receipt's message, and nothing is created. Personas were retired (#2901), so `personas` is always `[]`; the key stays for phones that read it.
- **mcpIds**: unique catalog ids (400 `unknown_mcp`). Omitted means the project defaults when the agent starts.
- **useWorktree**: defaults to `isGitRepo`. `true` outside a git repo is 409 `not_git_repo`.
- **folderName, branchName, branchFrom**: need a worktree (400 `worktree_options_require_worktree`). They are git-name checked (400 `invalid_folder_name` / `invalid_branch_name`).
- **orchestration**: the policy fields to set, without nulls ([Orchestration](#orchestration)); 400 `invalid_orchestration` before anything is created.

A conflict found at creation, such as a folder or branch already in use or a missing base branch, is 409 `create_refused` with the reason in `message`.

The receipt returns as soon as the agent's record exists. Its worktree is made in the background, as on the desktop:

`result: {agentId, projectId, name, branch, worktreePath, state:"creating"|"sleeping"}`

The snapshot (via `snapshot:refresh`) shows the agent, then its creation ending as ready (sleeping) or failed. To give it a first prompt, wait for it to leave `creating`, then send `agent.start {agentId, message}`.

### Settings

We chose a route rather than snapshot fields. The settings need disk and CLI reads: model lists and CLI availability. The snapshot is rebuilt on every refresh for every client, and an agent's settings change rarely.

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
  "persona":{"value":null,"editable":"never"},
  "clubhouseMode":{"value":null,"projectEnabled":false,"editable":"never"},
  "freeAgentMode":{"value":false,"editable":"sleeping"|"never"},
  "access":{"value":"ask","editable":"sleeping"|"always"|"never","choices":[{"id":"ask","label":"Ask first","description":"Asks before edits and commands."}],"startsAt":"ask","default":"ask","applies":"next_start"},
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
- **clubhouseMode**: always `null` with `never`, and `projectEnabled` always `false`. Clubhouse Mode was retired (#2901); the keys stay for phones that read them.
- **persona**: always `null` with `never`. Personas were retired (#2901); the key stays for phones that read it.
- **idleSleep**: `minutes` and `source` are the resolved timeout, where 0 means never. An inherited value follows the app's chat idle timeout (`options.idleSleep.appMinutes`). Desktop copy: "After 30 min idle" / "Never", summary "Sleeps after 30 min" / "Never sleeps". Only chat agents idle-sleep (`applies`), but the value is kept either way.
- **freeAgentMode**: `sleeping` when the agent's orchestrator has permission support, else `never` (the Settings card's Access row: "Free agent" / "Ask before edits").
- **access**: the saved level, with its choices and when it applies. See [Access](#access).
- **hasImageIcon**: image icons are read-only from a phone. Setting an emoji replaces an image icon.

### agent.update

Send only what changed:

- **name**: trimmed. Git-name checked when the agent has a worktree (400 `invalid_name`).
- **color**: a `colors` id.
- **emoji**: up to 16 UTF-16 units. `null` clears it.
- **orchestrator**: one of `orchestrators` (409 `orchestrator_unavailable`). A different CLI resets the model to default unless `model` is in the same command, and starts a new session on the next wake. No conversation or context moves over, and the agent's `hasSession` becomes false. When that drops a saved session, the result has `sessionReset:true`; otherwise the field is absent.
- **model**: `"default"` clears it.
- **contextWindow**: a `choices[].id`, or `null` to clear it. See [Context choice](#context-choice).
- **runtime**: `default`, `chat` or `terminal`. `chat` and `terminal` need chat to be available (409 `runtime_unavailable`).
- Every agent refuses a **persona** value and any **clubhouseMode**, with 409 `managed_agent` and a sentence in the receipt's message. Nothing in the command is saved. `persona: null` changes nothing, so it is accepted, also while the agent runs, and the rest of the command applies.
- **freeAgentMode**: boolean. `true` needs an orchestrator with permission support (409 `free_agent_mode_unavailable`).
- **access**: a level from `settings.access.choices` (409 `access_unavailable`). Wins over `freeAgentMode`. See [Access](#access).
- **idleSleep**: `"inherit"`, `"never"`, or one of `options.idleSleep.minutes`.
- **orchestration**: a partial policy, or `null` to clear every override ([Orchestration](#orchestration)). It changes at any time, also while the agent runs, and is written first: a refused policy change saves nothing else.

Rejections:

- A `sleeping` setting on an awake or starting agent is 409 `agent_running`, and nothing is saved.
- An agent still being created is 409 `agent_creating`.
- Instructions, skills, agent definitions, MCP JSON, permission rules, the launch wrapper and helpers are not accepted. Any unknown field is 400 `invalid_command`.

The receipt `result` is the settings payload above, without `version`, `epoch` and `options`. The desktop windows and other clients are told about the change through `snapshot:refresh`.

### Context choice

A per-agent context setting, where the CLI really has one (#2660). `settings.contextWindow` is on `GET /mobile/agents/:id/settings` and in every `agent.update` result.

**Gates.** `capabilities.contextWindow: {version:1}`: the host accepts `agent.update.contextWindow`; don't send the field without it. `settings.contextWindow` absent: an older host, so hide the row. Present: draw it, as below.

```json
"contextWindow":{"value":"500000"|null,"editable":"always"|"sleeping"|"never","configurable":true,
 "kind":"working_window"|"context_window"|"tier"|null,"label":"Working context","description":"…"|null,"defaultLabel":"Auto"|null,
 "choices":[{"id":"500000","label":"500K","tokens":500000}],"defaultTokens":258400|null,"maxTokens":1000000|null,"costNote":"…"|null,
 "applies":["launch","resume"],"state":"unsupported"|"pick_model"|"unavailable"|null,"reason":"…"|null,"notice":"…"|null}
```

- **value** is the saved choice for the next start. It equals a `choices[].id`, or is `null` for no saved choice, where the CLI decides and the row reads `defaultLabel`. With `state:"unavailable"` it can be a saved id with no matching choice: show it as saved and not applied.
- **configurable** says whether the CLI offers this for this model. **editable** says when Clubhouse lets it change. A row can change only when `configurable` is true and `editable` allows it. `editable` is `sleeping` for an ordinary agent (changeable when the response's `sleeping` is true, otherwise locked), `always` for the Dispatcher, and `never` when `configurable` is false.
- **applies** is `["launch","resume"]` for running agents, sleeping agents and the Dispatcher alike. No value means live: saving never restarts anything and doesn't change a running session. Ignore an entry you don't know.
- **state** and **reason** are set when `configurable` is false: `unsupported` (no such setting for this CLI or model), `pick_model` (it depends on the model, so choose one), `unavailable` (the catalog can't be read, for example no Copilot login). Show `reason`, disabled.
- **tokens**, **defaultTokens** and **maxTokens** are null or absent where the CLI doesn't say. Never estimate one. **costNote** is plain text.
- **notice** says why a saved choice was last cleared. The next explicit choice removes it.

**kind** is a closed list, null when `configurable` is false. Draw the host's `label` and `description` rather than hardcoding them.

| kind | label | CLI | what it is |
|---|---|---|---|
| `working_window` | Working context | Claude Code | When Claude Code compacts. It doesn't change the model's own window, so it mustn't read as the model's capacity. |
| `context_window` | Context window | Codex | The window Codex uses. A choice's `tokens` is the usable size, after Codex's percent. |
| `tier` | Context tier | Copilot | One of the model's tiers. Ids are `default` and `long_context`. With no saved choice, Copilot uses its own setting and a resumed session keeps the tier it last used. |

An unknown `kind` from a newer host: when `configurable` is true, the choice list still works, so draw `label`, `description` and `choices` generically, with no kind-specific behaviour.

**agent.update `{agentId, contextWindow: string|null}`.** A string must be a current `choices[].id`, or 400 `invalid_context_window`; it's also refused when the catalog can't confirm it. `null` clears it and always succeeds. On an ordinary agent it's a spawn setting (409 `agent_running` while awake). On the Dispatcher it's allowed at any time, and every other locked field stays locked.

The result carries fresh `settings`, so don't refetch after a model or orchestrator change. When that change cleared the saved choice, the result also has `contextWindowReset: {previous, reason}`, absent otherwise, with `settings.contextWindow.value` null and `notice` set to the reason. A new orchestrator always clears it, because a value only means something to the CLI it was chosen for.

**Current and pending.** `settings.contextWindow.value` is pending: the next start. [`chatControls.context`](#chat-controls) is current: the running session as the CLI reports it. They can differ, so show both and don't overwrite one with the other.

**Not applied at a start.** The existing chat `notice` event, with no new event type: `{"type":"notice","data":{"level":"warn","code":"context_window_not_applied","message":"…"}}`. It's sent once, at session start, when a chat agent with a saved choice starts or resumes without it being passed to the CLI. If the model no longer offers it, it's cleared and `notice` is set. If the catalog can't confirm it, it stays saved. Draw `message` as any notice and match on `code`, not on the text. A terminal agent has no chat stream, so a phone sees only `notice`, in the cleared case.

Fixtures: `agent-settings-context-window.json` has `cases` (each kind, `unsupported`, `pick_model`, `unavailable`, `unavailableWithSavedChoice`, `dispatcher`), `currentAndPending` and `notAppliedNotice`. `commands/agent.update.json` has the updates, the null reset, the refusals and `contextWindowReset`.

## Orchestration

An agent's orchestration policy (#2228), as the desktop's Orchestration card and the agent's Helpers settings edit it. Gated on `orchestration: {version: 1}` in capabilities.

Every durable agent in the snapshot (`agents[projectId][]`), `GET /api/v1/projects/:id/agents` and the [Settings](#settings) payload (so the `agent.update` result) has:

```json
"orchestration":{"orchestrate":false,"access":"same","control":"hands-off","maxHelpers":5,
 "crossProjectHelpers":false,"connectToDispatcher":false,"mcpEnabled":true,
 "sources":{"orchestrate":"default","access":"default","control":"default","maxHelpers":"agent","crossProjectHelpers":"default","connectToDispatcher":"default"},
 "maxHelpersCap":20,"controls":["hands-off","ask-before-start","ask-everything"],"accessLevels":["same","standard","auto","bypass"]}
```

- **orchestrate**: "Let this agent orchestrate".
- **access**: "Helpers get": one of `accessLevels`. `same` follows the orchestrator; a fixed level is a ceiling request, and a helper never gets more than its orchestrator runs with.
- **control**: one of `controls` (hands-off, ask before starting helpers, ask about everything).
- **maxHelpers**: "Helpers at once", a whole number from 1 to `maxHelpersCap` (the app-wide helper cap, at most 100).
- **crossProjectHelpers**: "Cross-project helpers" (#2512): the agent may start helpers in other registered projects. The desktop shows it while `orchestrate` is on; turning it off leaves helpers already running elsewhere alone.
- **mcpReportOnly**: no longer sent. The Clubhouse MCP always runs, so a helper is never report-only.
- **connectToDispatcher**: "Connect to Dispatcher" (#2534): the Dispatcher may message this agent and get its reports. The desktop shows it while the [Dispatcher](#dispatcher) is on, with `orchestrate` on or off; turning it on while the Dispatcher is off is 409 `dispatcher_off`. Unset (source `default`), it follows `orchestrate` (#2578). A helper (an agent with `parentAgentId`) talks only to its parent, so on a helper it is always `false` with source `default`, and a value sent for one has no effect while it is a helper. Don't offer the switch on a helper. So an agent can report `true` with the Dispatcher off: send this field only when the user changes it.
- **mcpEnabled**: always `true`. The Clubhouse MCP always runs, and no setting turns it off for an app, a project or an agent (the maintainer, 2026-11-07). It stays in the payload so older phones keep working; never disable the orchestration switches on its account.
- **sources**: where each field comes from. `agent` is an override on the agent, which `null` clears; `default` is the built-in default. (A `persona` source, from a persona's front matter, was retired in #2901.)

`agent.update` takes `orchestration` as a partial object: `{"orchestrate"?: bool|null, "access"?: string|null, "control"?: string|null, "maxHelpers"?: int|null, "crossProjectHelpers"?: bool|null, "connectToDispatcher"?: bool|null}`. Each key sets that field; `null` clears it back to the default. `"orchestration": null` clears all six. Phones gate `crossProjectHelpers` and `connectToDispatcher` on the payload having them (and Connect to Dispatcher on `dispatcher.enabled`); a phone that doesn't know them ignores them. `agent.create` takes the same object without nulls. Writes go through the desktop's own policy service, so the desktop UI updates live.

Rejections:

- 400 `invalid_orchestration`, with the reason in `message`: an unknown field, a bad `access` or `control`, `maxHelpers` outside 1 to `maxHelpersCap`, an empty object, or a null on create.
- 409 `orchestration_has_helpers`: turning `orchestrate` off while the agent has live helpers. Nothing changes; the desktop asks whether to keep or dispose them.
- 409 `dispatcher_off`: `connectToDispatcher: true` while the Dispatcher's switch is off.
- 409 `mcp_off` is no longer returned: the Clubhouse MCP always runs. Tolerate it from an older desktop.
- A non-object `orchestration` (or `null` on create) is 400 `invalid_command`.

## Helper presets

The model and effort a `difficulty` picks on each CLI (#2671), as Settings > Smart selection edits them. Fixtures: `helper-routing.json`, `helper-routing-helper.json`, `helper-routing-changed.json`, `commands/helperRouting.update.json`. The design, and what later stages add, is in `docs/helper-auto-routing.md`.

Gate on `helperRouting` in capabilities. It lists only what works now, so don't offer anything it doesn't list. Offer Auto only when `modes` has `auto`.

```json
"helperRouting":{"version":1,"path":"/api/v1/mobile/helper-routing","modes":["explicit","preset","auto"],"scopes":["app","project","agent"],"quota":true,
 "quotaStates":["known","low","near_limit","exhausted","unknown"],"unknownReasons":["not_read","stale","not_applicable","read_failed","not_supported"],"quotaSources":["cli_query","session_event","none"],
 "commands":["helperRouting.update"],"snapshotField":"helperRoutingRevision","event":"helper_routing:changed",
 "difficulties":["easy","medium","hard"],"levels":["minimum","easy","medium","hard","maximum"],
 "presetProviders":["claude-code","codex-cli","copilot-cli"],"autoCandidates":["claude-code","codex-cli"],
 "reasons":["explicit_request","persona_pinned","preset_on_cli","only_candidate","lower_pressure","lower_load","fair_rotation","better_quota_tier","unknown_fallback","sticky","default_order"],
 "fallbacks":["none","builtin_preset","candidate_skipped","model_unverified"],
 "skipped":["cli_disabled","cli_unavailable","auto_not_supported","no_valid_mapping","cooling_down","quota_near_limit","quota_exhausted"],
 "autoOffReasons":["not_enabled","project_off","orchestration_off","mcp_off","dispatcher_locked"],
 "cellStates":["valid","unverified","stale"]}
```

### Reading

`GET /api/v1/mobile/helper-routing`, with optional `projectId` or `agentId`, which add that project's or agent's Auto setting. Model lists and quota are each CLI's own, for its one local login (provider profiles were removed in #2749), whichever is given. 404 `project_not_found`, `agent_not_found`.

```json
{"version":1,"epoch":"uuid","revision":"r12.0","serverTime":"…","labels":{…},
 "providers":{
  "codex-cli":{"autoEligible":true,
   "quota":{"state":"known","source":"cli_query","asOf":"…","limitingWindow":"weekly","resetsAt":"…",
    "weekly":{"usedPercent":41,"resetsAt":"…"},"fiveHour":{"usedPercent":12,"resetsAt":"…"},"refreshAfterSeconds":300},
   "choices":{"source":"live","asOf":"…","models":[{"id":"gpt-6.1-sol","label":"Sol","efforts":["low","high"]}]},
   "cells":{"hard":{"effective":{"model":"gpt-6.1-sol","effort":"high"},"source":"builtin","state":"valid","custom":null,"builtin":{"model":"gpt-6.1-sol","effort":"high"},"editable":true},…}},
  "copilot-cli":{"autoEligible":true,"autoCandidate":false,
   "quota":{"state":"unknown","unknownReason":"not_supported","source":"none","asOf":null},
   "choices":{"source":"live","asOf":"…","models":[{"id":"claude-haiku-4.5","label":"Claude Haiku 4.5","efforts":[]}]},
   "cells":{"hard":{"effective":{"model":"claude-opus-5.5","effort":"high"},"source":"builtin","state":"valid","custom":null,"builtin":{"model":"claude-opus-5.5","effort":"high"},"editable":true},…}}}}
```

- **labels**: the words for every code, in the families `reason`, `fallback`, `skipped`, `quota`, `unknown`, `window`, `autoSource`, `autoOff`, `cell` and `generic`. Every read has all of them, including a bare one, so cache them once per revision for rows that only have codes. For a code you don't have, use `labels.generic.unknownCode`, then your own generic "Other".
- **cells**: `effective` is what a start uses now. `custom` is the saved choice, or null. `state` is that of the saved choice, or of the built-in without one: `valid`, `unverified` (the list may be out of date, so it couldn't be checked) or `stale` (no longer offered, with `staleReason` `model_unavailable` or `effort_unavailable`). A stale saved choice stays saved. `effective` is then the built-in, with `fallback: "builtin_preset"`, or null if that is stale too, and a start with that difficulty is refused. Offer Reset whenever `custom` is set.
- **levels** (#3044): `cells` has a row for each entry in the capability's `levels`, which adds `minimum` and `maximum` around the `difficulties`. Without `levels`, show only `difficulties`. An unset minimum or maximum shows the cell of the difficulty it uses, with `follows` (`easy` or `hard`) and `custom: null`. `follows` is also set on a stale saved one that falls back. `difficulties` stays what `start_helper` takes.
- **autoEligible**: whether a provider has presets, so show its cells. A provider without them has `reason: "auto_not_supported"` and `cells: null`.
- **autoCandidate** (#3085), and the capability's `presetProviders` and `autoCandidates`: whether `cli: "auto"` chooses between it and the others. Copilot has presets but is `false`: Auto doesn't pick it, and it has no quota source. Absent from older desktops, where every eligible provider was a candidate.
- **efforts**: a model's `efforts` can be empty (some of Copilot's are). Then a cell for it has `effort: null`, which is valid, and a level on it is refused with `effort_unavailable`. Say the model has no effort levels rather than offering a picker.
- **choices**: what the pickers offer, per model, with `source` `live` or `fallback`. Always the app-wide list, even with `projectId` or `agentId`, because a write is checked against it. `default` isn't offered, since a preset has to name a model.
- **agent**: with `agentId` only. `{usable: true}`, or `{usable: false, reason}` with `dispatcher_locked` or `orchestration_off`, for presets. The Dispatcher doesn't start helpers, and this gives it no new authority.
- **auto**: whether `cli: "auto"` is allowed at the scope asked about. See [Auto provider](#auto-provider).

The built-in presets are starting choices, not measured best ones. Don't present them as a recommendation.

### Quota

Each provider's `quota` is what its CLI says about its plan limits. Read token-free, with no prompt, only when this route or Settings asks. It is the same whatever `projectId` or `agentId` says. Fixtures: `helper-routing-quota.json`.

| `state` | Meaning |
|---|---|
| `known` | Under 80% used |
| `low` | 80% up to 95% used |
| `near_limit` | 95% or more used, and the provider hasn't said the limit is reached. Quota remains. Don't word this as exhausted. |
| `exhausted` | The provider itself reported the limit reached. Used percent alone never produces this, even at 100%. |
| `unknown` | No current reading. `unknownReason`: `not_read` (a read is going, or hasn't run), `stale` (over 15 minutes old, keeping its `asOf`), `not_applicable` (this login has no plan limit, such as an API key), `read_failed`, `not_supported` (this provider doesn't report it) |

The thresholds are starting proposals, not measured values. `known` means under our threshold, not that capacity is guaranteed. `unknown` is never available capacity: use `labels.quota` and `labels.unknown`, and don't treat it as healthy in the UI.

- **limitingWindow**: the most constrained readable window, `weekly`, `fiveHour` or `other`, which sets `state`. `resetsAt` is that window's. A limit the provider reports reached wins over a fuller window. Words are in `labels.window`, and an unknown value uses `labels.generic.unknownCode`.
- **`other`** means the provider reported a limit of another length. It has no percent or name of its own on purpose: there's no window field for it, and a raw duration isn't worth showing. Show `labels.window.other` with `state` and `resetsAt`.
- **weekly**, **fiveHour**: `{usedPercent, resetsAt}`, or null when there is no such window, which is normal on some plans. A window that exists but can't be read has `usedPercent: null` and is named in `unreadableWindows`. The other one decides.
- **modelWindows**: limits for one model, `[{name, usedPercent, resetsAt}]`. They don't set `state`, because they only apply to that model. `name` is the provider's label for it, not a model id, so show it as it is.
- **source**: `cli_query`, `session_event` (a running chat session reported it) or `none`. Diagnostic only, with no labels: don't show it or branch on it. A terminal session reports nothing. The capability's `quotaSources` is for the same use.
- **asOf**, **serverTime**: ISO 8601 in UTC, such as `2027-01-15T08:00:00.000Z`. To show a reading's age, don't subtract from the phone's clock. Anchor when the response arrives: age is `serverTime - asOf`, plus the suspend-aware monotonic time elapsed since that response. `asOf` is when the reading was made, or the oldest that counted.

**Fetching again.** Nothing pushes quota, and `helperRoutingRevision` doesn't move for it. `refreshAfterSeconds` says how long a fetch returns the same reading for that provider. There's one GET for all of them, so while the page is open:

- Wait the smallest `refreshAfterSeconds` across providers, and at least 5 seconds. Reading another provider sooner than its own delay does no harm: it comes back cached.
- `0` means its next read is due or going. It waits the 5 second floor, so it can't make a client spin.
- A provider with no `refreshAfterSeconds`, such as `not_supported`, asks for nothing. With none at all, set no timer.
- Also fetch on returning to the foreground.

A read still going returns `not_read` after at most 3 seconds, with a short `refreshAfterSeconds`. A refresh still going returns the last reading, with `0`. Fetching can't cause extra CLI reads: they are shared and cached for 5 minutes per provider, with a minute's wait after a failure. `helper-routing-quota.json` has whole responses for these under `fullResponses`, with the delay each one gives.

### Auto provider

Lets an orchestrator's `cli: "auto"` pick between Claude Code and Codex for a helper, from helper counts and plan limits. It balances counts, not cost, and a helper stays on its provider for its whole task: a wake never decides again. Off unless a person turns it on. Fixtures: `helper-routing-auto.json`.

```json
"auto":{"effective":false,"source":"project","reason":"project_off",
 "scopes":{"app":{"value":true,"editable":true},
  "project":{"value":"off","choices":["off",null],"editable":true},
  "persona":{"value":null,"editable":false},
  "agent":{"value":null,"editable":true}}}
```

- **effective**: whether it would work now. **reason**, when it wouldn't, is one of `autoOffReasons`, with words in `labels.autoOff`. **source** is the level that decided: `agent`, `project`, `app`, `default` or `dispatcher_locked`, with words in `labels.autoSource`. `mcp_off` stays in `autoOffReasons` and the labels as a code only, for an older saved decision, and is never sent.
- **scopes**: each level's say, for the scope asked about: `app` always, `project` with `projectId` or `agentId`, and `persona` and `agent` with `agentId`. `persona` is always `{"value":null,"editable":false}`: personas were retired (#2901). For the Dispatcher nothing is `editable`.
- **The order:** `dispatcher_locked` is always off. Then a project's `off`, which can never be `on`. Then the agent's own, then the app's.
- **The agent's own:** `orchestration.autoHelpers` in `agent.update`, offered only when `modes` has `auto`. `true` or `false` sets it, at any time, also while the agent runs. `null` clears it, so the agent inherits the app's setting again. On a row or in settings, `orchestration.autoHelpers` is that switch, `true`, `false` or `null` while it inherits, and `orchestration.autoHelpersEffective` says whether Auto would work, with the app and the project included. Show the effective one. A non-boolean is 400 `invalid_orchestration`.

To change it, send `helperRouting.update` with `auto`: `true` or `false` at `scope: "app"`, or `"off"` or `null` at `scope: "project"` with `projectId` (404 `project_not_found`). A project scope takes nothing else. A project's `null` removes its override, and never turns Auto on: the levels below it decide. A stale write at project scope returns that project's fresh values.

A held start that names Auto has `requestedRouting.provider: "auto"`, and decides at approval. `helper.approve` then refuses with 409 `status:"rejected"`, code `no_candidate` or `auto_off`, as for `no_valid_mapping`: show `error.message`, offer no retry, and take the row from the snapshot.

**A provider looking unwell.** A start that names a CLI is never blocked by quota or a cooldown. It's only told, in `startWarning` on a held request, `warning` on `helper.approve`'s result, and `routing.warning` in a helper's settings, with `display.warning`:

```json
{"code":"quota_near_limit","asOf":"…","message":"codex-cli is close to its plan limit. The helper is started on it anyway, as asked."}
```

`code` is `quota_near_limit`, `quota_exhausted` or `cooling_down`. Show `message`, the server's words, and don't add a claim about capacity. It comes from what was already known and never asks a CLI, so there may be none where a limit hasn't been read yet. `asOf` is when it became known, on the same clock as `serverTime`. A held request's warning is from when it was asked. Approval decides again, so its result can differ or have none: show the result's. Don't block on any of them, and absent says nothing about capacity.

A helper Auto chose has this in its settings' `routing`, as of `decidedAt`, not live:

```json
{"mode":"auto","balanced":true,"reason":"lower_load","fallback":"candidate_skipped","quotaBasis":"known",
 "requested":{"provider":"auto","model":null,"effort":null,"difficulty":"hard"},
 "resolved":{"provider":"codex-cli","model":"gpt-6.1-sol","effort":"high","difficulty":"hard"},
 "source":{"provider":"auto","model":"builtin_mapping","effort":"builtin_mapping"},
 "load":{"claude-code":2,"codex-cli":0},
 "quota":{"claude-code":{"state":"known","asOf":"…","limitingWindow":"weekly"},"codex-cli":{"state":"unknown","unknownReason":"not_applicable","asOf":"…"}},
 "skipped":{"copilot-cli":"auto_not_supported"}}
```

- **balanced** is true only when Auto chose among providers. `persona_pinned` (a persona's pin decided, with `mode: "auto"` and `balanced: false`) only appears on a decision saved before personas were retired (#2901).
- **quotaBasis**: diagnostic only, with no labels: don't show it. `unknown_fallback` means the chosen provider's quota was unknown, and it was used only because every measured provider was close to its limit. `unknown_scored_as_healthy` is the same on an older decision, from a policy that scored unknown as known. Show `quota[provider].state` instead, which stays `unknown`. Never word it as healthy or available.
- **skipped**: why a provider wasn't considered, with words in `labels.skipped`.

The snapshot's row has the same codes as any helper: `routing:{mode:"auto",difficulty,provider,model,effort,reason}`.

### helperRouting.update

`{revision, scope, projectId?, cells?: [{provider, difficulty, model, effort}], reset?: {provider?, difficulty?}, auto?}`, with at least one of `cells`, `reset` and `auto`. `cells` and `reset` are for `scope: "app"`. `effort` null leaves the level to the CLI. `difficulty` takes any entry in `levels`, so `minimum` and `maximum` too. `reset: {}` resets everything, `{provider}` one provider, and `{provider, difficulty}` one cell. A reset runs before `cells`. The result is the page's data, so don't refetch.

- 409 `helper_routing_stale`: another edit got there first. Nothing was written, and the refusal's body has `revision` and `settings` with fresh values. Show them and let the person make the change again. Never retry on your own, because that could overwrite someone's edit.
- 409 `model_unavailable`, `effort_unavailable`: a live list doesn't offer it. `message` says what it does offer. Nothing was written.
- 400 `invalid_helper_routing`: a provider with no presets, a bad value, `default` as a model, an unknown scope, or anything but `auto: "off"|null` at project scope.

A value missing from a fallback list is accepted, and shows as `unverified`.

### Staying current

The snapshot's `helperRoutingRevision` and the `helper_routing:changed` event (`{revision}`) tell an open or cached page to refetch. The revision is opaque. It moves when a saved value changes, when an app-wide read finds a cell's state changed, or when something that decides Auto changes anywhere: a project's `off`, including from the desktop, or an orchestrator's switch. A list changing never makes your write stale: only a saved value does.

### A helper's routing

What the start decided, on a helper whose start named a CLI, model, effort or difficulty. Absent otherwise, and on helpers started before this. It goes if the helper's model or CLI is changed later.

The snapshot's agent row has codes only: `routing:{mode,difficulty,provider,model,effort,reason}`. Its settings have the whole record, and `display` with the words:

```json
"routing":{"mode":"preset","balanced":false,"decidedAt":"…","policyVersion":1,
 "requested":{"provider":null,"model":null,"effort":null,"difficulty":"hard"},
 "resolved":{"provider":"codex-cli","model":"gpt-6.1-sol","effort":"high","difficulty":"hard"},
 "source":{"provider":"orchestrator","model":"builtin_mapping","effort":"builtin_mapping"},
 "reason":"preset_on_cli","fallback":"none","context":{"status":"none"},
 "display":{"summary":"gpt-6.1-sol, high effort. From the helper settings for this difficulty.","reason":"From the helper settings for this difficulty"}}
```

`context.status` is `none`, `applied`, `reset` or `not_applied`. It has no words of its own. Show the [context notices](#context-choice) you already show, and don't add a second warning.

A held start's helper request has `requestedRouting:{provider,model,effort,difficulty}`, when it named any of them, and nothing resolved. The choice is made at approval.

## Dispatcher

The app-wide Dispatcher (#2533): one durable agent that coordinates the orchestrators in every project. It lives in its own folder under the Clubhouse base dir, which is no git repo, and is in no project, so it never appears in `projects`, `agents{}`, `GET /api/v1/projects` or `GET /api/v1/projects/:id/agents`. It is on by default in the new layout, unless the switch in Settings > Dispatcher is saved off. In the classic layout it is on only if that switch was saved on. The Clubhouse MCP always runs, so it never turns the Dispatcher off. Gated on `dispatcher.version >= 1` in capabilities:

```json
"dispatcher":{"version":1,"enabled":false,"flagOn":true,"newLayout":true,"projectId":"__dispatcher__",
 "snapshotField":"dispatcher","event":"dispatcher:changed","commands":["dispatcher.setEnabled","dispatcher.update","dispatcher.setModels","dispatcher.clearChat","dispatcher.forgetEverything"],
 "settings":{"version":1,"path":"/api/v1/mobile/dispatcher/settings"}}
```

- **enabled**: it is on now.
- **flagOn**: always `true`. It was `false` while Clubhouse MCP was off at app level, which can no longer happen. The experimental flag it once reported is gone.
- **newLayout**: the desktop runs the New layout this session. The Dispatcher's view is in the new layout only, so turning it on needs it; one that is still on can always be turned off.
- **settings**: present when the desktop has the [Dispatcher settings](#dispatcher-settings) route and its four commands, which `commands` also lists. Gate them on `settings.version >= 1`.

### Snapshot

The snapshot's `dispatcher` is `null` while the Dispatcher is off (or was never created). While it is on:

```json
"dispatcher":{"enabled":true,"flagOn":true,"projectId":"__dispatcher__",
 "agent":{"id":"durable_dispatcher","projectId":"__dispatcher__","name":"Dispatcher","kind":"durable","isDispatcher":true,"color":"indigo",
  "emoji":null,"branch":null,"model":null,"orchestrator":"claude-code","freeAgentMode":true,"access":"full_access","icon":null,"status":"sleeping",
  "detailedStatus":null,"executionMode":null,"hasSession":true,"lastActivityAt":1800000000000}}
```

`agent` is the `agents[projectId][]` shape with `projectId: "__dispatcher__"` and `isDispatcher: true`, and no `orchestration` (its orchestration settings are locked). It is the Dispatcher you talk to (#3036). Since that change its `id` is a new one, and its conversation starts fresh: work on agents happens out of sight under the Dispatcher's name, and only this agent is ever listed. Its chat, agent routes and commands take this `id`, and a phone should not keep an older one. It is in `agentIcons` when it has an image icon and in `agentsMeta` while it runs. `GET /api/v1/mobile/agents/state` has a row for it (`projectId: "__dispatcher__"`, `isDispatcher: true`) while it is on.

### Live changes

`dispatcher:changed` is broadcast and buffered for `mobile:replay` whenever `enabled`, `flagOn` or the agent id change, from the desktop or a phone: `{"enabled":bool,"flagOn":bool,"agentId":"id"|null}` (`agentId` is null while it is off). A fresh `snapshot` follows it, and also follows any change to its config (its CLI or model changed on the desktop). Add or drop the Dispatcher from that snapshot.

### While it is off

Optional fields on the snapshot's `dispatcher`, `dispatcher:changed` and the capabilities' `dispatcher`, present only while it is off, and the same in all three. A phone that doesn't know them keeps working: `enabled` is `false`, and `agentId` in `dispatcher:changed` is `null`, as ever. An older phone drops the Dispatcher then, so it may not show one still running. The desktop can stop it.

| Field | Meaning |
| --- | --- |
| `offReason` | `switched_off` (its switch is off) or `classic_layout` (the classic layout with nothing saved on). Saved on with the classic layout is on. `mcp_off` is no longer sent. Tolerate other values. |
| `running` | Whether its session is running. |
| `status` | The same as `agent.status`, which for a desktop agent is `running` or `sleeping`. |
| `detail` | Plain text to show. `Turned off` or `Needs the new layout`. |
| `commandsWhileOff` | What is accepted for its id now. |
| `agent` | The record, in the same shape as `agents[projectId][]`, or `null` before it was first created. The snapshot's `dispatcher` keeps it while it is off, so history isn't lost. |

| State | `commandsWhileOff` | Reads | Anything else |
| --- | --- | --- | --- |
| `switched_off` | `dispatcher.setEnabled` | 404 `agent_not_found`, as ever | 409 `dispatcher_off`, as ever |
| `classic_layout` | `dispatcher.setEnabled` | 404 `agent_not_found`, as ever | 409 `dispatcher_off`, as ever |

- `dispatcher.setEnabled` with `enabled: false` always works. With `true` it answers as under [dispatcher.setEnabled](#dispatchersetenabled).
- A shell in its folder is only for while it is on.
- The `mcp_off` states are gone: the Clubhouse MCP always runs.

Fixtures: `dispatcher-off-states.json` and `dispatcher-off-routes.json` for every state. Fixtures from before these fields show the older shape: they are what a phone that doesn't know the fields reads.

### dispatcher.setEnabled

`{type:"dispatcher.setEnabled", enabled:bool}` is Settings > Dispatcher's switch. Result `{enabled, flagOn, agentId}`, as `dispatcher:changed`. Turning it off stops the agent and keeps its folder, notes and config, so turning it on again carries on. Refusals (409): `dispatcher_layout_off` (turning it on while the desktop runs the classic layout, unless its switch is already saved on). Turning on one that is on, or off one that is off, succeeds with the current state.

### Its agent

While it is on, its id works wherever an agent id does: the chat snapshot, chat history pages, `/chat/sessions`, `/content`, attachments, `/settings`, every `chat.*` command, `agent.start`, `agent.stop`, `agent.update`, `pty:attach`, and `GET /api/v1/agents/:id/sessions…` with `projectId=__dispatcher__`. While it is off and stopped, GET routes answer 404 `agent_not_found` and commands 409 `dispatcher_off`.

See [While it is off](#while-it-is-off) for what changes while it is off.

- **Shells.** `pty:spawn-shell` with `projectId: "__dispatcher__"` (with or without its `agentId`) opens a shell in its folder while it is on; otherwise `project_not_found`.
- **No git.** Git routes for `__dispatcher__` answer 409 `{"error":"not_git_repo"}`. Its settings' `details.changes`, `branch` and `worktree` are null.
- **No project.** `agent.create`, `agent.spawn`, `project.*` and `quick.*` with `projectId: "__dispatcher__"` are 409 `dispatcher_locked`.
- **Settings.** `GET /mobile/agents/:id/settings` has `isDispatcher: true`, `orchestration: null` and `notHonored`, the settings to hide ([Dispatcher settings](#dispatcher-settings)). `orchestrator`, `model`, `runtime`, `freeAgentMode` and `access` are `editable: "always"` (as on Settings > Dispatcher they apply the next time it starts), `idleSleep` `"always"`, and `name`, `color`, `emoji`, `persona` and `clubhouseMode` `"never"`.
- **agent.update.** Only `orchestrator`, `model`, `runtime`, `freeAgentMode`, `access`, `idleSleep` and `contextWindow`, at any time. A new `orchestrator` resets `model` to `default` unless the command sets one; `model` must be `default` or one the CLI lists (400 `invalid_model`). `name`, `color`, `emoji`, `persona`, `clubhouseMode` or `orchestration` are 409 `dispatcher_locked`, the desktop's own rules.

The Dispatcher can change its own color, emoji and image through the `update_agent` MCP tool, and the `clubhouse` CLI can change them too (#2645). A phone can't: `agent.update` stays `dispatcher_locked` for them. A fresh `snapshot` carries the new look. Its name stays "Dispatcher", whichever look it has. Messages it sends name it as the sender like any agent; find it in `dispatcher.agent`, not `agents`.

Messages other agents send the Dispatcher arrive as `user_message` with `source: "mcp"` and [`routed`](#live-events-and-replay) naming the sender, as for any agent. `content` is what the Dispatcher received, with a `[FROM:<name>@<project>]` tag in the text, and that tag is all older transcripts have.

**Its chat is a group chat (#3043).** Live, on replay, in history pages and from `/chat/events/{seq}`, its chat comes as the desktop draws it: the same shapes, without tool calls, thoughts, plan documents, subagent work, Clubhouse updates or its own hand-offs, and with task ids, routing tags and JSON cleaned out of `routed` and the final `agent_message`. State events (turns, the session, the queue, approvals, questions) all still come, so `seq` can skip; `lastSeq` counts every event. Every other agent's chat comes whole.

### Dispatcher settings

Settings > Dispatcher from a phone (#3206): Behavior, Choose models yourself (#3191), name, look and personality, today's usage, and its two resets. Gated on `dispatcher.settings.version >= 1`. Everything here works only while it is on.

`GET /api/v1/mobile/dispatcher/settings` answers 404 `{"error":"dispatcher_off"}` while it is off or not created yet. While it is on:

```json
{"version":1,"epoch":"uuid","agentId":"durable_dispatcher",
 "behavior":{"value":"standard","editable":"always","applies":"now","setsModels":true,"auto":{"ready":true},"note":null,
  "choices":[{"id":"light","label":"Light","description":"…"},{"id":"standard","label":"Standard","description":"…"},{"id":"thorough","label":"Thorough","description":"…"}]},
 "models":{"byHand":false,"editable":"always","note":"…",
  "applies":{"provider":"next_start","model":"now_or_next_start","effort":"now_or_next_start","contextWindow":"next_start"},
  "roles":[{"id":"chat","label":"Talking with you","help":"…","pick":null},{"id":"work","label":"Working in the background","help":"…","pick":null}]},
 "identity":{"name":{"value":"Dispatcher","editable":"always","maxLength":40},"color":{"value":"indigo","editable":"always"},"emoji":{"value":null,"editable":"always"},"hasImageIcon":false},
 "personality":{"value":{"preset":"concise","text":"…"},"editable":"always","applies":"next_start","maxLength":2000,
  "presets":[{"id":"friendly","label":"Friendly","description":"Warm and upbeat","text":"…"},{"id":"custom","label":"Custom","description":"Write your own","text":null}]},
 "usage":{"day":"2027-01-15","conversations":{"turns":4,"turnsWithoutUsage":0,"input":182000,"cachedInput":120000,"cacheWrite":9000,"output":6400,"reasoning":0,"costUsd":0.42,"costIsEstimate":true},"background":{…}},
 "notHonored":[{"setting":"model","reason":"behavior"},{"setting":"contextWindow","reason":"behavior"},{"setting":"runtime","reason":"not_offered"},{"setting":"freeAgentMode","reason":"not_offered"},{"setting":"access","reason":"not_offered"}],
 "clearChat":{"expectedState":"opaque","applies":"next_start"},
 "forgetEverything":{"expectedState":"opaque"}}
```

Draw `label`, `description`, `help` and `note` as sent; they are the desktop's words.

- **behavior**: the level, saved at once (`applies: "now"`). The models it gives switch a running chat where the CLI allows, otherwise at the next start. `setsModels` is false while the models are chosen by hand: then Behavior only sets how often it checks in, and each choice's `description` says only that. `auto` is `{ready:true}` or `{ready:false, code:"auto_not_supported"|"no_valid_mapping"}`, and `note` is the line to show under the field, or null.
- **models**: Choose models yourself. `byHand` is the switch. Each role is one row of Settings > Dispatcher, with `pick` `{provider, model, effort, contextWindow}` (each `default` or null meaning the CLI's own), or null before the switch was first turned on. Picks are kept while the switch is off, so turning it on again restores them. `applies` says when a change to each field takes effect. Model and effort lists come from the [create options](#create-options) `orchestrators`.
- **identity**: its name (at most `maxLength`, one line), color (a [create options](#create-options) `colors` id), emoji, and whether it has an image icon, which a phone can't set. Setting an emoji replaces an image.
- **personality**: what it's told about how to sound. A preset fills the text; the text is always what it's told. `applies: "next_start"`: its chat reads it when a session starts.
- **usage**: today's split, the same numbers as Settings > Dispatcher. `conversations` are your chats with it and the work you hand it; `background` is the check-ins and memory upkeep it runs on its own. Token figures add up what the provider reported, and a turn that reported nothing counts in `turnsWithoutUsage` instead. The desktop's labels are "Conversations today" and "Background work today", with "None yet" for no turns.
- **notHonored**: its raw agent settings ([Its agent](#its-agent)) that Settings > Dispatcher no longer offers, so hide those rows. The same list is on `GET /mobile/agents/:id/settings` as `notHonored`. `reason` is `behavior` (Behavior gives it before each start, so a saved change doesn't last) or `not_offered` (it stays as it is). It depends on `models.byHand`: off, `model` and `contextWindow` are listed; on, they aren't, since `orchestrator`, `model` and `contextWindow` in `agent.update` save the pick for talking with you. `runtime`, `freeAgentMode` and `access` are always listed. `agent.update` still takes all of them, for older phones. Tolerate settings and reasons you don't know.
- **clearChat**, **forgetEverything**: the confirmations ([Confirmations](#confirmations)). `clearChat.applies` is `now` when its chat is running (it starts a new conversation at once) and `next_start` when it sleeps. `expectedState` is null for a client without the pinned certificate, which can't send commands.

Every command below refuses with 409 `dispatcher_off` while it is off. Their results are the settings payload without `version` and `epoch`, except the two resets. A fresh `snapshot` follows a change to its name or look.

**`dispatcher.update`** `{behavior?, name?, color?, emoji?, personality?}`, at least one. Everything is checked before anything is written.

- **behavior**: `light`, `standard` or `thorough` (400 `invalid_behavior`).
- **name**: one line; control characters become spaces, and it is trimmed and capped at `maxLength`. Nothing left is 400 `invalid_name`.
- **color**: a `colors` id (400 `invalid_color`). **emoji**: up to 16 UTF-16 units, or null to clear it.
- **personality**: `{preset?, text?}`, at least one. `preset` alone fills that preset's text (Custom keeps the current text). `text` alone becomes Custom unless it is exactly a preset's text. Both saves both. Empty text reads as Concise, as on the desktop. An unknown preset, or text over `maxLength`, is 400 `invalid_personality`.

**`dispatcher.setModels`** `{byHand: bool}`, or `{role: "chat"|"work", provider?, model?, effort?, contextWindow?}` with `effort` and `contextWindow` null for the CLI's default. Not both at once. A malformed change is 400 `invalid_models` with the reason. A change the desktop refuses (the switch is off, a provider Clubhouse doesn't know, a model the CLI doesn't list, a context its model doesn't offer) is 409 `models_refused` with its sentence, and nothing is kept. Turning it on seeds each pick from what it runs now; turning it off puts Behavior back in charge of the models.

#### Confirmations

Clear chat and Forget everything each need explicit confirmation, the precondition pattern `agent.providerChange` uses. The phone reads the settings route, asks the person, and sends the `expectedState` it got for that action. Treat it as opaque. It is bound to this phone and this action, and to what the question showed: Clear chat's to the conversation it would end and whether the chat is running; Forget everything's to the memory it would clear. A token for one never confirms the other.

A token that doesn't match now is 409 `stale_state` (message: "This changed since you were asked. Check again and confirm.") and nothing happens. Read the route again and ask again. A token works once: after the action, a new command with it is `stale_state`, while an identical retry with the same commandId gets the receipt. Tokens don't survive a desktop restart.

**`dispatcher.clearChat`** `{expectedState}`: its conversation starts over, as Clear chat in its menu does. Its memory, its agents and their connections, Actions and news waiting for the next check-in all stay. Result `{cleared:"now"|"next_start"}`. A clear that fails is 409 `clear_failed` (outcome `failed`) with the reason. Desktop words: "Clear chat?" and "The conversation starts over. <name> still remembers what you decided and who is doing what, and your agents, connections and Actions stay as they are."

**`dispatcher.forgetEverything`** `{expectedState}`: its memory goes and starts over empty, as Settings > Dispatcher's Forget everything does. This can't be undone. Its chat, agents, connections and Actions stay. Result `{removed, heldNews}`: folders removed, and news held for the next check-in that was dropped. Desktop words: "Forget everything?" and "<name> forgets its notes on your agents and your work, its timeline, and news waiting for the next check-in. This can’t be undone. Your agents, connections, Actions and its chat stay."

Fixtures: `dispatcher-settings.json` (the route off, on, and with the models chosen by hand, with `notHonored` from the agent settings in both modes), and `commands/dispatcher.update.json`, `dispatcher.setModels.json`, `dispatcher.clearChat.json` and `dispatcher.forgetEverything.json` with every refusal.

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

A paired phone is a full controller (maintainer decision, #2476), so it can open the same terminals as the desktop's Terminal tab: a shell at a project root or at an agent's worktree. It can also view and type into a terminal-mode agent's own PTY. Everything here is WebSocket-only, so it always runs on a pinned mTLS connection.

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

- `pty:attach {agentId}` → `pty:attach:ack {agentId, buffer, outputSeq, cols?, rows?}`. `buffer` is the agent's current screen and scrollback, serialized as terminal output. `cols`/`rows` is the PTY's size, when known. A frame is at most 8 MiB, so a large buffer drops old scrollback: `scrollbackLines` then says how many lines it kept, and the screen and cursor are whole. Raw output with no mirror is rebuilt through a terminal first. Its resynchronized start carries checkpointed bracketed paste and application cursor modes, but other earlier modes are not reconstructed. A command cut by the shortening is skipped to its end, so a mode it sets is still carried; see [the replay limits](terminal-input-mode-replay.md). If even the screen is over the limit there's no ack: you get an `error` with `terminal_unavailable`, the agent keeps running, and you can try again. `GET /api/v1/agents/:id/buffer` has the same limit: `x-clubhouse-scrollback-lines` says how many lines it kept, and it answers 503 `{"error":"terminal_unavailable"}` in that last case.
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
| `terminal_unavailable` | `pty:attach` | The terminal's state is too large to send, even the screen alone. The agent keeps running. Don't retry automatically. |

## Contract fixtures

`test/fixtures/annex-mobile/` holds a canonical example of every message in this document: capabilities, icon refs and their routes, a snapshot over its limit and the canvas routes, frames over the limit, large tool output, the WebSocket snapshot (agents, quick agents, `projectState`, `finishedQuickAgents`, `helperRequests`, theme), the chat snapshot with `chatControls`, `slashCommands` and `contentRoots`, create options and agent settings, a request and receipt for every `MOBILE_COMMAND_TYPES` command with each refusal its code path can reach, one `chat:event` of every chat event type followed by `user_message` with each form of `routed` (one sender, a burst, `fromClubhouse`, no `sender`), every kind of sender and how to draw it, queued bursts, every `pty:*` message and error, `mobile:replay`, the attachment upload's answers, and the [oversized command](#oversized-commands) refusal in `command-too-large.json`, with its exact response bytes. The phone (Clubhouse Go) vendors these files and decodes each one in its contract tests, and checks that the commands it builds match the requests here. Neither side tests only against its own fakes.

`src/main/services/annex-mobile-contract.test.ts` writes them. It runs the real annex-server, mobile-control, mobile-agents, mobile-helper-requests, mobile-attachments and chat echo code over pinned mTLS and the WebSocket handler. Only the leaves are faked (disk, git, CLIs, PTYs, the orchestrator side of helper requests). The output is deterministic: fixed ids and clock, sorted keys, and random UUIDs (epochs, tokens, attachment and helper request ids) renumbered `00000000-0000-4000-8000-<n>` in order of first appearance.

- `npm run fixtures:annex-mobile` rewrites the files. Commit them with the change that caused them.
- `npm run fixtures:annex-mobile -- --check` (and the suite itself, in `npm test`) fails when a file is stale or extra.
- A changed fixture is a protocol change: keep it additive, update this document, and tell the phone side.
- A new command type or chat event type fails the suite until it has an example.

A helper is `durable_docs` in `snapshot.json` and `agent-settings-helper.json`; the other agents there are top-level.

`sender-identity.json` is for [Who sent a message](#who-sent-a-message). `catalog` is the snapshot's agent rows and `agentIcons`, `frames` are the live `chat:event`s, and `expected` is, for each event, what the desktop's code draws given only `catalog` and that event: `{from:"you", text}` or `{from:"others", parts:[{name, agentId, text, avatar}]}`, where `agentId` is the row it found or null. `avatar` is null, `{type:"quick"}`, `{type:"emoji", emoji, background}`, `{type:"image", image}` or `{type:"initials", initials, background}`, with `background` a CSS hex color. `history` and `replay` carry the same messages through the chat route and `mobile:replay`. `colors` (with `initialsText`, the [text color](#initials-text-color) for each) and `initials` are the tables to check against. `queued-bursts.json` is for [Queued messages](#queued-messages): events from the real chat runtime for a burst, the same burst missing its first event, a failed send, a provider-held queue and a system turn over a held row, with `rowId` and the combined `routed` to expect.

The Dispatcher has its own files: `snapshot-dispatcher.json` (the snapshot's `dispatcher` and its `agent-state` row while it is on), `dispatcher-changed.json` (the event), `agent-settings-dispatcher.json` `dispatcher-routes.json` (its chat and sessions while on, its GET routes while off, git, and a shell in its folder), `dispatcher-group-chat.json` (one conversation as the Dispatcher's group chat and as an ordinary agent's, history and live), and `dispatcher-settings.json` ([Dispatcher settings](#dispatcher-settings)).

`commands/<type>.json` lists `cases` of `{name, request, response:{status, body}}`; `name` is `accepted…` or the error code. `commands/_common.json` has the refusals any command can get (`invalid_command`, `unsupported_version`, `epoch_mismatch`, `command_conflict`, `client_certificate_required`, `command_capacity`) and an identical retry. Not covered: `authorization_revoked`, `start_cancelled` and the upload `quota_exceeded` / `authorization_revoked`, which need races or a day of uploads; `/content` previews and git routes.

## Guided Sleep and provider Save (draft additive contract)

Gate this flow on `providerControl.version: 1` and the advertised commands.
`agent.stop` accepts optional `waitForStopped: true`. Only its successful receipt
`{agentId, stopRequested: true, state: "sleeping", stopped: true}` acknowledges
both process exit and settled session capture. A failed stop or capture rejects;
`stopRequested` alone is not a stopped acknowledgment. Legacy stop is unchanged.

`agent.providerPreview` accepts `{agentId, provider}`. Its result contains:

| Field | Draft values and meaning |
| --- | --- |
| `savedProvider`, `provider` | Current saved provider and requested provider IDs |
| `activeProvider` | Running registry provider ID, or null |
| `state` | `running`, `stopping`, `starting`, `creating`, `sleeping` |
| `expectedState` | Opaque precondition bound to actor, target, configuration and lifecycle; never parse it |
| `available`, `availabilityMeaning` | Boolean and `local_cli_only`; not authentication or remaining quota |
| `instructions`, `instructionScope` | `equivalent`, `different`, `unverified`; scope `native_primary_only` |
| `targetRuntime` | `terminal` or `chat` |
| `blocked`, `canSave` | Refusal code or null, and whether Save is allowed |
| `historyRetained`, `contextTransferred` | true and false; existing recorded history is retained, context is not transferred |
| `nextStart` | `new_session` or `resume_requires_validation` |
| `settingsReset` | Empty for same provider; otherwise `model`, `effort`, `contextWindow`, `routing`, `resumePointer` |

Instruction inspection compares only the two native primary instruction files.
It does not establish equivalent global/nested instructions, skills, or effective
MCP composition. Missing files are empty; unreadable, linked or oversized files
block verification. Permission defaults that cannot be safely translated block
Save. Existing access, MCP and orchestration settings are preserved.

`agent.providerChange` accepts `{agentId, provider, expectedState}`. It never stops
or starts the agent. A stopped-state reservation, authorization recheck and fresh
preview are required before mutation. Success adds `status: "changed"` or
`"already_selected"`. A changed result omits `expectedState`, reports the new saved
provider, `activeProvider: null`, `state: "sleeping"`, and `nextStart: "new_session"`.
Refresh after Save. Start is a separate explicit user action.

Refusals use the existing receipt, e.g. HTTP 409:
`{version:1,commandId,epoch,status:"rejected",error:{code:"stale_state",message:"stale_state"}}`.
Codes include `agent_running`, `agent_stopping`, `agent_starting`, `agent_creating`,
`orchestrator_unavailable`, `incompatible_permissions`, `incompatible_runtime`,
`instructions_not_equivalent`, `session_capture_failed`, `agent_transition_busy`,
`stale_state`, `resume_unverified`, and `resume_failed`. Authorization and argument
validation retain their existing statuses. Clients must handle unknown refusal codes.
A capture failure conservatively blocks guided Save/resume for the current desktop
process; later best-effort capture does not erase evidence of a lost history write.

Retry identical commands with the existing commandId and epoch for receipt replay.
A new commandId with an old pre-change token rejects as stale. A fresh preview of
the already selected provider can return `already_selected` without mutation.
No extra command-id field is introduced.

`agent.start` accepts opt-in `expectedProvider` and, with `resume: true`,
`expectedSessionId`. It checks the saved provider and provider-tagged history;
strict resume never falls back to a fresh session. Native chat resume must honor
the exact requested native ID. Terminal strict resume is conservatively refused
in this slice; legacy start remains compatible. Switching back does not promise
resumption of the previous provider's session. A fresh start is explicit. The initial guided phone UI offers **Start new only**;
Resume is unavailable. This slice exposes no validated provider-tagged resume
eligibility read. `resume_requires_validation`, including on a same-provider
preview, and `hasSession` must never enable Resume.

The paired phone retains its existing manual controller authority. Dispatcher MCP
`preview_provider` and `change_provider` use existing target control policy, not a
new grant: the caller must be an enabled, running Dispatcher with open MCP and a
current permitted wire to an opted-in durable orchestrator. User removals,
disabled tools, helper/self targets and denied control still block.
`hands-off` and `ask-before-start` allow saved provider changes; `ask-everything`
returns `control_requires_user` for manual settings. Wake remains separately gated.
Preview and commit resolve the same target policy, with revocation rechecks and
redacted audit records. These tools do not expose general model/settings control.
