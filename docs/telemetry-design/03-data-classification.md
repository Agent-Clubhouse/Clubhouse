# Telemetry Plugin — Data Classification & Privacy

## Namespace Tiers

Every log namespace is classified into one of three tiers. Unknown/new namespaces default to **DROP**.

### Tier 1 — Safe to Send (errors + health signals)

These namespaces contain no user-specific data in their messages or meta:

- `core:process` — uncaught exceptions, unhandled rejections
- `core:startup` — app version, platform, startup timing
- `core:shutdown` — clean vs dirty shutdown
- `core:safe-mode` — crash loop detection, safe mode activation
- `update:check` — update availability checks
- `update:download` — update download lifecycle
- `update:apply` — update application
- `update:apply-on-quit` — silent update on quit
- `update:session-resume` — session restore success/failure
- `marketplace` — plugin install/uninstall events (not names/URLs)

### Tier 2 — Safe with Field Stripping

These namespaces are useful for feature adoption metrics but their meta contains sensitive fields:

- `core:agent` — agent spawn/kill events (strip: agentId, model, projectPath, binary, args)
- `core:mcp` — MCP bridge lifecycle (strip: tool names, binding details)
- `core:structured` — structured mode lifecycle (strip: session details)
- `core:headless` — headless agent lifecycle (strip: mission, PID)
- `core:hook-server` — hook server health
- `core:annex` — annex server start/stop (strip: peer fingerprints, IPs)

### Tier 3 — Never Send

These namespaces inherently contain project/user data:

`core:file`, `core:security`, `core:materialization`, `core:agent-config`, `core:config-pipeline`, `core:project`, `core:ipc`, `core:git`, `core:companion`, `core:annex-client`, `core:annex-server`, `core:agent-queue`, `core:group-project`, `core:plugin-storage`, `core:config-diff`, `core:agent-settings`, `core:orchestrator`, `core:project-store`, `core:window`, all `plugin:*`, `marketplace:custom`, `marketplace:updates`

---

## Meta Field Allowlist

The `meta` field is `Record<string, unknown>` — a completely open bag and the primary privacy risk.

**Strategy:** Static map of `namespace -> allowed meta keys`. Everything else stripped.

```
Namespace           Allowed Keys                    Stripped Keys (examples)
─────────────────   ─────────────────────────────   ──────────────────────────────
core:process        [nodeVersion]                   stack, message (may contain paths)
core:startup        [version, platform, arch]       everything else
core:shutdown       []                              everything
core:safe-mode      [attempt]                       lastEnabledPlugins
core:agent          [kind]                          agentId, model, projectPath, binary, args, cwd
core:mcp            []                              all meta
core:structured     []                              all meta
core:headless       []                              all meta
update:check        [currentVersion, latestVersion] sourceUrl, downloadPath
update:download     []                              everything
update:apply        [platform]                      version, path
```

---

## Message Sanitization

| Tier | Strategy |
|------|----------|
| Tier 1 | Send msg truncated to 200 chars |
| Tier 2 | Replace msg with canonical event ID (e.g., `agent:spawn`, `mcp:bridge-start`) |

### Path Detection Safety Net

A regex runs on ALL string values (msg + meta) regardless of allowlist:

```
/(?:\/[\w.-]+){2,}|[A-Z]:\\[\w.-\\]+/g  -->  <path>
```

This catches cases where an "allowed" meta key accidentally contains a filesystem path.

### Error Type Extraction

For `core:process` errors (uncaught exceptions), only the error class name is kept:
- `TypeError: Cannot read properties of undefined` → `TypeError`
- `Error: ENOENT: no such file or directory, open '/Users/...'` → `Error`

The message and stack trace are always stripped.

---

## Session Anonymization

- **Session ID:** Random UUID v4, generated at app start, not persisted across sessions
- **No machine ID.** No user ID. Events cannot be correlated across sessions.
- **Included:** appVersion, platform (darwin/win32/linux), arch (x64/arm64)
- **Future option:** If cross-session correlation is needed later, store a random install ID in plugin storage with a UI button to regenerate it at any time

---

## What Gets Collected

### Errors

| Event | Source Namespace | Fields | Purpose |
|-------|-----------------|--------|---------|
| `error/uncaught` | `core:process` | errorType, level | Crash-causing error types |
| `error/unhandled-rejection` | `core:process` | errorType, level | Async error types |
| `error/update-failed` | `update:*` | phase, platform | Update failure tracking |
| `error/safe-mode-triggered` | `core:safe-mode` | attempt | Crash loop frequency |
| `error/mcp-bridge-failed` | `core:mcp` | (none) | MCP reliability |

### Feature Usage

| Event | Source | Fields | Purpose |
|-------|--------|--------|---------|
| `usage/agent-spawned` | `core:agent` | kind, isStructured | Agent type adoption |
| `usage/agent-killed` | `core:agent` | (none) | Session length proxy |
| `usage/structured-session` | `core:structured` | (none) | Structured mode adoption |
| `usage/mcp-binding-created` | `core:mcp` | (none) | MCP adoption |
| `usage/plugin-installed` | `marketplace` | (none) | Marketplace engagement |
| `usage/headless-spawned` | `core:headless` | (none) | Headless mode adoption |

### Session Health

| Event | Source | Fields | Purpose |
|-------|--------|--------|---------|
| `health/session-start` | `core:startup` | appVersion, platform, arch | Version distribution |
| `health/session-end` | `core:shutdown` | uptimeSeconds | Session duration |
| `health/update-check` | `update:check` | currentVersion, latestVersion | Update staleness |
| `health/resume-success` | `update:session-resume` | (none) | Resume reliability |
| `health/resume-failed` | `update:session-resume` | (none) | Resume failure rate |

---

## What is NEVER Collected (explicit exclusions)

- Chat content, messages, mission text, prompts
- File paths, file names, file contents
- Agent names, project names, project paths
- Git data (branches, commits, diffs)
- MCP tool names, tool arguments, tool results
- Plugin IDs, plugin names, custom marketplace URLs
- Error stack traces, error messages (only error type names)
- IP addresses, peer fingerprints, Annex identity data
- Model names, orchestrator-specific configuration
