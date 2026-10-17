# Terminal and transcripts

Select an agent and the pane shows what it's doing. Depending on the orchestrator and the agent's **Runtime** setting, that's a chat view or a terminal.

## The agent's terminal

The terminal works like any terminal emulator:

- full ANSI color, following your theme;
- scrollback for the session;
- select text to copy it;
- it resizes with the window and the sidebar.

You can type into it. Keystrokes go to the agent's process, which is how you answer prompts from tools it runs.

Switching to another agent doesn't lose anything. Output keeps arriving in the background and is there when you come back.

If typing stops reaching the terminal, press `⇧⌘T` to focus it again.

## Permission prompts

When an agent in interactive mode needs approval:

1. Its status dot changes to **Needs you**, and it appears under **Needs you** at the top of the sidebar.
2. The pane shows what it wants to do, such as editing a file.
3. Approve or deny it there.

Common requests are file edits, shell commands, deletions and Git operations. In headless mode, there are no prompts.

## Transcripts

The transcript is a structured log of what the agent did:

| Field | Meaning |
|-------|---------|
| **Time** | When it happened |
| **Event** | A tool call, a permission request, an error or the finish |
| **Tool** | Such as Read, Edit or Bash |
| **Input and output** | What went in and what came back |
| **Status** | Succeeded, failed or pending |

Open it from the agent's pane, or from a finished quick agent's summary.

## A terminal of your own

To work by hand in an agent's worktree, select the agent and open the **Terminal** tab in the title bar, or choose **Open terminal** on the agent's hover card. The shell opens in the agent's worktree and runs separately from the agent. Select the project's name instead to get a shell at the project root.

Each one keeps running when you switch away, so you can come back to it.
