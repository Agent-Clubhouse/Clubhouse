# Quick agents

Quick agents run one task and stop. They don't keep a branch or any state between runs.

## Starting one

The quickest way is the project's start page:

1. Select the project's name in the sidebar, or press `⇧⌘N` to open the active project's start page with the box focused.
2. Type what the agent should do.
3. Pick **Runs on** and **Model** if you want something other than the defaults.
4. Press `⌘Enter` or click **Start**.

For more options, click **New** at the top of the sidebar and choose **Quick agent…**. That dialog adds:

- **Parent agent**, to inherit a durable agent's quick agent defaults and work in its worktree;
- **Free Agent Mode**, to let the agent act without asking for permission;
- a **Project** picker, when you start it from outside a project.

## Free agent mode

Free Agent Mode handles permission prompts for you. By default it skips them all. If your CLI supports `--permission-mode auto`, you can switch to **Auto** under **Free agent permission mode** in **Settings > Orchestrators & agents**, for all projects or one. Auto runs a safety check that allows safe actions and blocks risky ones, like force pushes, mass deletions and sending credentials out.

## Headless or interactive

| | Headless | Interactive |
|-|----------|-------------|
| **Permissions** | The agent goes ahead on its own | It stops to ask each time |
| **File edits and commands** | Applied right away | Need your approval |
| **Speed** | Faster | Slower, since it waits for you |

Set it with **Default quick agent mode** in **Settings > Orchestrators & agents**, or **Quick agent mode** in a project's own **Orchestrators & agents** page. Headless and Free Agent Mode are separate settings.

## When it finishes

Finished quick agents wait for you in two places: the project's start page, under **Finished, waiting on you**, and the **N finished quick agents** row under the project in the sidebar. Open one to see its summary card:

- whether it succeeded, with its exit code;
- its orchestrator and model, and a **Headless** tag if it ran headless;
- what it reported back when it finished;
- how long it ran and which tools it used;
- the files it modified.

For a headless quick agent, the card can also show its transcript. See **CLI and transcripts**.

**Dismiss** removes one when you're done. **Clear all**, on the start page and on the sidebar row, removes every finished quick agent in the project.
