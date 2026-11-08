# Quick Agents

Quick agents are one-shot task runners. Give them a mission, they execute it, and they exit — no persistent state or dedicated branch.

## Launching

1. Press `Cmd+Shift+N` (or click **Quick Agent** in the explorer)
2. Type a mission description
3. Optionally configure:
   - **Model** — from the orchestrator's available models
   - **Runs on**, the CLI to use, when no parent agent is selected
   - **Parent agent** — inherit a durable agent's context and defaults
   - **Project** — if launching from outside a project context
4. Press `Cmd+Enter` or click **Run**

## Access

**Access** is the level the agent starts at. A quick agent starts at your **Default access**, set in **Settings > Agents & providers**. You can pick another level before you click **Run**.

| Level | What the agent does |
|-------|---------------------|
| **Plan** | Reads and plans. Makes no changes. |
| **Ask first** | Asks before edits and commands. |
| **Auto-accept edits** | Makes file edits without asking. Asks before commands. |
| **Auto** | A check decides what needs your approval. It can be wrong. |
| **Full access** | Runs everything without asking. |

Each CLI only lists the levels it can start at. Claude Code has all five. In the terminal, Codex CLI has Ask first, Auto and Full access, and Copilot CLI has Ask first and Full access. In chat, each CLI offers the levels its chat connection supports.

Auto isn't a promise of safety. The check can let through something you would have stopped, including risky commands.

## Headless vs Interactive Mode

| | Headless (default) | Interactive |
|-|-------------------|-------------|
| **Permissions** | Agent proceeds automatically | Pauses for each approval |
| **File edits** | Applied immediately | Require approval |
| **Shell commands** | Executed immediately | Require approval |
| **Speed** | Faster | Slower (waits for input) |

Switch mode in **Settings** (global) or **Project Settings** (per-project).

**Note:** Headless mode controls output format. Access controls what the agent may do without asking. They are separate settings.

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

Every agent produces a structured event log with tool calls, permission events, errors, and timing data. More organized than raw CLI output, and useful for debugging and auditing.
