# Logging

Clubhouse includes a structured, namespace-based logging system that records application events, agent activity, and diagnostic information. Logs are stored locally on your machine and are never transmitted to any external service.

## Enabling Logging

1. Open **Settings** (gear icon in the Project Rail, or press `Cmd+,`).
2. Navigate to the **Logging** section.
3. Use the **master toggle** to enable or disable logging.

When logging is disabled, no new log entries are written. Existing log files are preserved until they expire according to the retention policy.

## Log Levels

Clubhouse uses a tiered severity system. You can set a **minimum log level** to control how much detail is captured. Only messages at or above the selected level are recorded.

| Level | Description |
|-------|-------------|
| **Debug** | Verbose output useful for diagnosing issues. Includes internal state, timing data, and detailed event traces. Produces the most log volume. |
| **Info** | Standard operational messages. Records key events such as agent starts, project loads, and plugin activations. This is the recommended default for normal use. |
| **Warn** | Conditions that are not errors but may indicate a problem, such as a deprecated plugin API call or a failed background fetch. |
| **Error** | Failures that prevented an operation from completing, such as a crashed agent or a plugin that failed to load. |
| **Fatal** | Critical failures that may cause application instability or force a restart. These are rare but important to capture. |

Setting the level to **Debug** captures everything. Setting it to **Error** captures only errors and fatal events, resulting in much smaller log files.

## Namespace Control

Logs are organized by **feature namespace**, allowing you to toggle logging on or off for specific areas of the application. This is particularly useful when you are investigating a specific issue and want to reduce noise from unrelated subsystems.

Example namespaces include:

| Namespace | Area |
|-----------|------|
| `core:startup` | Application launch and initialization |
| `core:updates` | Auto-update checks and installation |
| `git:operations` | Git commands and repository monitoring |
| `agents:lifecycle` | Agent creation, start, stop, and deletion events |
| `agents:orchestrator` | Communication between Clubhouse and orchestrator CLIs |
| `plugins:loader` | Plugin discovery, loading, and initialization |
| `plugins:api` | Plugin API calls and responses |
| `ui:navigation` | View switches, pane transitions, and layout changes |

Each namespace can be individually enabled or disabled in the Logging settings. When a namespace is disabled, messages from that area are silently dropped regardless of their severity level.

## Retention Policy

Log files accumulate over time. Clubhouse provides configurable retention tiers that control how long logs are kept and how much disk space they may consume.

| Tier | Duration | Max Size | Best For |
|------|----------|----------|----------|
| **Low** | 3 days | 50 MB | Minimal footprint. Suitable if you rarely need to check logs. |
| **Medium** | 7 days | 200 MB | A balanced default. Keeps enough history to diagnose recent issues. |
| **High** | 30 days | 500 MB | Extended history for ongoing debugging or monitoring. |
| **Unlimited** | No expiry | No cap | Logs are never automatically deleted. Use with caution, as log files can grow large over time. |

When logs exceed the configured duration or size limit, the oldest entries are pruned automatically. The **Unlimited** tier disables all automatic cleanup -- you are responsible for managing disk usage manually.

## Log File Location

The Logging settings display the **full path** to the log file directory on your system. A **direct link** is provided to open the log folder in Finder, making it easy to access log files for sharing or external analysis.

## Privacy

All logs are stored **locally on your machine**. Clubhouse does not transmit, upload, or share log data with any external service. Log files may contain project paths, file names, and agent activity details, so treat them with the same care you would give any local development data.

## Use Cases

| Scenario | Recommended Configuration |
|----------|--------------------------|
| **Debugging a startup crash** | Enable logging at **Debug** level with the `core:startup` namespace active. Check logs after reproducing the issue. |
| **Monitoring agent behavior** | Enable **Info** level with `agents:lifecycle` and `agents:orchestrator` namespaces. Review logs to trace what the agent did and why. |
| **Diagnosing a plugin problem** | Enable **Debug** level with `plugins:loader` and `plugins:api` namespaces. Look for errors during plugin initialization or API calls. |
| **General background logging** | Use **Info** level with all namespaces enabled and **Medium** retention. Provides a reasonable history without excessive disk usage. |
