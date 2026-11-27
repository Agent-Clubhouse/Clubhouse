# Getting started

Clubhouse runs AI coding agents on your projects. You add a project, start agents in it, and follow their work from one window.

## First steps

1. **Add a project.** Click **Add project** at the bottom of the sidebar and pick a folder, usually a Git repo. Before your first project, you can also drop a folder on the window.
2. **Start an agent.** Select the project in the sidebar. The pane shows a box for a quick agent. Describe the task and press `⌘Enter`, or press `⌘N` from anywhere. For longer work, click **New** at the top of the sidebar and choose **Durable agent…**.
3. **Follow along.** Agents appear under their project in the sidebar. A dot shows each one's status, and anything waiting on you moves to **Needs you**, above the projects.
4. **Review the result.** Finished quick agents wait under **Finished, waiting on you** on the project's start page, and in a row of their own in the sidebar, until you open or dismiss them.

The **Dispatcher**, at the top of the projects, is one agent for the whole app. Tell it what you want in plain words, and it works through your other agents. See [Dispatcher](#help:agents-dispatcher).

Press `⌘K` at any time to jump to an agent, a project or a setting.

## Key ideas

| Term | Meaning |
|------|---------|
| **Project** | A folder on your machine. Each has its own agents, tabs and settings. |
| **Durable agent** | A named agent that keeps its own worktree and branch, and survives restarts. Use it for work that spans sessions. |
| **Quick agent** | A one-off agent that runs a single task and stops. Use it for small fixes and questions. |
| **Runs on** | The CLI that runs an agent, such as Claude Code, GitHub Copilot CLI or Codex CLI. |
| **Orchestrator agent** | An agent that starts and manages helper agents. See [Orchestrated helpers](#help:agents-orchestrated-helpers). |
| **Plugin** | Adds a tab, a sidebar item or a tool, such as Files, Git or Canvas. |

## Next

- [Navigation and layout](#help:navigation) explains the sidebar, title bar and pane.
- [Keyboard shortcuts](#help:keyboard-shortcuts) lists the shortcuts for tabs and agents.
- [Command palette](#help:command-palette) covers `⌘K`.

If you used Clubhouse before 1.0, **Classic layout** in **Settings > Display & UI** brings back the old layout for now. It will go away in a future update.
