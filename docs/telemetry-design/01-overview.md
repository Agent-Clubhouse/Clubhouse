# Telemetry Plugin — Overview & Backend

## Problem

Clubhouse currently has zero telemetry. All logs are local-only with an explicit "never transmitted" message in the UI. This makes it impossible to understand error rates, feature adoption, or debug issues across deployments.

## Goal

An **opt-in, privacy-first** telemetry plugin that gives operators clear control over what's sent, while providing actionable error and usage data.

**Want:** errors, feature usage, session health
**Don't want:** chat content, mission text, file paths, agent names, PII

---

## Backend Recommendation: Azure Application Insights

### Why App Insights

| Option | Verdict | Reasoning |
|--------|---------|-----------|
| **App Insights** | Recommended | Built-in dashboards, alerting, anomaly detection. Lightweight Node.js SDK (~200KB). Can export to ADX later via continuous export. |
| **ADX (Kusto)** | Deferred | More powerful querying, but requires managing clusters and building ingestion pipelines. Use as a downstream sink from App Insights when needed. |
| **Event Hubs** | Overkill | Designed for millions of events/sec. Requires a separate consumer and storage layer. App Insights uses Event Hubs internally anyway. |

### SDK

The `applicationinsights` Node.js SDK v3 provides `TelemetryClient` for custom events. It runs in the Electron main process — no browser dependencies.

### Connection String

- **Default:** Baked into the app binary (ingestion-only key). This is standard practice — VS Code does the same with `vscode-extension-telemetry`. The key cannot read data back.
- **Override:** Advanced users can point at their own App Insights instance via a settings field.
- **Rate limiting:** Configured on the Azure side to prevent abuse of the ingestion endpoint.

---

## Plugin Architecture: Built-in Plugin

### Why Built-in (not Community)

1. **Log stream access** — needs main-process hook into `appLog()`. Community plugins can only write logs, not read/intercept them.
2. **App-level consent** — consent UX belongs at the app level, not scoped to a project.
3. **Trust** — users need to know this ships from Clubhouse. A community plugin that "phones home" raises suspicion.
4. **Still cleanly disableable** — same toggle mechanism as `canvas`, `review`, `sessions`.

### Plugin Properties

```
id:              'telemetry'
scope:           'app'
permissions:     ['storage', 'events', 'logging']  (all safe-tier)
settingsPanel:   'custom'
gated by:        experimentalFlags.telemetry
```

No elevated or dangerous permissions required. This matters for user trust.
