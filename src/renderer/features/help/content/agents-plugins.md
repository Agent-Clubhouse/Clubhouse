# Plugins

Clubhouse's plugin system extends the app with custom views, commands, and integrations.

## Plugin Scopes

| Scope | Description |
|-------|-------------|
| **Project** | Activated per-project, appears as a tab in the Explorer Rail |
| **App** | Global plugins that appear in the Project Rail |
| **Dual** | Can run in both project and app contexts |

## Built-in Plugins

Clubhouse ships with several built-in plugins:

- **Hub** — A dual-scoped agent monitoring dashboard
- **Terminal** — A project-scoped terminal emulator

## Enabling Plugins

Plugins can be enabled at two levels:

- **App-level** — Enabled globally in Settings > Plugins
- **Project-level** — Enabled per-project in project settings

A plugin must be enabled at the appropriate level to appear in the UI.

## Plugin API

Plugins interact with Clubhouse through a versioned API that provides:

- **Project API** — Read/write files, list directories
- **Git API** — Check status, log, branches
- **Agents API** — List, spawn, and monitor agents
- **UI API** — Show notifications, confirmations, input prompts
- **Storage API** — Persist data at project or global scope
- **Terminal API** — Spawn and manage shell sessions
- **Navigation API** — Focus agents, switch tabs

## Creating a Plugin

A plugin is a directory with a `plugin.json` manifest and an optional `main.js` entry point. See the built-in plugins for examples.
