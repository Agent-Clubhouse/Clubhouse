# Managing projects

A project is a folder on your machine, usually a Git repo, where your agents work.

## Adding a project

1. Click **Add project** at the bottom of the sidebar, or press `⇧⌘O`.
2. Pick a folder.
3. Clubhouse names the project after the folder and picks up its Git setup.

Each project is independent: its own agents, tabs, plugins and settings.

## Projects in the sidebar

Every project is listed under **Projects** with its agents beneath it.

- **Open** a project by clicking its name. With the Agents tab active, the pane shows its start page, where you can start a quick agent or wake a sleeping one.
- **Collapse** a project with the arrow beside its name. The button beside **Projects** collapses or expands all of them.
- **Pin** a project to keep it at the top. Pinned projects come first, then the rest in the order you've set.
- **Reorder** by dragging a project, or with **Move up** and **Move down** in its menu.
- **Idle projects**, unpinned ones with no activity for a while, fold into one row at the bottom. Set how long that takes in **Settings > Display & UI**.

Hover a project to see its buttons: pin, new agent and the menu, which also has **Project settings**.

To jump to a project from anywhere, press `⌘K` and type `/` with part of its name.

## The .clubhouse folder

Clubhouse keeps its configuration in a `.clubhouse/` folder in the project root:

| Path | Contents |
|------|----------|
| `agents.json` | Your durable agent definitions |
| `agents/` | Each durable agent's worktree, where its files and uncommitted work live |
| `settings.json` | Project settings |
| `skills/` | Custom skills |
| `personas/` | Personas you've saved |
| `missions/` | Mission files |
| `plugin-data/` | Data plugins store for this project |

Deleting `.clubhouse/`, which is what **Reset project** does, also deletes every durable agent's worktree in `agents/`. Anything an agent hasn't committed and pushed is lost. Your main checkout is not touched.

Clubhouse only changes your source files through agent work you start.
