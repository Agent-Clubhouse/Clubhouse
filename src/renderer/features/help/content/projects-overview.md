# Projects

A **project** in Clubhouse represents a folder on your machine — typically a Git repository — that serves as the workspace for your AI coding agents. Projects are the primary organizational unit in Clubhouse: everything you do, from launching agents to configuring plugins, happens within the context of a project.

## What Is a Project?

At its core, a project is simply a directory on your local filesystem. In most cases this will be a Git repository, but Clubhouse does not require Git. When you add a folder as a project, Clubhouse treats it as the root of all agent activity: file reads and writes, terminal commands, and Git operations are all scoped to that directory.

Clubhouse creates a `.clubhouse/` directory inside the project root to store its own configuration and state. This includes:

- **Agent definitions** — names, colors, branches, and other metadata for your durable agents
- **Skills** — custom skill scripts and configuration files
- **Templates** — reusable mission templates for agents
- **Instructions** — project-level instructions (such as a `CLAUDE.md` file) that guide agent behavior
- **Plugin configs** — per-project plugin enablement and settings

The `.clubhouse/` directory is safe to commit to version control if you want to share project configuration with your team, or you can add it to `.gitignore` if you prefer to keep it local.

## Adding a Project

To add a new project:

1. Click the `+` button at the bottom of the **Project Rail** (the vertical icon bar on the far left of the window).
2. A system file picker dialog will open. Navigate to the folder you want to add and select it.
3. Clubhouse will automatically detect:
   - The **project name** from the folder name (e.g., a folder called `my-app` becomes the project name "my-app").
   - **Git configuration**, if present — including the current branch, remotes, and repository status.
4. The project appears as a new icon in the Project Rail, ready for use.

There is no limit to the number of projects you can add. You can add any folder, whether it is a new empty directory, an existing codebase, or a monorepo.

## The Project Rail

The **Project Rail** is the vertical sidebar on the left edge of the Clubhouse window. Each project you have added is represented by an icon in this rail.

### Switching Projects

Click any project icon in the rail to switch to that project. The main content area — including the agent explorer, terminal views, and Git status — will update to reflect the selected project.

### Reordering Projects

Drag and drop project icons within the rail to reorder them. The order is saved automatically and persists across app restarts. Place your most-used projects at the top for quick access.

### Project Icon Appearance

By default, each project icon displays the first letter of the project name, styled with the project's accent color. You can customize both the color and the icon image in Project Settings (see the [Project Settings](projects-settings) help topic for details).

## Working with Multiple Projects

Clubhouse is designed for multi-project workflows. You can have many projects open at the same time, and each one is fully independent:

- **Agents** — Each project maintains its own set of durable and quick agents. Agents in one project cannot access or modify files in another project.
- **Plugin configurations** — Plugins can be enabled or disabled on a per-project basis. A plugin that is active in one project may be turned off in another.
- **Git state** — Each project tracks its own Git branch, staged files, stash count, and remote status independently.
- **Worktrees** — Durable agents within a project can each have their own Git worktree and branch, providing full isolation for parallel development.

Switching between projects is instant. Clubhouse preserves the state of each project — including which agent is selected and the scroll position of terminal output — so you can pick up exactly where you left off.

## The .clubhouse/ Directory

When you first interact with a project (for example, by creating an agent), Clubhouse creates a `.clubhouse/` directory at the project root. This directory is the single location for all Clubhouse-specific data tied to that project.

### Directory Structure

| Path | Purpose |
|------|---------|
| `.clubhouse/agents/` | Agent definitions and per-agent configuration |
| `.clubhouse/skills/` | Custom skill scripts available to agents in this project |
| `.clubhouse/templates/` | Reusable mission templates |
| `.clubhouse/instructions/` | Project-level instruction files for agent guidance |

### Important Notes

- Clubhouse will never modify your source files outside of agent-driven actions that you initiate. The `.clubhouse/` directory is the only location Clubhouse writes to on its own.
- Deleting the `.clubhouse/` directory resets all Clubhouse configuration for that project. Agents, skills, templates, and instructions will be lost. Your source code is not affected.
- If you share a repository with teammates who also use Clubhouse, committing `.clubhouse/` allows you to share agent definitions, instructions, and templates across the team.
