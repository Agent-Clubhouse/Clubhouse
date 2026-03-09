Issue #566 / M-15 Test Plan

Acceptance criteria
- Agent metadata is tracked through a single registry in `agent-system`.
- Agent metadata is removed on both explicit kill and natural exit paths.
- Headless and structured liveness checks defer to their managers instead of duplicate module-level sets.

Test cases
- PTY spawn stores project path, resolved orchestrator, and nonce in the registry.
- PTY exit callback restores config and removes tracked metadata.
- Headless exit callback restores config and removes tracked metadata.
- Structured exit callback removes tracked metadata.
- Kill path still uses the tracked orchestrator when choosing the provider exit command.
