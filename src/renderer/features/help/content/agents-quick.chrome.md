# Quick agents

Quick agents run one task and stop. They don't keep a branch or any state between runs.

## Starting one

The quickest way is the project's start page:

1. Select the project's name in the sidebar, or press `⇧⌘N` to open the active project's start page with the box focused.
2. Type what the agent should do.
3. Pick the **Orchestrator** and **Model** if you want something other than the defaults.
4. Press `⌘Enter` or click **Start**.

For more options, click **New** at the top of the sidebar and choose **Quick agent…**. That dialog adds:

- **Parent agent**, to inherit a durable agent's quick agent defaults and work in its worktree;
- **Free Agent Mode**, to let the agent act without asking for permission;
- a **Project** picker, when you start it from outside a project.

## Free Agent Mode

Free Agent Mode handles permission prompts for you. By default it skips them all. If your CLI supports `--permission-mode auto`, you can switch to **Auto** under **Free agent permission mode** in **Settings > Orchestrators & agents**, for all projects or one. Auto runs a safety check that allows safe actions and blocks risky ones, like force pushes, mass deletions and sending credentials out.

## Headless or interactive

| | Headless | Interactive |
|-|----------|-------------|
| **Permissions** | The agent goes ahead on its own | It stops to ask each time |
| **File edits and commands** | Applied right away | Need your approval |
| **Speed** | Faster | Slower, since it waits for you |

Set the default under **Quick agent mode** in **Settings > Orchestrators & agents**, for all projects or one. Headless and Free Agent Mode are separate settings.

## When it finishes

Finished quick agents wait for you in two places: the project's start page, under **Finished, waiting on you**, and the **N finished quick agents** row under the project in the sidebar. Open one to see its summary:

| Field | Meaning |
|-------|---------|
| **Exit code** | `0` means it succeeded |
| **Files changed** | Files it created, edited or deleted |
| **Duration** | How long it ran |
| **Cost** | Estimated API cost, in USD |
| **Tools used** | A summary of its tool calls |

From the summary you can read the transcript and look at the diffs. **Dismiss** removes one when you're done, and **Clear all** removes the rest.
