# Getting Started

Welcome to Clubhouse -- a desktop environment for managing AI coding agents. Clubhouse lets you organize your software projects, launch AI agents to work on them, and monitor their progress in real time. Whether you need a long-running assistant for a complex feature or a quick one-shot task, Clubhouse provides the tools to manage it all from a single interface.

## First Launch

When you first open Clubhouse, you land on the **Home dashboard**. The Home dashboard provides an overview of all your projects and their agents. From here you can:

- See a summary of your registered projects and active agents
- Add new projects
- Jump into any project by clicking its icon in the Project Rail on the left
- Access application settings via the gear icon at the bottom of the Project Rail
- Open this help system via the `?` icon

## Adding Your First Project

A project in Clubhouse represents a folder on your machine, typically a Git repository.

1. Click the **+** button in the Project Rail (the leftmost column of the app).
2. A folder picker dialog opens. Select the root folder of your project.
3. Clubhouse detects the project name from the folder name and automatically identifies any Git configuration (branch, remotes, status).
4. The project appears as an icon in the Project Rail. Click it to switch to that project.

You can add as many projects as you need. Each project maintains its own set of agents, plugin configurations, and Git state independently.

## Creating Your First Agent

Once you have a project selected, you can create an agent to start working on it.

1. Open the **Agents** tab in the Explorer Rail (second column).
2. Click **New Agent**.
3. Choose an agent type:

| Type | Description |
|------|-------------|
| **Durable Agent** | A persistent, long-lived agent with its own name, color, Git worktree, and branch. Durable agents persist across app restarts and can be paused and resumed. Best for ongoing feature development, complex multi-step tasks, or work that spans multiple sessions. |
| **Quick Agent** | A one-shot agent that runs a single task and exits. Results are captured as a summary with a list of modified files. Quick agents appear as completed entries for review after they finish. Best for small fixes, code generation, or research tasks. |

## Giving the Agent a Mission

After choosing the agent type and configuring it:

1. Enter a **mission** -- a natural-language description of what you want the agent to accomplish (for example, "Refactor the authentication module to use JWT tokens").
2. Select a **model** from the available options. The models available depend on your orchestrator configuration and API keys.
3. Launch the agent. It begins working immediately, and its terminal output appears in the Main Content View (the largest pane on the right).

For durable agents, you can also configure a name, accent color, and a dedicated Git branch before launching.

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Project** | A folder on your machine, typically a Git repository. Each project has its own agents, plugins, and settings. |
| **Durable Agent** | A long-lived agent with its own name, color, Git worktree, and branch. It persists across app restarts and can be paused (sleeping) or resumed. |
| **Quick Agent** | A one-shot agent that runs a single task, produces a summary of its work, and exits. |
| **Orchestrator** | The CLI backend that powers agents (for example, Claude Code). The orchestrator handles communication between Clubhouse and the AI model. |
| **Plugin** | An extension that adds functionality to Clubhouse, such as file browsing, wiki pages, or kanban boards. Plugins can be app-scoped or project-scoped. |
| **Worktree** | A separate Git working directory linked to the same repository. Durable agents can use their own worktree so they work in isolation without affecting your main checkout. |

## Next Steps

- **Navigation** -- Learn how the multi-pane layout works and how to move between projects and views.
- **Keyboard Shortcuts** -- Discover shortcuts for common actions.
- **Projects** -- Dive deeper into project configuration, display names, colors, and custom icons.
- **Agents & Plugins** -- Explore agent lifecycle, orchestrator settings, and the plugin system.
- **Updates** -- Understand how Clubhouse keeps itself up to date.
