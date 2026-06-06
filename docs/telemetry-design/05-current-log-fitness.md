# Telemetry Plugin — Current Log Fitness Assessment

## What Works Well

### Structured Format
- JSONL with consistent `{ts, ns, level, msg, meta}` schema
- Machine-parseable, easy to classify and filter
- One entry per line, no multiline parsing needed

### Namespace Granularity
- 47+ distinct namespaces (e.g., `core:agent`, `core:mcp`, `update:check`)
- Allows precise allowlisting at the namespace level
- Namespace filtering already exists in the logging settings UI

### Settings Infrastructure
- Master enable/disable toggle already exists
- Namespace-level filtering already exists
- Retention tiers already implemented (3 days → unlimited)
- Min log level filtering already exists

### Separation of Concerns
- Logs only flow through `appLog()` → `log()` in `log-service.ts`
- Single chokepoint for adding a subscriber/observer
- No other logging paths to worry about

---

## What Needs Improvement

### Open Meta Bag

The `meta` field is typed as `Record<string, unknown>` — there's no schema enforcement on what goes in. This means:

- **Any caller can put anything in meta** — file paths, agent names, mission text, model names
- **No way to statically know** what a given namespace's meta contains without reading every call site
- **New appLog calls can introduce new sensitive data** without any review gate

**Mitigation for telemetry:** The allowlist approach (namespace → allowed keys) handles this at the telemetry layer. But longer-term, consider adding typed meta interfaces per namespace.

### Interpolated Messages

The `msg` field often contains interpolated runtime values:

```typescript
// Examples from the codebase:
appLog('core:agent', 'info', `Spawning ${params.kind} agent`, { meta: { agentId, model, cwd } });
appLog('core:mcp', 'info', `Binding created for ${agentId}`, { meta: { port } });
appLog('update:check', 'info', `Update available: ${manifest.version}`, { meta: { ... } });
```

Some of these are safe (kind names, version numbers), but others could contain paths or IDs if the interpolation pattern changes.

**Mitigation for telemetry:** For Tier 2 namespaces, replace the msg with a canonical event ID rather than sending the freeform string. For Tier 1, truncate to 200 chars and run path detection regex.

### No Call-Site Sensitivity Annotation

There's no convention for marking which meta keys are safe vs sensitive at the appLog call site. This makes it hard to audit.

**Suggested convention (for future):**
```typescript
// TELEMETRY: safe=[kind]; sensitive=[agentId, model, cwd, binary, args]
appLog('core:agent', 'info', `Spawning ${params.kind} agent`, {
  meta: { kind, agentId, model, cwd, binary, args },
});
```

This doesn't change runtime behavior but provides a review checkpoint for PRs.

---

## No Structural Changes Needed

The telemetry plugin does not require changes to the log format, the appLog API, or the existing logging settings. The subscriber pattern in `log-service.ts` is the only integration point. All classification and redaction happens in the new telemetry module.

---

## Namespace Inventory (for reference)

| Category | Namespaces | Count |
|----------|-----------|-------|
| Core system | `core:agent`, `core:mcp`, `core:structured`, `core:headless`, `core:pty`, `core:process`, `core:startup`, `core:shutdown`, `core:safe-mode`, `core:hook-server`, `core:ipc`, `core:security`, `core:window`, `core:plugins`, `core:plugin-storage` | 15 |
| Agent/config | `core:agent-config`, `core:agent-settings`, `core:agent-queue`, `core:materialization`, `core:config-pipeline`, `core:config-diff`, `core:orchestrator`, `core:companion` | 8 |
| Files/project | `core:file`, `core:git`, `core:project`, `core:project-store`, `core:group-project` | 5 |
| Networking | `core:annex`, `core:annex-client`, `core:annex-server` | 3 |
| Updates | `update:check`, `update:download`, `update:apply`, `update:apply-on-quit`, `update:apply-detect`, `update:fetch`, `update:history`, `update:retry`, `update:session-resume` | 9 |
| Marketplace | `marketplace`, `marketplace:custom`, `marketplace:updates` | 3 |
| App | `app:ipc`, `app:test` | 2 |
| Structured mode | `core:structured:acp`, `core:structured:codex` | 2 |
| **Total** | | **47** |
