# Telemetry Plugin — Data Pipeline

## Architecture

```
appLog(ns, level, msg, {meta})
    |
    v
log-service.ts  ──>  JSONL on disk (unchanged)
    |
    +── [NEW] subscriber callback
            |
            v
    TelemetryCollector
        1. classify(entry.ns)  ──>  ALLOW or DROP
        2. redact(entry)       ──>  strip sensitive meta, sanitize msg
        3. ring buffer         ──>  in-memory, max 500 events
            |
            v
    BatchSender (flush every 30s OR 100 events, whichever first)
            |
            v
    App Insights trackEvent()
```

## Hook Point: Log Subscriber Pattern

The only change to existing code: add `subscribe(fn)` / `unsubscribe(fn)` to `log-service.ts`.

**Location:** `src/main/services/log-service.ts`, after the buffer push on line ~132.

```typescript
// New exports
const subscribers: Array<(entry: LogEntry) => void> = [];

export function subscribe(fn: (entry: LogEntry) => void): void {
  subscribers.push(fn);
}

export function unsubscribe(fn: (entry: LogEntry) => void): void {
  const idx = subscribers.indexOf(fn);
  if (idx >= 0) subscribers.splice(idx, 1);
}

// In the log() function, after buffer.push(line):
for (const sub of subscribers) sub(entry);
```

**Cost when disabled:** Zero. Empty array iteration is free. The subscriber only exists when the telemetry plugin is activated.

## Batching Strategy

| Trigger | Value | Reasoning |
|---------|-------|-----------|
| Time-based | 30 seconds | Keeps data fresh without excessive network calls |
| Count-based | 100 events | Prevents large batches sitting in memory |
| App quit | Synchronous flush | Register on `app.on('before-quit')`, same pattern as log-service |

## Offline / Failure Handling

- **In-memory ring buffer only.** Max 500 events. Oldest events evicted when full.
- **No disk queue.** Telemetry is ephemeral and aggregate. Missing batches during offline periods is acceptable. Disk queuing adds complexity and creates a second copy of telemetry data on the local machine.
- **Retry:** 3 attempts per batch with exponential backoff (1s → 4s → 16s). After 3 failures, drop the batch and log a local warning.

## Transmission Payload

Each event sent to App Insights:

```typescript
interface TelemetryEvent {
  name: string;              // e.g., "error/uncaught", "usage/agent-spawned"
  properties: {
    sessionId: string;       // random UUID, generated at app start, not persisted
    appVersion: string;
    platform: string;        // darwin | win32 | linux
    arch: string;            // x64 | arm64
    schemaVersion: number;   // starts at 1, bumped on breaking changes
    level: string;           // debug | info | warn | error | fatal
    category: string;        // 'error' | 'usage' | 'health'
    ns: string;              // original namespace
    // ... allowlisted meta fields (varies by namespace)
  };
}
```
