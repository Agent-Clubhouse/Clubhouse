# Telemetry Plugin — Settings & Consent UX

## Managed Settings

Follows the existing `createManagedSettings()` + `createSettingsStore()` pattern. Adding a new settings definition requires changes to exactly 3 files (definition, main registration, renderer store).

```typescript
interface TelemetrySettings {
  enabled: boolean;                    // master toggle, default: false
  categories: {
    errors: boolean;                   // default: true (when enabled)
    usage: boolean;                    // default: true
    health: boolean;                   // default: true
  };
  customConnectionString: string;      // default: '' (uses built-in)
  consentShown: boolean;               // tracks if consent banner was displayed
}
```

**Storage:** `~/.clubhouse/telemetry-settings.json`

---

## Consent Flow

### First-Time Experience

When the telemetry experimental flag is enabled and `consentShown` is false:

1. A **non-blocking banner** appears in the settings view (not a modal that blocks the app)
2. Banner text: *"Help improve Clubhouse by sharing anonymous usage data. No chat content, file paths, or personal information is ever sent."*
3. Two buttons: **"Enable Telemetry"** / **"No Thanks"**
4. Choice is persisted (`consentShown: true`), banner never shown again
5. User can always change their mind later via the settings toggle

This follows the existing experimental features disclaimer pattern in `ExperimentalSettingsView.tsx`.

### No Defaults-On

Telemetry is **off by default**. The user must explicitly opt in. This is non-negotiable for trust.

---

## Settings UI Layout

### Telemetry Settings Panel

```
┌─────────────────────────────────────────────────────┐
│  Telemetry                                          │
│                                                     │
│  [Toggle] Enable Telemetry                          │
│  Anonymous usage data only. No chat content,        │
│  file paths, or personal information.               │
│                                                     │
│  ── Categories ──────────────────────────────────    │
│  [Toggle] Error Reports                             │
│           Uncaught exceptions, update failures      │
│                                                     │
│  [Toggle] Feature Usage                             │
│           Which features are used, agent counts     │
│                                                     │
│  [Toggle] Session Health                            │
│           Startup timing, shutdown, crash recovery   │
│                                                     │
│  ── Advanced ────────────────────────────────────    │
│  Connection String  [________________________]      │
│  Override to send to your own App Insights instance  │
│                                                     │
│  [Preview Data]                                     │
│  See the last 10 events that would be sent          │
└─────────────────────────────────────────────────────┘
```

- Category toggles only visible when master toggle is on
- Advanced section collapsed by default
- "Preview Data" opens a dialog (see below)

### Data Preview Dialog

A modal dialog showing the ring buffer contents:

```
┌─────────────────────────────────────────────────────┐
│  Telemetry Data Preview                     [Close] │
│                                                     │
│  These are the most recent events that would be     │
│  sent when telemetry is enabled.                    │
│                                                     │
│  ┌─ Event 1 ─────────────────────────────────────┐  │
│  │ name: "health/session-start"                  │  │
│  │ properties:                                   │  │
│  │   sessionId: "a1b2c3d4-..."                   │  │
│  │   appVersion: "0.39.0"                        │  │
│  │   platform: "darwin"                          │  │
│  │   arch: "arm64"                               │  │
│  │   schemaVersion: 1                            │  │
│  │   category: "health"                          │  │
│  └───────────────────────────────────────────────┘  │
│  ┌─ Event 2 ─────────────────────────────────────┐  │
│  │ name: "usage/agent-spawned"                   │  │
│  │ properties:                                   │  │
│  │   kind: "durable"                             │  │
│  │   isStructured: false                         │  │
│  │   ...                                         │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  Showing 10 of 47 buffered events                   │
└─────────────────────────────────────────────────────┘
```

Exposed via IPC channel `telemetry:preview` that returns sanitized ring buffer contents.

---

## Logging Settings Privacy Banner Update

Current text in `LoggingSettingsView.tsx` (line 36):
> "Logs are stored on your local disk only and are never transmitted."

Updated text:
> "Logs are stored on your local disk only. If the optional telemetry plugin is enabled, anonymized usage data may be sent separately."

This maintains trust by being transparent about the telemetry option's existence while making it clear logs themselves are never sent.

---

## Experimental Flag

Add `telemetry` to the experimental settings array in `ExperimentalSettingsView.tsx`:

```typescript
{
  id: 'telemetry',
  label: 'Telemetry',
  description: 'Opt-in anonymous usage data and error reporting to help improve Clubhouse.'
}
```

The plugin only loads when this flag is `true`, following the same pattern as `sessions` and `review`.
