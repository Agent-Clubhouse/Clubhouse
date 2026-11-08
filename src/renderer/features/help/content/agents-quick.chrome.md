# Quick agents

Quick agents run one task and stop. They don't keep a branch or any state between runs.

## Starting one

The quickest way is the project's start page:

1. Select the project's name in the sidebar to open its start page.
2. Type what the agent should do.
3. Pick **Runs on** and **Model** if you want something other than the defaults.
4. Press `⌘Enter` or click **Start**.

You can also press `⌘N` to open **New agent** with **Quick** selected. `⇧⌘N` selects **Durable** instead. On Windows and Linux, use `Ctrl` in place of `⌘`. These are the default bindings; you can change them in **Settings > Keyboard shortcuts**.

For more options, click **New** at the top of the sidebar and choose **Quick agent…**. That dialog adds:

- **Parent agent**, to inherit a durable agent's quick agent defaults and work in its worktree;
- **Access**, how much the agent may do without asking;
- a **Project** picker, when you start it from outside a project.

## Access

**Access** is the level the agent starts at. New quick agents start at **Default access** in **Settings > Agents & providers**, and you can pick another level in the dialog.

| Level | What the agent does |
|-------|---------------------|
| **Plan** | Reads and plans. Makes no changes. |
| **Ask first** | Asks before edits and commands. |
| **Auto-accept edits** | Makes file edits without asking. Asks before commands. |
| **Auto** | A check decides what needs your approval. It can be wrong. |
| **Full access** | Runs everything without asking. |

Each CLI only lists the levels it can start at. Claude Code has all five. In the terminal, Codex CLI has Ask first, Auto and Full access, and Copilot CLI has Ask first and Full access. In chat, each CLI offers the levels its chat connection supports. A quick agent with a parent agent takes the level from the parent's **Quick agents** settings, or the parent's own level when those don't set one. See **Durable agents** for more.

A quick agent's CLI gets a few tools allowed ahead of time, and for Claude Code they follow its level. At Plan and Ask first only tools that read files are allowed ahead, so in a terminal it asks before any edit or command. At Auto-accept edits, file edits are allowed too. At Auto and Full access, the usual git, npm and npx commands are as well. A headless run can't ask: below Full access a check decides what it may do, and it can be wrong. Copilot runs a quick agent in the terminal in one go and can't ask either, so it keeps its usual tools at every level. A CLI with no Plan start mode (Codex and Copilot in a terminal) starts a Plan quick agent at Ask first.

## Headless or interactive

| | Headless | Interactive |
|-|----------|-------------|
| **Permissions** | The agent goes ahead on its own | It stops to ask each time |
| **File edits and commands** | Applied right away | Need your approval |
| **Speed** | Faster | Slower, since it waits for you |

Set it with **Default quick agent mode** in **Settings > Agents & providers**, or **Quick agent mode** in a project's own **Agents & providers** page. Headless and Access are separate settings.

## When it finishes

Finished quick agents wait for you in two places: the project's start page, under **Finished, waiting on you**, and the **N finished quick agents** row under the project in the sidebar. Open one to see its summary card:

- whether it succeeded, with its exit code;
- its orchestrator and model, and a **Headless** tag if it ran headless;
- what it reported back when it finished;
- how long it ran and which tools it used;
- the files it modified.

For a headless quick agent, the card can also show its transcript. See **CLI and transcripts**.

**Dismiss** removes one when you're done. **Clear all**, on the start page and on the sidebar row, removes every finished quick agent in the project.
