# Clubhouse

A desktop app for managing AI coding agents across your projects. Run multiple agents side-by-side with integrated terminals, file browsing, git tools, notes, and scheduling.

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

### Package as .app (macOS)

```bash
# Package only (creates out/ directory with the .app)
npm run package

# Build distributable installer (ZIP on macOS)
npm run make
```

The packaged `.app` will be in `out/Clubhouse-darwin-arm64/` (or `x64` depending on your architecture). The `make` output goes to `out/make/`.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop framework | Electron 40 |
| UI | React 19, Tailwind CSS (Catppuccin Mocha theme) |
| State management | Zustand |
| Code editor | Monaco Editor |
| Terminal | xterm.js + node-pty |
| Build tooling | Electron Forge, Webpack, TypeScript |
| Testing | Vitest |
| Markdown | marked + highlight.js |

## Project Structure

```
src/
  main/           # Electron main process — IPC handlers, services, PTY management
  renderer/       # React UI — panels, features, stores, hooks
  preload/        # IPC bridge between main and renderer
  shared/         # Types, models, and utilities shared across processes
```

### Key Features

- Multi-project workspace with per-project agent configs
- Durable and quick (one-off) agents with terminal access
- Config inheritance system with override flags
- File browser and Monaco editor
- Git integration (status, log, diffs)
- Notes with send-to-agent
- Cron-based agent scheduling
- Hub / command center for quick operations
- MCP server support

## License

MIT
