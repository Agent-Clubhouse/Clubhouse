# Telemetry Plugin — Implementation Map

## Files to Modify

| File | Change |
|------|--------|
| `src/main/services/log-service.ts` | Add `subscribe(fn)` / `unsubscribe(fn)` observer pattern (~10 lines) |
| `src/shared/settings-definitions.ts` | Add `TELEMETRY_SETTINGS` definition |
| `src/shared/types.ts` | Add `TelemetrySettings` interface |
| `src/main/ipc/settings-handlers.ts` | Register managed settings (1 line) |
| `src/renderer/plugins/builtin/index.ts` | Register telemetry plugin, gated by experimental flag |
| `src/renderer/features/settings/ExperimentalSettingsView.tsx` | Add `telemetry` to feature array |
| `src/renderer/features/settings/LoggingSettingsView.tsx` | Update privacy banner text |

## New Files

| File | Purpose |
|------|---------|
| `src/main/services/telemetry-collector.ts` | Classifier, redactor, ring buffer, batch sender |
| `src/main/services/telemetry-settings.ts` | `createManagedSettings(TELEMETRY_SETTINGS)` |
| `src/renderer/plugins/builtin/telemetry/manifest.ts` | Plugin manifest (app-scoped, custom settings) |
| `src/renderer/plugins/builtin/telemetry/main.ts` | activate/deactivate lifecycle hooks |
| `src/renderer/features/settings/TelemetrySettingsView.tsx` | Settings panel with consent, toggles, preview |
| `src/renderer/stores/telemetryStore.ts` | `createSettingsStore(TELEMETRY_SETTINGS)` |

## New Test Files

| File | Coverage |
|------|----------|
| `src/main/services/telemetry-collector.test.ts` | Classifier, redactor, ring buffer, batch sender |
| `src/renderer/features/settings/TelemetrySettingsView.test.tsx` | Settings UI, consent flow, preview dialog |

---

## Implementation Phases

### Phase 1: Core Infrastructure (main process)

1. Add subscriber pattern to `log-service.ts`
2. Define `TelemetrySettings` type and managed settings definition
3. Create `telemetry-settings.ts` and register in `settings-handlers.ts`
4. Create `telemetry-collector.ts` — classifier, redactor, ring buffer, batch sender
5. Integrate App Insights SDK (`applicationinsights` npm package)

### Phase 2: Plugin Shell (renderer)

6. Create manifest and main.ts in `builtin/telemetry/`
7. Register in `builtin/index.ts`, gated by experimental flag
8. Add `telemetry` to `ExperimentalSettingsView.tsx`

### Phase 3: Settings UI

9. Create `TelemetrySettingsView.tsx` — master toggle, category toggles, consent banner
10. Create Zustand store via `createSettingsStore()`
11. Add IPC channel for data preview (`telemetry:preview`)
12. Build data preview dialog

### Phase 4: Privacy Review & Testing

13. Write classifier unit tests — every namespace mapped, unknown namespaces dropped
14. Write redactor unit tests — sensitive meta stripped, paths detected, allowlist enforced
15. Write fuzz test — random meta objects, verify no paths/PII leak through
16. Write integration test — appLog with sensitive meta → sanitized output in ring buffer
17. Update logging settings privacy banner

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Accidental PII leak through new appLog calls | Medium | High | Path regex on all strings, meta allowlist, schema tests |
| Performance impact from subscriber | Low | Medium | Short-circuit when no subscribers; classifier is O(1) hashmap lookup |
| App Insights SDK size bloat | Medium | Low | Lightweight Node SDK (~200KB), not the full web SDK |
| Users alarmed by "telemetry" | Medium | Medium | Clear settings UI, data preview, prominent "off by default" |
| Connection string in binary | Low | Low | Ingestion-only key, rate limiting on Azure side |

---

## Open Questions

1. **Install ID for cross-session correlation?** Currently no way to track unique installs. Is this needed for v1, or can it wait?
2. **Custom dimensions in App Insights?** Should we define custom dimensions for the KQL queries, or keep everything in the flat properties bag?
3. **Alert rules?** Should we pre-configure Azure Monitor alert rules (e.g., error rate spike) as part of the backend setup?
4. **Marketplace telemetry?** Should we track which plugins are installed (by category/count, not by name) or leave marketplace out entirely?
