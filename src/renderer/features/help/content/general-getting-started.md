# Getting Started

Welcome to Clubhouse — a desktop environment for managing AI coding agents.

## First Launch

When you first open Clubhouse, you'll see the **Home** dashboard. From here you can:

- **Add a project** by clicking the `+` button in the left rail
- Browse your existing projects and their agents
- Access settings via the gear icon

## Adding Your First Project

1. Click the `+` button in the Project Rail (left sidebar)
2. Select a folder on your machine — this becomes your project root
3. Clubhouse will detect Git configuration automatically
4. Your project appears as an icon in the rail

## Creating an Agent

Once you have a project selected:

1. Click **New Agent** in the agents explorer
2. Choose between a **Durable** agent (persistent, long-running) or a **Quick** agent (one-shot task)
3. Give your agent a mission and select a model
4. The agent will start working in the terminal view

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Project** | A folder on your machine, typically a Git repository |
| **Durable Agent** | A long-lived agent with its own worktree and branch |
| **Quick Agent** | A one-shot agent that runs a single task and exits |
| **Orchestrator** | The CLI backend that powers agents (e.g. Claude Code) |
