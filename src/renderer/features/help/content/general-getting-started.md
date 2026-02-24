# Getting Started

Clubhouse is a desktop environment for managing AI coding agents. You organize projects, launch agents, and monitor their work from one interface.

## First Launch

On first launch, a short onboarding flow appears based on your experience level. After that, you land on the **Dashboard** — your home screen for all projects and agents.

## Quick Start

1. **Add a project** — Click `+` in the Project Rail (left sidebar) and select a folder.
2. **Create an agent** — Open the Agents tab, click **New Agent**, and choose Durable or Quick.
3. **Give it a mission** — Describe what you want in natural language (e.g., *"Add input validation to the signup form"*).
4. **Monitor progress** — Watch real-time terminal output, approve permissions, and review results.

> **Tip:** Use `Cmd+K` to open the Command Palette — the fastest way to navigate anywhere in the app.

## Key Concepts

| Concept | What It Is |
|---------|-----------|
| **Project** | A folder on your machine (usually a Git repo). Each has its own agents, plugins, and settings. |
| **Durable Agent** | A persistent agent with its own Git worktree and branch. Survives restarts. Best for complex, multi-session work. |
| **Quick Agent** | A one-shot agent that runs a single task and exits. Best for small fixes and quick questions. |
| **Orchestrator** | The CLI backend powering agents (e.g., Claude Code, Copilot CLI). Handles AI communication. |
| **Plugin** | An extension adding features like file browsing, Hub workspaces, or custom tools. |
| **Hub** | A split-pane workspace for monitoring multiple agents side-by-side. |

## Next Steps

- **Dashboard** — Learn about the home screen overview
- **Command Palette** — Master the `Cmd+K` launcher
- **Hub & Workspaces** — Set up multi-agent monitoring
- **Keyboard Shortcuts** — Speed up your workflow
