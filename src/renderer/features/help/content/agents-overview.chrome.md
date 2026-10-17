# Agents

Agents are AI assistants that work on your code. Each one runs on an orchestrator, such as Claude Code, which talks to the model and carries out its tool calls.

## Two kinds

| Kind | Lifespan | Good for |
|------|----------|----------|
| **Durable** | Keeps its name, worktree and branch. Sleeps and wakes across restarts. | Feature branches, long refactors, ongoing work |
| **Quick** | Runs one task and stops | Bug fixes, small changes, questions |

## Agents in the sidebar

Each project lists its agents beneath it, one row per agent. Sleeping agents fold into one **N sleeping** row, and finished quick agents into **N finished quick agents**.

The dot at the start of a row is the agent's status:

| Status | Meaning |
|--------|---------|
| **Working** | Reading files, writing code or running commands |
| **Needs you** | Waiting for you to approve something |
| **Error** | Stopped by an error. Open it to see what happened. |
| **Idle** | Waiting for input |
| **Sleeping** | A durable agent that isn't running. Wake it any time. |
| **Starting** | Getting ready |

Agents that need you or hit an error also appear under **Needs you** at the top of the sidebar, so you don't have to look through every project.

Hover a row for details: the orchestrator and model, branch, worktree and MCP servers. The card also has **Open terminal**, **Stop** or **Wake**, and **Settings**.

## Row menu

Right-click a row, or use its **⋯** button, for:

- **Stop**, **Wake**, or **Wake & resume** to continue the last session;
- **Pop out**, which opens the agent in its own window and stays in sync with the main one;
- **Settings**, for a durable agent's name, model, instructions and more;
- **Apply persona…** and **Extract persona…**;
- **Delete** for a durable agent, or **Remove** for a quick one;
- **Move up** and **Move down**.

You can also drag rows to reorder agents within a project. The order is saved per project.

## Switching agents

Click a row, press `⌥⌘1` to `⌥⌘9` for the agents in sidebar order, or press `⌘K` and type `@` with part of the name.

## Models

Models come from the project's orchestrator. Change a durable agent's model in its settings. The change takes effect the next time it starts or wakes.
