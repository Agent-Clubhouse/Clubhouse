# Chat launch environment regression plan

Problem: a packaged app can find an absolute Codex launcher but its inherited
PATH cannot resolve the launcher's `env node` interpreter. Chat probes and
sessions must use the same shell environment as terminal launches.

Acceptance cases:

- With a minimal app PATH and no profile, a real `#!/usr/bin/env node` fake
  Codex CLI completes both the probe and session start using the shell PATH.
- Profile overrides take precedence over shell values without dropping HOME,
  PATH or unrelated shell variables. Inherited Claude nesting markers are
  removed, and session-only Clubhouse variables remain available at start.
- Probe caching and driver health use the effective launch environment, so
  changing PATH retries a previously failing/paused configuration.
- Command prefixes still reach probes and sessions.
- A missing Node interpreter yields an actionable fallback, with bounded
  failure categories for spawn, process exit, timeout and protocol errors.
- Each actual failed probe records driver, binary, duration and error locally.
  Remote telemetry contains only declared driver/error categories, with no
  paths, stderr, environment values or error text. Shared probes log once.
- Existing terminal fallback, pause behavior and successful probe caching
  remain covered by their current tests.

Validation: targeted regression suites, TypeScript checking, full tests, lint,
and Electron packaging (this repository has no `build` npm script; CI builds
with `electron-forge package`). No real model requests are needed.
