# Logging & Diagnostics

Clubhouse includes structured, namespace-based logging. Logs are stored locally and never sent externally.

## Quick Setup

**Settings > Logging** — Toggle logging on, set a level, and enable relevant namespaces.

## Log Levels

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

## Log Files

The full path to your log directory is shown in Settings with a direct **Open in Finder** link.

## Common Diagnostic Scenarios

| Problem | Configuration |
|---------|--------------|
| Startup crash | Debug level + `core:startup` |
| Agent misbehavior | Info level + `agents:lifecycle` + `agents:orchestrator` |
| Plugin issue | Debug level + `plugins:loader` + `plugins:api` |
| General monitoring | Info level + all namespaces + Medium retention |
