# Clubhouse

A desktop app for managing AI coding agents across your projects. Run multiple agents side-by-side with a split-pane workspace, integrated terminals, file browsing, automation scheduling, and a plugin system that makes it all extensible.

Clubhouse wraps CLI-based coding agents (Claude Code, GitHub Copilot CLI, OpenCode) in a native Electron shell, giving you a unified interface to spawn, monitor, and manage them across all your projects simultaneously.

## Key Features

- **Multi-agent workspace** — Run durable (long-lived) and quick (one-shot) agents per project, view them in a split-pane Hub
- **Orchestrator abstraction** — Swap between Claude Code, GitHub Copilot CLI, and OpenCode with a unified provider interface
- **Headless mode** — Run quick agents without a terminal, parsing structured JSON output for cost, duration, and transcript data
- **Live agent status** — Hook events from running agents surface real-time tool usage, permission requests, and errors
- **Built-in plugins** — Hub (split-pane workspace), Files (Monaco editor + file browser), Terminal (project shell), Automations (cron scheduling), Issues (GitHub integration), Wiki (markdown docs)
- **Plugin API (v0.5)** — Build community plugins with access to files, git, agents, terminals, storage, and UI widgets
- **Git integration** — Branch management, staging, diffs, and per-agent git worktrees for isolated development
- **Theming** — 8 built-in themes (Catppuccin Mocha, Nord, Dracula, Tokyo Night, and more)
- **Notifications** — Configurable desktop alerts for agent idle, completion, permission requests, and errors

## Quick Start

```bash
npm install
npm start        # Development mode with hot reload
```

## Building

```bash
npm run make     # Build distributable installer
npm run package  # Package only (creates .app without installer)
```

The packaged `.app` will be in `out/Clubhouse-darwin-arm64/` (or `x64`). The `make` output goes to `out/make/`.

## Testing

```bash
npm test              # All tests (Vitest)
npm run test:unit     # Main + shared unit tests
npm run test:components  # React component tests
npm run test:e2e      # Playwright E2E tests
npm run typecheck     # TypeScript type checking
npm run validate      # Full pipeline: typecheck + test + make + e2e
```

## Extensibility Principles

Clubhouse is designed around the idea that opinionated workflows belong in plugins, not in the core. Three principles guide what goes where:

1. **Opinions are opt-in.** The core host provides capabilities (run agents, manage files, access git) without assuming how you use them. Opinionated workflows — review flows, auto-organization, approval gates — are plugins that users choose to enable.

2. **Change at the least obtrusive layer.** Default to the outermost layer that can support a change: community plugin > core plugin > plugin API > core feature > app host. The further inward, the higher the burden of proof.

3. **Explicit support, no silent regression.** Supported plugin API versions are fully tested and guaranteed. Unsupported versions are rejected at load time. No quiet breakage.

The test for any feature: *would a reasonable user want to turn this off?* If yes, it's a plugin. See the [full principles](https://github.com/Agent-Clubhouse/Clubhouse/wiki/Extensibility-Principles) in the wiki.

## Architecture

Clubhouse is an Electron app with a clean separation between processes:

```
src/
  main/           # Electron main process — services, IPC handlers, orchestrator providers
  renderer/       # React UI — features, stores, plugins, panels
  preload/        # Context-isolated IPC bridge (window.clubhouse API)
  shared/         # Types and utilities shared across processes
```

The **orchestrator system** abstracts CLI-specific logic behind a provider interface, so adding support for a new coding agent CLI requires implementing a single `OrchestratorProvider`. The **plugin system** exposes a rich API for building custom tabs, commands, and integrations.

See the [Wiki](https://github.com/Agent-Clubhouse/Clubhouse/wiki) for detailed developer documentation:

- [Architecture](https://github.com/Agent-Clubhouse/Clubhouse/wiki/Architecture) — Process model, IPC, services, and data flow
- [Orchestrator System](https://github.com/Agent-Clubhouse/Clubhouse/wiki/Orchestrator-System) — Provider interface, registry, and built-in providers
- [Plugin System](https://github.com/Agent-Clubhouse/Clubhouse/wiki/Plugin-System) — API reference, manifest format, permissions, and built-in plugins
- [Agent Lifecycle](https://github.com/Agent-Clubhouse/Clubhouse/wiki/Agent-Lifecycle) — Durable vs quick agents, spawn modes, hooks, and deletion
- [Development Guide](https://github.com/Agent-Clubhouse/Clubhouse/wiki/Development-Guide) — Setup, build, test, and project conventions

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop framework | Electron 40 |
| UI | React 19, Tailwind CSS 4 |
| State management | Zustand 5 |
| Code editor | Monaco Editor |
| Terminal | xterm.js 6 + node-pty |
| Build tooling | Electron Forge, Webpack, TypeScript 5.9 |
| Testing | Vitest, Playwright |
| Markdown | marked + highlight.js |

## License

MIT
