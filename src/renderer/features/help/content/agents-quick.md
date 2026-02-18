# Quick Agents

Quick agents are one-shot task runners. You give them a mission, they execute it, and they exit. There is no persistent state, no dedicated branch, and no configuration to maintain. Quick agents are ideal for tasks that can be completed in a single pass: small bug fixes, generating boilerplate, answering a question about the codebase, or running a one-off script.

## Running a Quick Agent

To launch a quick agent:

1. Select a project in the Project Rail.
2. Open the quick agent launcher in the explorer panel (the text input at the top of the agent list, or the **Quick Agent** button).
3. Type a mission description — a clear, concise statement of what you want the agent to do.
4. Optionally select a model from the model picker. If you do not choose one, the default model from the project or parent durable agent is used.
5. Press **Enter** or click **Run** to launch the agent.

The quick agent starts immediately. You can watch its progress in the terminal view or switch to other work while it runs.

## Completion Summary

When a quick agent finishes its mission, Clubhouse displays a structured summary with the following information:

| Field | Description |
|-------|-------------|
| **Exit code** | The process exit code. `0` indicates success; any other value indicates an error. |
| **Files modified** | A list of files the agent created, edited, or deleted during its run. |
| **Duration** | How long the agent ran, from start to completion. |
| **Cost (USD)** | The estimated API cost for the agent's session, based on token usage and the model's pricing. |
| **Timestamp** | The date and time the agent finished. |
| **Tools used** | A summary of the tools the agent invoked (e.g., file reads, file writes, shell commands, searches). |

The summary gives you a quick way to assess what happened without reading through the full terminal output.

## Quick Agent Ghosts

After a quick agent completes, it does not disappear from the interface immediately. Instead, it appears as a "ghost" — a review card in the explorer list. Ghost cards show the agent's mission, exit status, and a condensed summary.

You can interact with a ghost card to:

- **View the full summary** including all files modified and tools used.
- **Open the transcript** to see a structured log of everything the agent did.
- **Inspect file changes** to review diffs of modified files.
- **Dismiss** the ghost card when you are done reviewing.

Ghost cards remain until you dismiss them, so you can launch several quick agents and review their results later at your convenience.

## Headless Mode

By default, quick agents run in **interactive mode**: when the agent wants to perform a sensitive operation (such as editing a file or running a shell command), it pauses and asks for your permission. This is safe but requires you to stay attentive.

**Headless mode** removes the permission prompts. The agent runs from start to finish without stopping, making it significantly faster for tasks you trust it to handle autonomously.

### Enabling Headless Mode

You can enable headless mode in two ways:

- **Globally** — go to **Settings** and enable the headless mode toggle. This applies to all quick agents across all projects.
- **Per project** — open the project's settings and enable headless mode there. This overrides the global setting for that project only.

### How Headless Mode Works

| Behavior | Interactive Mode (default) | Headless Mode |
|----------|---------------------------|---------------|
| Permission prompts | Agent pauses and waits for approval | Agent proceeds automatically |
| File edits | Require approval before writing | Applied immediately |
| Shell commands | Require approval before executing | Executed immediately |
| Completion summary | Standard summary | Richer summary with full tool call details |
| Speed | Slower (waits for human input) | Faster (no interruptions) |

Headless mode is best suited for low-risk tasks where you are comfortable letting the agent act without supervision. For tasks that involve destructive operations (deleting files, force-pushing branches, modifying production configuration), interactive mode provides an important safety net.

### Quick Agent Defaults

If a quick agent is launched from a durable agent, it can inherit default settings configured on the durable agent:

- **System prompt** — a base prompt that is prepended to the mission you type. Use this to provide standing instructions such as coding conventions, file restrictions, or output format requirements.
- **Allowed tools** — a whitelist of tools the quick agent can use. For example, you might restrict a quick agent to read-only file access and search, preventing it from making edits.
- **Default model** — the model the quick agent uses if you do not explicitly pick one in the launcher.

These defaults are configured on the parent durable agent's settings panel under **Quick Agent Defaults**. They save time and enforce consistency when you frequently launch quick agents for similar tasks.

## Transcript

Every quick agent (and durable agent) produces a transcript: a structured event log of everything the agent did during its session. The transcript is more organized than raw terminal output and includes:

- **Tool calls** with their inputs and outputs (e.g., which file was read, what command was run)
- **Permission events** showing what was approved or denied
- **Errors** with timestamps and context
- **Timing data** for each event

You can open the transcript from the completion summary or from the ghost card's context menu. The transcript is useful for understanding what the agent did, debugging unexpected behavior, and auditing the agent's actions.
