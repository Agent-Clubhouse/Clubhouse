# Quick Agents

Quick agents are one-shot task runners. Give them a mission, they execute it, and they exit — no persistent state or dedicated branch.

## Launching

1. Press `Cmd+Shift+N` (or click **Quick Agent** in the explorer)
2. Type a mission description
3. Optionally configure:
   - **Model** — from the orchestrator's available models
   - **Orchestrator** — when no parent agent is selected
   - **Parent agent** — inherit a durable agent's context and defaults
   - **Project** — if launching from outside a project context
4. Press `Cmd+Enter` or click **Run**

## Free Agent Mode

Check **Free Agent** to skip all permission prompts (`--dangerously-skip-permissions`). The agent runs fully autonomously without pausing for approvals.

> **Use with caution:** Free Agent mode is best for trusted tasks in sandboxed environments. For destructive operations, keep it off.

## Headless vs Interactive Mode

| | Headless (default) | Interactive |
|-|-------------------|-------------|
| **Permissions** | Agent proceeds automatically | Pauses for each approval |
| **File edits** | Applied immediately | Require approval |
| **Shell commands** | Executed immediately | Require approval |
| **Speed** | Faster | Slower (waits for input) |

Switch mode in **Settings** (global) or **Project Settings** (per-project).

**Note:** Headless mode controls output format. Free Agent mode controls permission handling. They are separate toggles.

## Completion Summary

When finished, a summary card shows:

| Field | Description |
|-------|-------------|
| **Exit code** | `0` = success |
| **Files modified** | Created, edited, or deleted files |
| **Duration** | Start to finish time |
| **Cost** | Estimated API cost (USD) |
| **Tools used** | Summary of tool invocations |

## Ghost Cards

Completed quick agents appear as dismissible review cards ("ghosts") in the explorer. From a ghost card you can:
- View the full summary and file changes
- Open the transcript (structured event log)
- Inspect diffs of modified files
- Dismiss when done reviewing

## Transcript

Every agent produces a structured event log with tool calls, permission events, errors, and timing data. More organized than raw terminal output — useful for debugging and auditing.
