# Agents

Agents are AI assistants that work on your code. Each one runs on a CLI, such as Claude Code, which talks to the model and carries out its tool calls.

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
| **Needs you** | Waiting for you to approve something or answer a question |
| **Error** | Stopped by an error. Open it to see what happened. |
| **Idle** | Waiting for your next message |
| **Finished** | A quick agent whose run has ended |
| **Sleeping** | A durable agent that isn't running. Wake it any time. |
| **Starting** | Getting ready |

Approvals, questions and errors also appear under **Needs you** in the sidebar, so you don't have to look through every project.

Hover a row for details. **Runs on** shows the CLI and model the agent is using right now, then its branch, worktree, MCP servers and access, and which computer it's on. The card also has **Sleep** for a durable agent or **Stop** for a quick one, or **Wake & Resume**, and **Settings**, plus **Open terminal** when the project has the Terminal plugin on.

## Row menu

Right-click a row, or use its **⋯** button, for:

- **Sleep** for a running durable agent, or **Stop** for a quick one, and for a sleeping agent **Wake & Resume** to continue the last session or **Wake with a fresh session** to start over
- **Pop Out**, which opens the agent in its own window and stays in sync with the main one
- **Quick Agent**, to start a quick agent from this one
- **Settings**, for a durable agent's name, model, instructions and more
- **Restart** and **Restart with a new conversation**, for a running managed agent
- **Change CLI**, for an agent that couldn't start
- **Delete** for a sleeping durable agent, or **Remove** for a quick one that has stopped
- **Move up** and **Move down**, which reorder agents within their project

While agents are in manual order, you can also drag a row to reorder it.

## Switching agents

Click a row, press `⌥⌘1` to `⌥⌘9` for the agents in sidebar order, or press `⌘K` and type `@` with part of the name.

## Models

Models come from the agent's CLI. Change a durable agent's model in its settings. The change takes effect the next time it starts or wakes.

## Agent details

Use **Details** beside the conversation or CLI view to open a column of collapsible cards. Several cards can be open at once.

**Settings** is always the first card, for both plain and Clubhouse managed agents. A managed agent shows its template, instructions, configured skills and MCP servers, runtime, model and context, with any changes waiting for its next start. **Open builder**, **Model and context** and **Restart** keep those controls within reach. Auto-sleep can change while a local chat agent is running or sleeping. Plain agents keep their own settings, and agents on another machine are read-only here.

Cards follow this order when available: Settings, Changes, the Dispatcher's named card, Orchestration, Subagents, Connections, Other machines, Actions, Skills and MCP, Session and Canvases. Press `⌥⌘D` to show or hide Details. **Clubhouse helpers** live inside Orchestration, with their approvals and lifecycle controls. **Subagents** are the provider's own reported subagents and remain a separate top-level accordion immediately after Orchestration.

**Skills and MCP** keeps read-only session evidence separate from Settings's configured content. It includes live MCP connections, sign-in requirements and failure reasons, provider-reported skill names with their source, session and report time, and the skills Clubhouse installed from the agent's setup. A skill report is not proof of use. With no report and nothing installed by Clubhouse, the skills section is left out. The Dispatcher's own connection is in its card, not repeated here. Sleeping agents have no live MCP list; an available last-session skill snapshot stays labeled as historical.

**Session** holds usage, plan limits, running time, folder and branch. **Context window** appears inside Session only when the runtime reports it, including whether the count covers input only. Sleeping agents show **Last session** instead, with no live context.

**Canvases** appears at the end only when a canvas contains this agent. **Jump** opens its card on that canvas. A request to open an empty Canvases section opens Session instead, or Actions for the Dispatcher.

Cards start collapsed. Settings remembers your choice across agents and visits; other cards keep their state only while visiting that agent. A waiting helper approval opens Orchestration once, both beside an awake agent and under a sleeping orchestrator's wake composer. You can close it again. Links to the former Helpers, Context window, MCP servers or Reported skills cards open their containing section. A link to an unavailable section falls back to Session, or Actions for the Dispatcher. The Dispatcher keeps only Settings, Actions and Connections, plus Other machines when you have other computers.
