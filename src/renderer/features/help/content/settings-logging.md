# Logging and diagnostics

Clubhouse includes structured, namespace-based logging. Logs are stored locally and never sent externally.

## Quick setup

**Settings > Logging** — Toggle logging on, set a level, and enable relevant namespaces.

## Log levels

| Level | Use For |
|-------|---------|
| **Debug** | Maximum detail — internal state, timing, event traces |
| **Info** | Standard operations — agent starts, project loads, plugin activations *(recommended default)* |
| **Warn** | Potential issues — deprecated API calls, failed background fetches |
| **Error** | Operation failures — crashed agents, plugin load errors |
| **Fatal** | Critical failures that may require a restart |

## Namespaces

Filter logs by feature area to reduce noise:

| Namespace | Covers |
|-----------|--------|
| `core:startup` | App launch and initialization |
| `core:updates` | Auto-update checks |
| `git:operations` | Git commands and monitoring |
| `agents:lifecycle` | Agent create, start, stop, delete |
| `agents:orchestrator` | Orchestrator CLI communication |
| `plugins:loader` | Plugin discovery and loading |
| `plugins:api` | Plugin API calls |
| `ui:navigation` | View switches and layout changes |

Each namespace can be toggled independently.

## Retention

| Tier | Duration | Max Size |
|------|----------|----------|
| **Low** | 3 days | 50 MB |
| **Medium** | 7 days | 200 MB |
| **High** | 30 days | 500 MB |
| **Unlimited** | No expiry | No cap |

Oldest entries are pruned automatically when limits are reached.

## Log files

The full path to your log directory is shown in Settings with a direct **Open in Finder** link.

## Local telemetry recording

**Record telemetry locally** (on by default, and only while **Write logs** is on) writes the app's telemetry signals to `telemetry-<start time>.jsonl` files in the same log folder: how long each flow took, how it ended, error types, and per-minute metric totals. Nothing in these files is sent anywhere.

The files hold the same anonymized data that telemetry export would send. They never contain prompts, terminal output, file paths, names or error messages, and ids are hashed. Each run writes at most 10 MB in 2 MB files, and the files share the retention tier above with the session logs.

**Telemetry detail** sets how much is recorded. **Standard** (the default) covers flows, errors and metrics. **Detailed** also records each IPC call and agent tool call.

Exporting telemetry to a service is set up under **Telemetry export** on the same page. Export uploads only what this setting records, at this detail level or less, so turning export on or off doesn't change what Clubhouse measures or how much work it does. With **Write logs** or **Record telemetry locally** off, Clubhouse runs no background telemetry measurements and sends nothing, even to a destination that is set up.

## Common diagnostic scenarios

| Problem | Configuration |
|---------|--------------|
| Startup crash | Debug level + `core:startup` |
| Agent misbehavior | Info level + `agents:lifecycle` + `agents:orchestrator` |
| Plugin issue | Debug level + `plugins:loader` + `plugins:api` |
| General monitoring | Info level + all namespaces + Medium retention |
