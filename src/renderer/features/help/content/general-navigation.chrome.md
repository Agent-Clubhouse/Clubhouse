# Navigation and layout

Clubhouse has a sidebar and a pane, with a title bar above them. What you select in the sidebar opens in the pane.

## Title bar

The tabs belong to the active project. **Agents** comes first, then plugin tabs such as Terminal, Files and Git. `⌘1` to `⌘9` select them in order. Tabs that don't fit go in a menu that lists them by recent use, and the tab you're on always stays visible. The breadcrumb shows where you are.

The New agent page, the Dispatcher, Settings, Help and app-wide views such as Canvas have no tabs.

The button at the left of the title bar shows or hides the sidebar (`⌘B`).

## Sidebar

From top to bottom:

- **Show**, once you've paired another computer with Annex Network. It narrows the sidebar to **All computers**, **This computer** or one of your other computers, and says whether each is connected.
- **Filter projects and agents** narrows the tree as you type. Enter opens the first match, and Esc clears it. With no match, **Search everything** opens the command palette with what you typed. The button beside it opens the command palette, and **New** starts a durable or quick agent.
- **Canvas**, **Review** and **Group Projects**, with other app-wide plugins under **More app views**.
- The **Dispatcher**, above every project. With Annex Network, each of your other computers' Dispatchers has a row too.
- **Needs you** lists what's waiting on you, across every connected computer. It hides when nothing is waiting.
- **Projects** lists every project with its agents.
- The footer has **Add project**, **Feedback** once it's set up, **Help** and **Settings**.

Drag the sidebar's right edge to resize it.

## Needs you

These land in **Needs you**, oldest first:

- an agent with a question for you, or one that needs permission to use a tool
- a tool call that failed, or an agent that stopped with an error
- a helper an orchestrator wants to start or delete, when you asked to approve that
- an agent asking for a Clubhouse permission set to Ask first

Each item clears by itself once it's handled. The Dispatcher's own requests, and approvals from your other computers, show on the Dispatcher's row. An item from another computer says which one.

## Projects

The **Order** menu at the top of the list sorts projects and agents separately, each in your manual order or most recent first. Drag projects and agents, or use **Move up** and **Move down**, while their order is manual. **Collapse all projects** and **Expand all projects** are beside it.

Pinned projects come first, then the rest. Projects you haven't used for a while fold into one **idle projects** row. Set when that happens with **Idle projects** in **Settings > Display & UI**.

Hover a project for **Pin to top**, **+** to start an agent in it, and its menu. The menu also has **Mark inactive**, **New agent…**, **Project settings** and **Close project**. With the same repository on two of your computers, **Merge with…** shows them as one project, and **Split per computer** separates them again. A project on another computer is named with that computer.

Inside a project, sleeping agents fold into a **sleeping** row. It closes again a few seconds after you move away. The pin beside it, **Keep open**, keeps it open for that project. Finished quick agents fold into their own row, with **Clear all**.

## Lists, Settings and Help in the sidebar

Some tabs have a list of their own, such as Files and Git. Opening one swaps the project tree for that list, with **Agents / Files** at the top. Settings and Help work the same way. Click **Agents**, press `Esc` in the sidebar, or press `⌘1` to get the tree back. **Needs you** shrinks to one line while a list fills the sidebar.

## What the tabs point at

The sidebar selection decides what Terminal, Files and Git point at. Select an agent and they open in its worktree. Select the project's name and they open at the project root. Picking another agent keeps you on the same tab.

## Agent details

**Details** beside an agent's conversation opens a column of cards, in this order when they apply: Settings, Changes, the Dispatcher's card, Orchestration, Subagents, Connections, Other machines, Actions, Skills and MCP, Session and Canvases. Press `⌥⌘D` to show or hide it. See [Agents](#help:agents-overview).

## Quick agents from anywhere

Press `⌘N` to give a quick agent a one-line job in the project you're looking at. **Details** in the prompt sets its project, CLI, model and access. See [Quick agents](#help:agents-quick).

## Windows

**Pop Out** in an agent's menu opens it in its own window, which stays in step with the main one. Each agent has one window, so asking again brings it to the front. The main pane then offers **Pop back in** and **Show window**. The Dispatcher can pop out its chat the same way.

## Moving around

| Action | Shortcut |
|--------|----------|
| Open the command palette | `⌘K` |
| Select a title-bar tab | `⌘1` to `⌘9` |
| Switch agent, in sidebar order | `⌥⌘1` to `⌥⌘9` |
| Show or hide agent details | `⌥⌘D` |
| Show or hide the sidebar | `⌘B` |
| Open Settings | `⌘,` |
| Open Help | `⇧⌘/` |

Each project remembers its last tab and selected agent, so switching back picks up where you left off.

## The classic layout

The layout from before 1.0, with its rail of projects and agent column, is still there for now. Turn on **Classic layout** in **Settings > Display & UI**, under **Layout**, and restart Clubhouse. The classic layout will go away in a future update.
