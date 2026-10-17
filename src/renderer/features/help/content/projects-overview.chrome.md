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
- **Pin** a project to keep it at the top. Pinned projects come first, then the rest by recent activity.
- **Reorder** by dragging a project, or with **Move up** and **Move down** in its menu.
- **Idle projects**, unpinned ones with no activity for a while, fold into one row at the bottom. Set how long that takes in **Settings > Display & UI**.

Hover a project to see its buttons: pin, new agent and the menu, which also has **Project settings**.

To jump to a project from anywhere, press `⌘K` and type `/` with part of its name.

## The .clubhouse folder

Clubhouse keeps its configuration in a `.clubhouse/` folder in the project root:

| Path | Contents |
|------|----------|
| `agents/` | Agent definitions and per-agent config |
| `skills/` | Custom skills |
| `templates/` | Reusable agent templates |
| `instructions/` | Project-level instructions for agents |

- Commit it to share the setup with your team, or add it to `.gitignore` to keep it local.
- Deleting `.clubhouse/` resets Clubhouse's config for the project. Your source code is not touched.
- Clubhouse only changes your source files through agent work you start.
