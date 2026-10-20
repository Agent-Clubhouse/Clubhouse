# Logging and diagnostics

Clubhouse keeps a diagnostic log and telemetry signals in your log folder on this computer. Clubhouse never sends the log folder anywhere.

The diagnostic log keeps file paths, error messages and session ids as written, so it is useful for debugging. It is not anonymized. Check it before you share it.

## Quick setup

In **Settings > Logging**, turn on **Record locally**, set a minimum level, and turn off any namespaces you don't need.

## Log levels

| Level | Use for |
|-------|---------|
| **Debug** | Maximum detail, such as internal state, timing and event traces |
| **Info** | Standard operations, such as agent starts, project loads and plugin activations *(recommended default)* |
| **Warn** | Potential issues, such as deprecated API calls and failed background fetches |
| **Error** | Operation failures, such as crashed agents and plugin load errors |
| **Fatal** | Critical failures that may require a restart |

## Namespaces

Settings lists every namespace Clubhouse writes to, plus any plugin namespaces (`plugin:<id>`) seen this run. Turn one off to stop writing its diagnostic lines. Some common ones:

| Namespace | Covers |
|-----------|--------|
| `core:startup` | App launch and initialization |
| `update:check`, `update:download` | Auto-update checks and downloads |
| `core:git` | Git commands |
| `core:agent`, `core:pty`, `core:headless` | Agent spawn, terminal sessions and exits |
| `core:chat` | Chat sessions and their drivers |
| `core:orchestrator` | Orchestrator CLI communication |
| `core:plugins` | Plugin discovery and loading |
| `ui:nav` | View switches |

## Retention

| Tier | Duration | Max size |
|------|----------|----------|
| **Low** | 3 days | 50 MB |
| **Medium** | 7 days | 200 MB |
| **High** | 30 days | 500 MB |
| **Unlimited** | No expiry | No cap |

Oldest entries are pruned automatically when limits are reached.

## Log files

The full path to your log directory is shown in Settings with a direct **Open in Finder** link.

## Local telemetry recording

**Record telemetry signals** (on by default, and only while **Record locally** is on) writes the app's telemetry signals to `telemetry-<start time>.jsonl` files in the same log folder: how long each flow took, how it ended, error types, and per-minute metric totals. Nothing in these files is sent anywhere.

The files hold the same anonymized data that telemetry export would send. They never contain prompts, terminal output, file paths, names or error messages, and ids are hashed. Each run keeps its newest 10 MB in 2 MB files: past that, the oldest file of the run is deleted and recording continues. The files share the retention tier above with the session logs, and it is applied while the app runs, not only at startup.

**Telemetry detail** sets how much is recorded. **Standard** (the default) covers flows, errors and metrics. **Detailed** also records each IPC call and agent tool call.

Exporting telemetry to a service is set up under **Telemetry export** on the same page. Export uploads only what this setting records, at this detail level or less, so turning export on or off doesn't change what Clubhouse measures or how much work it does. With **Record locally** or **Record telemetry signals** off, Clubhouse runs no background telemetry measurements and sends nothing, even to a destination that is set up.

## Common diagnostic scenarios

| Problem | Configuration |
|---------|--------------|
| Startup crash | Debug level + `core:startup` |
| Agent misbehavior | Info level + `core:agent` + `core:orchestrator` |
| Plugin issue | Debug level + `core:plugins` + the plugin's `plugin:<id>` |
| General monitoring | Info level + all namespaces + Medium retention |
