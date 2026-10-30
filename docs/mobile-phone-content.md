# Additive phone workflow contract

Depends on mobile-control-v1 from PR2430 and the isolated integration support from PR2431. Existing Satellite/Annex routes and default binding/discovery are unchanged.

`GET /api/v1/mobile/capabilities` adds `richContent: {version:1, enabled:boolean, maximumBytes:8388608}`. Enabled mirrors the existing desktop experimental `richChatContent` flag.

`GET /api/v1/mobile/agents/:id/chat` adds `canStart:boolean`, true only for a known non-disposed durable that is neither running nor starting. Mobile uses it for explicit Wake and wake-with-message; commands retain their existing mTLS/idempotency semantics.

`GET /api/v1/mobile/agents/:id/content?mediaRef=<sha256.ext>` reads a stored image; alternatively `?path=<agent-relative-or-absolute-path>` uses the desktop file-preview policy. Exactly one selector is required. All responses require the pinned mobile client certificate, a known agent and the experimental feature. Authorization is rechecked after IO. There is no remote URL fetch, shell/reveal action, custom root or bearer-only access. Errors return bounded `content_unavailable`/authorization responses without logging paths or bytes.

### Absolute paths: `contentRoots` and `contentAnyPath`

The chat snapshot (`GET /api/v1/mobile/agents/:id/chat`) adds `contentRoots: string[]`, the agent's folders: its working folder or worktree first, then its project, its chat media folder and the live session's output folder (`agentFolders` in `chat-files.ts`). Relative paths resolve against the first. The list is empty while rich content is off, or when the folders can't be found. Older desktops omit the field: offer relative paths only.

Since #2478 the snapshot also carries `contentAnyPath: boolean`, true while rich content is on. The desktop then serves any absolute path that resolves to a regular file the desktop user can read, wherever it is, as desktop file chips do: an agent with a terminal could copy the file into its project anyway, so a folder allowlist only added friction. A phone that sees `contentAnyPath: true` may offer a link for any absolute path. Without it (older desktops), offer absolute paths only when they equal a root or start with a root plus the host's path separator (compare whole path segments, so `/a/proj` does not cover `/a/project`). Roots are host paths: on a Windows desktop (`ptyHost.platform` is `win32`) they use drive letters and backslashes, and match case-insensitively.

Either way the desktop resolves every requested path, symlinks included, and refuses what it can't serve (missing, not a regular file, network and device paths), so a link can still come back `content_unavailable`.

We chose roots in the snapshot over marking servable paths in each `tool_call` event. Marking paths would mean finding and stat-ing paths in every tool event on the event path, and older events in history would carry no marks.

Response metadata follows desktop previews: kind (`text`, `image`, `video`, `audio`, `pdf` or `other`; `pdf` since #2478, detected by its `%PDF-` header, with `mimeType` `application/pdf`), name, optional mimeType/text/truncated/tooLarge, and optional base64 binary. Binary is capped at8MiB to fit the existing16MiB mobile HTTP limit. Cache-Control is no-store. The desktop's symlink, regular-file, type and size policy is reused.

The opt-in process-local `CLUBHOUSE_ANNEX_BIND_ADDRESS` accepts only an existing non-loopback IPv4 interface address. It conflicts with LOOPBACK_ONLY, disables Bonjour and permits EPHEMERAL only with an isolated USER_DATA profile. No default setting is changed. Configuring source is not permission to start that listener; physical tests need specific approval. Normal existing desktop Bonjour publication remains available for an approved LAN test.

## User images in chat (#2453)

Images in a `user_message` (sent from the phone through [image attachments](mobile-control-v1.md#image-attachments), or from the desktop composer) reach Annex clients as `{type:"image", mimeType, mediaRef?, width?, height?, path?}`, both in live `chat:event` frames and in `/chat` snapshots. Annex never sends a desktop path or inline base64 in `user_message`: `path` is cut to the bare file name, `data` and `data:` URIs are dropped, and file blocks keep only their name (`{type:"file", path:"notes.txt"}`).

`mediaRef` points at a copy the desktop stores in the agent's media folder when the message is sent, whatever the `richChatContent` setting. Reading it uses the same `GET /api/v1/mobile/agents/:id/content?mediaRef=` as tool images, so **it follows the `richContent.enabled` gate**: with the experimental setting off, `/content` refuses and the phone shows its own local copy (it has the bytes it uploaded) or a placeholder. Turning the setting on later makes earlier images readable, because the copy was stored anyway. Messages sent before this change, and images whose copy couldn't be stored, have no `mediaRef`: show a placeholder with the name.
