# Contributing to Clubhouse

Thanks for your interest in contributing! This guide covers the essentials for getting started.

## Development Setup

**Prerequisites:** Node.js 20+, npm, Git

```bash
git clone https://github.com/Agent-Clubhouse/Clubhouse.git
cd Clubhouse
npm install
npm start  # Launches dev mode with hot reload
```

### Platform Notes

- **macOS:** Full support including code signing and notarization (requires Apple Developer credentials for distribution builds)
- **Windows:** Full support. The `postinstall` script handles native module setup automatically.
- **Linux:** Builds via deb/rpm makers. Not actively tested but should work.

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

```bash
npm test                 # All tests (Vitest)
npm run test:unit        # Main + shared unit tests
npm run test:components  # React component tests
npm run test:e2e         # Playwright E2E tests
npm run typecheck        # TypeScript type checking
npm run validate         # Full pipeline: typecheck + test + make + e2e
```

All PRs must pass `npm run typecheck` and `npm test`. The CI workflow runs these automatically.

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

Open an issue describing the use case. Explain the problem you're solving, not just the solution you want.

## Plugin Development

Clubhouse has a plugin API (v0.5) for extending functionality. See the [Plugin System](https://github.com/Agent-Clubhouse/Clubhouse/wiki/Plugin-System) wiki page for the full API reference, manifest format, and permissions model.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
