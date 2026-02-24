# Terminal & Transcripts

Every agent has a terminal view showing real-time output, plus a structured transcript for organized review.

## Terminal View

The terminal (built on xterm.js) behaves like a standard terminal emulator:
- Full ANSI color support and theme-aware colors
- Scrollback buffer preserved for the session
- Text selection and clipboard copy
- Auto-resizes with window and panel changes

## User Input

You can type directly into an agent's terminal. Keystrokes are forwarded to the orchestrator process — useful for responding to interactive prompts from tools the agent invokes.

## Output Buffering

Switching away from an agent doesn't lose output. All data is captured in the background and replayed when you switch back.

## Permission Prompts

When an agent in interactive mode needs approval for a sensitive operation:

1. **Orange ring** appears on the agent's avatar in the explorer
2. **Permission banner** describes the operation (e.g., "Edit file: src/index.ts")
3. **Approve / Deny** buttons let you respond

Common permission requests: file edits, shell commands, file deletions, Git operations.

**Batch approval** — When multiple similar requests queue up, you may see an option to approve all at once.

In headless mode, prompts are skipped automatically.

## Transcript Viewer

A structured event log organizing agent activity into discrete entries:

| Field | Description |
|-------|-------------|
| **Timestamp** | When the event occurred |
| **Event type** | Tool call, permission request, error, or completion |
| **Tool name** | e.g., Read, Edit, Bash |
| **Input/Output** | Parameters and results |
| **Status** | Succeeded, failed, or pending |

Open from the agent toolbar or a ghost card's context menu.

## Utility Terminal

Need to do manual work in an agent's worktree? Open a **Utility Terminal**:

1. Select the agent
2. Click **Utility Terminal** in the toolbar

This opens a standard shell session (bash/zsh) in the agent's working directory — completely independent of the agent's process. Use it to run builds, inspect files, check Git status, or debug.
