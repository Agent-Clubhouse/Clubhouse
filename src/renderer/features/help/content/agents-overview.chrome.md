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

Hover a row for details: what it runs on and its model, its branch, worktree and MCP servers. The card also has **Stop** or **Wake** and **Settings**, plus **Open terminal** when the project has the Terminal plugin on.

## Row menu

Right-click a row, or use its **⋯** button, for:

- **Stop**, **Wake**, or **Wake & Resume** to continue the last session;
- **Pop Out**, which opens the agent in its own window and stays in sync with the main one;
- **Settings**, for a durable agent's name, model, instructions and more;
- **Delete** for a stopped durable agent, or **Remove** for a quick one that has stopped;
- **Move up** and **Move down**, which reorder durable agents within their project.

Agent rows can't be dragged. Only projects can.

## Switching agents

Click a row, press `⌥⌘1` to `⌥⌘9` for the agents in sidebar order, or press `⌘K` and type `@` with part of the name.

## Models

Models come from the project's orchestrator. Change a durable agent's model in its settings. The change takes effect the next time it starts or wakes.

## Agent details

Use **Details** beside the conversation or CLI view to open a column of collapsible cards. Several cards can be open at once.

**Settings** is always the first card, for both plain and Clubhouse managed agents. A managed agent shows its template, instructions, configured skills and MCP servers, runtime, model and context, with any changes waiting for its next start. **Open builder**, **Model and context** and **Restart** keep those controls within reach. Auto-sleep can change while a local chat agent is running or sleeping. Plain agents keep their own settings, and agents on another machine are read-only here.

Cards follow this order when available: Settings, Changes, the Dispatcher's named card, Orchestration, Subagents, Connections, Actions, Skills and MCP, Session and Canvases. **Clubhouse helpers** live inside Orchestration, with their approvals and lifecycle controls. **Subagents** are the provider's own reported subagents and remain a separate top-level accordion immediately after Orchestration.

**Skills and MCP** keeps read-only session evidence separate from Settings's configured content. It includes live MCP connections, sign-in requirements and failure reasons, and provider-reported skill names with their source, session and report time. A skill report is not proof of use. Unsupported and unknown reports say so. Sleeping agents have no live MCP list; an available last-session skill snapshot stays labeled as historical.

**Session** holds usage, plan limits, running time, folder and branch. **Context window** appears inside Session only when the runtime reports it, including whether the count covers input only. Sleeping agents show **Last session** instead, with no live context.

**Canvases** appears at the end only when a canvas contains this agent. **Jump** opens its card on that canvas. A request to open an empty Canvases section opens Session instead, or Actions for the Dispatcher.

Cards start collapsed. Settings remembers your choice across agents and visits; other cards keep their state only while visiting that agent. A waiting helper approval opens Orchestration once, both beside an awake agent and under a sleeping orchestrator's wake composer. You can close it again. Links to the former Helpers, Context window, MCP servers or Reported skills cards open their containing section. A link to an unavailable section falls back to Session, or Actions for the Dispatcher. The Dispatcher keeps only Settings, Actions and Connections.
