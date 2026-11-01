# CLI and transcripts

Select an agent and the pane shows what it's doing, usually in its CLI view. With the experimental Chat feature turned on, an agent's **Runtime** setting can show it as a chat instead.

## The agent's CLI view

The CLI view works like any terminal emulator:

- full ANSI color, following your theme;
- scrollback for the session;
- select text to copy it;
- it resizes with the window and the sidebar.

You can type into it. Keystrokes go to the agent's process, which is how you answer prompts from tools it runs.

Switching to another agent doesn't lose anything. Output keeps arriving in the background and is there when you come back.

If typing stops reaching the CLI view, press `⇧⌘T` to focus it again.

## Permission prompts

When an agent in interactive mode needs approval:

1. Its status dot changes to **Needs you**, and it appears under **Needs you** at the top of the sidebar.
2. The pane shows what it wants to do, such as editing a file.
3. Approve or deny it there.

Common requests are file edits, shell commands, deletions and Git operations. In headless mode, there are no prompts.

## Transcripts

A headless quick agent has no CLI view to scroll back through, so its summary card has **View transcript** once it finishes. The transcript lists, in order:

- each tool the agent called, by name, such as Read, Edit or Bash;
- what the agent wrote between tool calls;
- a final result line, with the cost and duration when the orchestrator reports them.

Long transcripts load the most recent events first, and earlier ones load as you scroll up.

## A terminal of your own

To work by hand in an agent's worktree, select the agent and open the **Terminal** tab in the title bar, or choose **Open terminal** on the agent's hover card. Both need the Terminal plugin on for the project. The shell opens in the agent's worktree and runs separately from the agent. Select the project's name instead to get a shell at the project root.

Each one keeps running when you switch away, so you can come back to it.
