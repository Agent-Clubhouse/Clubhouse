# Agent Terminal and Output

Every running agent in Clubhouse has a terminal view that shows its real-time output. The terminal is the primary way to observe what an agent is doing, interact with permission prompts, and debug issues.

## Terminal View

When you select a running agent in the explorer, the main content area displays its terminal. The terminal is built on xterm.js and behaves like a standard terminal emulator:

- **ANSI color support** — output from the orchestrator, including syntax-highlighted diffs, colored status messages, and formatted tables, renders with full color.
- **Theme-aware** — the terminal background, foreground, and color palette automatically match your Clubhouse theme (light or dark). If you switch themes, open terminals update immediately.
- **Scrollback** — you can scroll up through the terminal history to review earlier output. The scrollback buffer is preserved for the duration of the agent's session.
- **Text selection and copy** — select text in the terminal with your mouse and copy it to the clipboard.

## User Input Forwarding

You can type directly into the agent's terminal. Keystrokes are forwarded to the underlying orchestrator process. This is useful for:

- Responding to interactive prompts from tools the agent invokes (e.g., a CLI tool that asks for confirmation).
- Sending text input when the agent runs a command that reads from stdin.

Note that in most cases, the agent handles its own input and output. User input forwarding is a fallback for situations where the orchestrator or a subprocess needs direct human input.

## Terminal Resizing

The terminal automatically resizes when:

- You resize the Clubhouse window.
- You drag the panel divider to make the terminal area wider or narrower.
- You toggle the sidebar or other panels that affect available space.

The resize signal is forwarded to the orchestrator process so that command output wraps correctly at the new width. You do not need to do anything manually.

## Output Buffering

When you switch away from an agent (for example, by selecting a different agent or navigating to settings), the terminal output continues to be captured in the background. When you switch back, all buffered output is replayed into the terminal view so you see the complete history.

This means you never lose output by switching between agents. Every agent's terminal maintains its full session history regardless of whether it is currently visible.

## Transcript Viewer

In addition to the raw terminal, Clubhouse provides a **transcript viewer** — a structured event log that organizes the agent's activity into discrete, readable entries. The transcript is available for both running and completed agents.

Each transcript entry includes:

| Field | Description |
|-------|-------------|
| **Timestamp** | When the event occurred, shown as a relative time (e.g., "2m ago") or absolute time. |
| **Event type** | The kind of event: tool call, permission request, error, completion, or informational message. |
| **Tool name** | For tool call events, the name of the tool that was invoked (e.g., Read, Edit, Bash). |
| **Input** | The parameters passed to the tool (e.g., the file path for a Read, the command for a Bash call). |
| **Output** | The result returned by the tool, which may be truncated for large outputs. |
| **Status** | Whether the event succeeded, failed, or is still pending. |

The transcript viewer is useful for quickly scanning what an agent did without reading through terminal output line by line. You can open it from the agent's toolbar or from a completed quick agent's ghost card.

## Permission Prompts

When an agent running in interactive mode wants to perform a sensitive operation, it pauses and requests permission. Clubhouse surfaces these requests with clear visual indicators:

1. **Orange ring** — the agent's avatar ring in the explorer turns orange, signaling that attention is needed.
2. **Permission banner** — inside the terminal view, a banner appears describing the operation the agent wants to perform (e.g., "Edit file: src/index.ts" or "Run command: npm test").
3. **Approve / Deny buttons** — click **Approve** to let the agent proceed or **Deny** to reject the operation. The agent will attempt to continue its mission after a denial, possibly choosing an alternative approach.

Operations that typically require permission include:

- Writing or editing files
- Running shell commands
- Deleting files
- Performing Git operations (committing, pushing, branch manipulation)

In headless mode, these prompts are skipped and the agent proceeds automatically. See the **Quick Agents** help topic for details on headless mode.

### Batch Approval

If an agent requests permission for several similar operations in sequence (for example, editing multiple files as part of a refactor), you may see a batch approval option that lets you approve all pending operations at once rather than one at a time.

## Utility Terminal

Sometimes you need to do manual work in an agent's working directory — run a build, inspect files, test a command, or check Git status. Clubhouse provides a **utility terminal** for this purpose.

To open a utility terminal:

1. Select the agent in the explorer.
2. Click the **Utility Terminal** button in the agent's toolbar (or use the context menu).
3. A new shell session opens in a tab, with the working directory set to the agent's worktree.

The utility terminal is a standard shell session (your default shell, typically bash or zsh). It is completely independent of the agent's orchestrator process — commands you run here do not affect the agent, and the agent does not see your commands.

Use the utility terminal to:

- Run builds or tests against the agent's branch.
- Inspect the file system to verify changes the agent made.
- Run Git commands (check status, view diffs, create commits).
- Debug issues by running the same commands the agent attempted.

You can have multiple utility terminals open at the same time, and they persist until you close them or delete the agent.
