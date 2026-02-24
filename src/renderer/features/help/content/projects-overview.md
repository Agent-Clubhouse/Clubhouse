# Managing Projects

A project is a folder on your machine — typically a Git repo — that serves as the workspace for your agents.

## Adding a Project

1. Click `+` in the Project Rail (or `Cmd+Shift+O`)
2. Select a folder in the file picker
3. Clubhouse auto-detects the project name and Git configuration

Add as many projects as you need. Each is fully independent — its own agents, plugins, Git state, and settings.

## The Project Rail

- **Switch** — Click a project icon or press `Cmd+Option+1–9`
- **Reorder** — Drag and drop icons
- **Customize** — Change color, name, or icon in Project Settings

## The .clubhouse/ Directory

Clubhouse creates a `.clubhouse/` folder in your project root to store its configuration:

| Path | Contents |
|------|----------|
| `agents/` | Agent definitions and per-agent config |
| `skills/` | Custom skill scripts |
| `templates/` | Reusable agent templates |
| `instructions/` | Project-level instructions for agent behavior |

- Safe to commit to Git for team sharing, or add to `.gitignore` for local-only use
- Deleting `.clubhouse/` resets all Clubhouse config for that project (your source code is unaffected)
- Clubhouse never modifies your source files outside of agent-driven actions you initiate

## Dashboard View

Each project appears as a card on the Dashboard with agent status pills, quick-action buttons, and recent activity. See the **Dashboard** help topic for details.
