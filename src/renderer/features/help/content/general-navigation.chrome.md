# Navigation and layout

Clubhouse has three parts: the title bar, the sidebar and the pane. What you select in the sidebar opens in the pane.

## Title bar

The tabs belong to the active project: **Agents** first, then plugin tabs such as Terminal, Files and Git. `⌘1` to `⌘9` select them in order. Tabs that don't fit go in a **More** menu, and the tab you're on always stays visible. The breadcrumb on the right shows where you are.

The button at the left of the title bar shows or hides the sidebar (`⌘B`).

## Sidebar

From top to bottom:

- **Host**, once you've paired a satellite with Annex. It shows which machine you're looking at and switches between them.
- **Search** opens the command palette, and **New** starts an agent in the active project.
- **Canvas**, **Review** and other app-wide plugins.
- **Needs you** lists agents waiting on a permission or stopped by an error, across every connected host. It hides when nothing is waiting.
- **Projects** lists every project with its agents. Pinned projects come first, then the rest in your order, and projects you haven't touched for a while fold into one idle row.
- The footer has **Add project**, Help and Settings.

Inside a project, sleeping agents fold into one row, and so do finished quick agents. Click a project's name to open its start page, or the arrow beside it to collapse it. Drag a project to reorder it, or use **Move up** and **Move down** in its menu.

Drag the sidebar's right edge to resize it.

## Lists, Settings and Help in the sidebar

Some tabs have a list of their own, such as Files and Git. Opening one swaps the project tree for that list, with **Agents / Files** at the top. Settings and Help work the same way. Click **Agents**, press `Esc` in the sidebar, or press `⌘1` to get the tree back.

## Scope

The sidebar selection decides what Terminal, Files and Git point at. Select an agent and they open in its worktree. Select the project's name and they open at the project root.

## Moving around

| Action | Shortcut |
|--------|----------|
| Open the command palette | `⌘K` |
| Select a title-bar tab | `⌘1` to `⌘9` |
| Switch agent, in sidebar order | `⌥⌘1` to `⌥⌘9` |
| Show or hide the sidebar | `⌘B` |
| Open Settings | `⌘,` |
| Open Help | `⇧⌘/` |

Each project remembers its last tab and selected agent, so switching back picks up where you left off.
