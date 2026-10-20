# Logging and diagnostics

Clubhouse keeps one local record of what it does, in the log folder on this computer. Clubhouse never sends the log folder anywhere.

## Where the record is

The log folder is `~/.clubhouse/logs` (on Windows, `%USERPROFILE%\.clubhouse\logs`). **Settings > Logging** shows the full path. Click it to show the folder in Finder or File Explorer.

The record is a set of `telemetry-<start time>.jsonl` files. Each run of the app starts a new file, and so does turning recording off and on or changing the telemetry settings below. A file that reaches 2 MB continues in `.1.jsonl`, `.2.jsonl` and so on.

## What's in it

Each line is one JSON record. Its `t` field says what kind it is.

| `t` | What it holds |
|-----|---------------|
| `diag` | Diagnostic lines: what Clubhouse and its plugins log, with a namespace, a level, a message and details |
| `span`, `event`, `exception`, `metric` | Telemetry signals: how long each flow took, how it ended, error types, and per-minute metric totals |
| `session` | The first line of a run: app version, platform and detail level |
| `dropped`, `evicted` | Counts of lines that were dropped or deleted to stay within the limits below |

**Diagnostic lines** keep file paths, error messages and session ids as written, so they are useful for debugging. They are not anonymized. Before a line is written, your home folder is replaced by `<home>`, and prompts, chat messages, tool and command arguments, environment values and secrets such as tokens and API keys are replaced with a placeholder where Clubhouse can recognize them.

**Telemetry signals** hold the same anonymized data that telemetry export would send. They never contain prompts, terminal output, file paths, names or error messages, and ids are hashed.

## Before you share a file

Check a file before you share it, because its diagnostic lines can include file paths and error text. To keep only the anonymized signals, remove the diagnostic lines first.

On macOS or Linux:

```
grep -v '"t":"diag"' telemetry-<start time>.jsonl > signals-only.jsonl
```

On Windows, in PowerShell:

```
Get-Content telemetry-<start time>.jsonl | Where-Object { $_ -notmatch '"t":"diag"' } | Set-Content -Encoding utf8 signals-only.jsonl
```

## Quick setup

Recording is on by default. In **Settings > Logging**:

- **Record locally** turns the whole record on or off. While it is off, nothing is written and telemetry export has nothing to send.
- **Minimum level** and **Namespaces** choose which diagnostic lines are written. They don't affect the signals.
- **Record telemetry signals** turns the signals on or off. With it off, only diagnostic lines are written.
- **Telemetry detail** sets how much the signals cover. **Standard** (the default) covers flows, errors and metrics. **Detailed** also records each IPC call and agent tool call.

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
| `core:safe-mode` | Crash-loop detection and safe mode |
| `core:feedback` | Feedback capture and delivery |

## Limits and retention

Diagnostic lines have a budget of 2 MB an hour. When it runs low, debug lines are dropped first (past half the budget), then info lines (past 80%). Warnings and errors use the rest. A `dropped` line counts what went.

Each run keeps its newest 10 MB. Past that, the oldest file of the run is deleted and recording continues, so the most recent part of a long run is kept. An `evicted` line says how many files and bytes went.

The retention tier sets how long files are kept and how much space they can use in total:

| Tier | Duration | Max size |
|------|----------|----------|
| **Low** | 3 days | 50 MB |
| **Medium** | 7 days | 200 MB |
| **High** | 30 days | 500 MB |
| **Unlimited** | No expiry | No cap |

Retention runs when recording starts, every hour while recording, and each time a file reaches 2 MB and continues in a new one. The oldest files are deleted first, and a file that is being written is never deleted. It also deletes the `session-*.jsonl` logs that earlier versions wrote to the same folder.

## Feedback reports

A feedback report never includes the log folder or any part of it. Each report has an id, and Clubhouse writes that id to a `core:feedback` diagnostic line when the report is saved and again when it is delivered. These lines are at the info level, so they are written while **Record locally** is on, the `core:feedback` namespace is on, and **Minimum level** is info or debug. If a maintainer asks for your record of a report, they find the matching lines by its id and the time you sent it.

## Common diagnostic scenarios

| Problem | Configuration |
|---------|--------------|
| Startup crash | Debug level + `core:startup` |
| Agent misbehavior | Info level + `core:agent` + `core:orchestrator` |
| Plugin issue | Debug level + `core:plugins` + the plugin's `plugin:<id>` |
| General monitoring | Info level + all namespaces + Medium retention |
