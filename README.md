# Clubhouse

A desktop app for managing AI coding agents across your projects. Clubhouse wraps CLI-based coding agents — Claude Code, GitHub Copilot CLI, OpenCode — in a native Electron shell with a unified interface to spawn, monitor, and orchestrate them across all your projects simultaneously.

## Philosophy

Three ideas shape how Clubhouse is built and how contributions are evaluated:

**Agent-first development.** Agents are first-class contributors. Each durable agent gets its own git worktree, standby branch, and isolated configuration. Agents branch, implement, validate, and open PRs — the same workflow a human follows. The codebase, tooling, and documentation should be equally useful to both human and agent contributors. See the [full principles](PRINCIPLES.md) for details.

**Extreme bias for test coverage.** Every PR must include tests. Unit and component tests run on all three platforms (macOS, Windows, Linux) in CI. End-to-end tests run Playwright against the packaged Electron app on every platform. The Annex dual-instance E2E suite launches two Clubhouse instances and tests real-time remote control over the local network. If a feature is hard to test, that is a design problem, not an excuse to skip tests.

**Opinions belong in plugins, not core.** The core host provides capabilities without assuming how you use them. Opinionated workflows — review flows, auto-organization, approval gates — are plugins that users choose to enable. The plugin API is versioned: new features land in the latest version, older versions are fully supported or cleanly dropped, never quietly broken. See [PRINCIPLES.md](PRINCIPLES.md) for the full extensibility contract.

## Building and Testing Locally

### Prerequisites

- **Node.js 22+** and **npm**
- **Git**
- **Platform-specific:**
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Windows:** Visual Studio Build Tools with the "Desktop development with C++" workload (for native module compilation). The `postinstall` script handles `node-pty` setup automatically.
  - **Linux:** `build-essential`, `python3`, `dpkg`, `fakeroot`, `rpm` (for packaging). E2E tests require `xvfb` for headless display.

### Setup

```bash
git clone https://github.com/Agent-Clubhouse/Clubhouse.git
cd Clubhouse
npm install
npm start          # Dev mode with hot reload
```

### Building

```bash
npm run package    # Package the app (no installer)
npm run make       # Build distributable installers
```

| Platform | Output | Location |
|----------|--------|----------|
| macOS | `.app`, `.zip`, `.dmg` | `out/make/` |
| Windows | Squirrel installer (`.exe`, `.nupkg`) | `out/make/squirrel.windows/` |
| Linux | `.deb`, `.rpm` | `out/make/deb/` and `out/make/rpm/` |

### Testing

```bash
npm test                 # All unit + component tests (Vitest)
npm run test:unit        # Main process + shared module tests
npm run test:components  # React component tests (jsdom)
npm run test:e2e         # E2E tests (Playwright, requires packaged app)
npm run typecheck        # TypeScript strict-mode type checking
npm run lint             # ESLint
npm run validate         # Full pipeline: typecheck → test → make → e2e
```

**Test projects in Vitest:**

| Project | Scope | Environment |
|---------|-------|-------------|
| `main` | `src/main/**/*.test.ts` | Node |
| `renderer` | `src/renderer/**/*.test.{ts,tsx}` | jsdom |
| `shared` | `src/shared/**/*.test.ts` | Node |
| `integration` | `test/**/*.test.ts` | Node |

**E2E notes:**
- E2E tests use Playwright against the packaged Electron app — run `npm run package` first, or use `npm run validate` which does it all.
- On Linux, E2E tests need a virtual display: `xvfb-run --auto-servernum npx playwright test`
- Annex dual-instance tests (in `e2e/annex-v2/`) launch two Clubhouse instances and test pairing, remote PTY, and lifecycle over loopback.

### CI

The `validate.yml` workflow runs on every PR to `main`:

- **Typecheck** — all three platforms
- **Unit + component tests** — all three platforms
- **E2E tests** — all three platforms (Linux uses `xvfb-run`)
- **Annex E2E tests** — all three platforms (separate job for dual-instance tests)
- **Linux package smoke test** — builds `.deb` and `.rpm`, verifies they exist
- **API surface check** — runs plugin API version contract tests; flags any PR that modifies `src/shared/plugin-types.ts`

## Architecture

```
src/
  main/           # Electron main process — services, IPC, orchestrators, MCP bridge
  renderer/       # React UI — features, stores, plugins, panels
  preload/        # Context-isolated IPC bridge (window.clubhouse API)
  shared/         # Types and utilities shared across processes
```

### Orchestrator system

The orchestrator layer abstracts CLI-specific logic behind a provider interface. Adding support for a new coding agent CLI means implementing a single `OrchestratorProvider`. Built-in providers: Claude Code, GitHub Copilot CLI, OpenCode.

Providers declare capabilities (headless mode, hooks, session resume, structured output) and Clubhouse adapts its spawn, monitoring, and communication behavior accordingly.

### Clubhouse MCP

The Clubhouse MCP system gives agents scoped access to interact with other parts of the app via the Model Context Protocol. When an agent is connected to a target — a browser widget, another agent, a terminal, or a group project — Clubhouse injects an MCP server that exposes context-appropriate tools.

Tool categories:
- **Browser tools** — navigate, screenshot, click, evaluate JavaScript in a Canvas browser widget
- **Agent tools** — send messages, read output, check status of other agents
- **Group project tools** — broadcast messages and coordinate across multi-agent project groups

Bindings are managed dynamically: connect a wire on the Canvas and the agent immediately gains MCP tools scoped to that target.

### Desktop remote control

Clubhouse instances on the same local network can pair for remote control. One instance runs as a **satellite** (being controlled), the other as a **controller**. Communication uses mutual TLS with Ed25519 identity and PIN-based pairing. The controller sees the satellite's projects and agents, can type in remote terminals, spawn and kill agents, and handle permission prompts — all peer-to-peer with no cloud dependency.

### Plugin system

Plugins extend Clubhouse with custom tabs, commands, themes, sounds, and agent configuration. The plugin API is permission-gated — plugins declare what they need (files, git, agents, terminal, etc.) and users approve at install time.

Current supported API versions: `0.5`, `0.6`, `0.7`, `0.8`. See [PRINCIPLES.md](PRINCIPLES.md) for the versioning contract.

Built-in plugins: Hub (split-pane agent workspace), Files (Monaco editor + file browser), Terminal, Canvas (visual wiring workspace), Sessions, Git, Browser, Review, Group Project.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop framework | Electron 40 |
| UI | React 19, Tailwind CSS 4 |
| State management | Zustand 5 |
| Code editor | Monaco Editor |
| Terminal | xterm.js 6 + node-pty |
| Canvas layout | ELK (elkjs) |
| Build tooling | Electron Forge, Webpack, TypeScript 5.9 |
| Testing | Vitest, Playwright |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup details, code style, and PR guidelines.

## Principles

See [PRINCIPLES.md](PRINCIPLES.md) for the full set of principles that guide development — agent-first workflows, test coverage expectations, and the extensibility contract.

## License

MIT — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for third-party licenses.
