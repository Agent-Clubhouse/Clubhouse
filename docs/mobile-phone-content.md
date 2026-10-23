# Additive phone workflow contract

Depends on mobile-control-v1 from PR2430 and the isolated integration support from PR2431. Existing Satellite/Annex routes and default binding/discovery are unchanged.

`GET /api/v1/mobile/capabilities` adds `richContent: {version:1, enabled:boolean, maximumBytes:8388608}`. Enabled mirrors the existing desktop experimental `richChatContent` flag.

`GET /api/v1/mobile/agents/:id/chat` adds `canStart:boolean`, true only for a known non-disposed durable that is neither running nor starting. Mobile uses it for explicit Wake and wake-with-message; commands retain their existing mTLS/idempotency semantics.

`GET /api/v1/mobile/agents/:id/content?mediaRef=<sha256.ext>` reads a stored image; alternatively `?path=<agent-relative-or-contained-path>` uses the existing desktop file-preview policy. Exactly one selector is required. All responses require the pinned mobile client certificate, a known agent and the experimental feature. Authorization is rechecked after IO. There is no remote URL fetch, shell/reveal action, custom root or bearer-only access. Errors return bounded `content_unavailable`/authorization responses without logging paths or bytes.

Response metadata follows desktop previews: kind, name, optional mimeType/text/truncated/tooLarge, and optional base64 binary. Binary is capped at8MiB to fit the existing16MiB mobile HTTP limit. Cache-Control is no-store. Existing path containment, symlink, regular-file, type and size policy is reused.

The opt-in process-local `CLUBHOUSE_ANNEX_BIND_ADDRESS` accepts only an existing non-loopback IPv4 interface address. It conflicts with LOOPBACK_ONLY, disables Bonjour and permits EPHEMERAL only with an isolated USER_DATA profile. No default setting is changed. Configuring source is not permission to start that listener; physical tests need specific approval. Normal existing desktop Bonjour publication remains available for an approved LAN test.
