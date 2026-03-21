# Contributing to Clubhouse

Thanks for your interest in contributing! This guide covers the essentials for getting started.

Before diving in, read [PRINCIPLES.md](PRINCIPLES.md) — it describes the values that guide what goes where and how contributions are evaluated.

## Development Setup

**Prerequisites:** Node.js 22+, npm, Git

```bash
git clone https://github.com/Agent-Clubhouse/Clubhouse.git
cd Clubhouse
npm install
npm start  # Launches dev mode with hot reload
```

### Platform Notes

- **macOS:** Xcode Command Line Tools required (`xcode-select --install`). Full support including code signing and notarization (requires Apple Developer credentials for distribution builds).
- **Windows:** Visual Studio Build Tools with the "Desktop development with C++" workload (for `node-pty` and other native modules). The `postinstall` script handles native module setup automatically.
- **Linux:** Install `build-essential`, `python3` for native compilation. For packaging: `dpkg`, `fakeroot`, `rpm`. For E2E tests: `xvfb` (virtual display).

## Project Structure

```
src/
  main/       # Electron main process — services, IPC handlers, orchestrator providers
  renderer/   # React UI — features, stores, plugins, panels
  preload/    # Context-isolated IPC bridge (window.clubhouse API)
  shared/     # Types and utilities shared across processes
```

## Code Style

- TypeScript strict mode throughout
- ESLint for linting: `npm run lint`
- No Prettier — follow existing formatting conventions in the file you're editing

## Git Workflow

1. Fork the repository
2. Create a feature branch from `main`: `git checkout -b my-feature`
3. Make your changes with clear, descriptive commit messages
4. Push to your fork and open a pull request against `main`

### Commit Messages

Use conventional-ish messages — the prefix matters, the format is flexible:

- `feat:` new functionality
- `fix:` bug fixes
- `chore:` maintenance, deps, CI
- `refactor:` code changes that don't add features or fix bugs
- `test:` adding or updating tests
- `docs:` documentation changes

## Testing

Every PR must include tests. See [Principle 2](PRINCIPLES.md#principle-2-extreme-bias-for-test-coverage) for the full rationale.

```bash
npm test                 # All unit + component tests (Vitest)
npm run test:unit        # Main + shared unit tests
npm run test:components  # React component tests (jsdom)
npm run test:e2e         # Playwright E2E tests (requires packaged app)
npm run typecheck        # TypeScript type checking
npm run lint             # ESLint
npm run validate         # Full pipeline: typecheck → test → make → e2e
```

**E2E tests** run Playwright against the packaged Electron app. You need to `npm run package` first, or use `npm run validate` which handles the full sequence.

**On Linux**, E2E tests require a virtual display:

```bash
xvfb-run --auto-servernum npx playwright test
```

All PRs must pass `npm run typecheck` and `npm test`. The CI workflow runs these on macOS, Windows, and Linux automatically.

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Add tests for new functionality
- If your PR modifies the plugin API surface (`src/shared/plugin-types.ts`), the CI will flag it for review

## Reporting Bugs

Open an issue with:

- Steps to reproduce
- Expected vs actual behavior
- OS and Clubhouse version
- Relevant logs (View > Toggle Developer Tools > Console)

## Feature Requests

Open an issue describing the use case. Explain the problem you're solving, not just the solution you want. Consider whether the feature belongs in core or in a plugin — see [Principle 3](PRINCIPLES.md#principle-3-opinions-are-opt-in) and [Principle 4](PRINCIPLES.md#principle-4-change-at-the-least-obtrusive-layer).

## Plugin Development

Clubhouse has a plugin API for extending functionality. Current supported API versions: `0.5`, `0.6`, `0.7`, `0.8`. See the [Plugin System](https://github.com/Agent-Clubhouse/Clubhouse/wiki/Plugin-System) wiki page for the full API reference, manifest format, and permissions model.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
