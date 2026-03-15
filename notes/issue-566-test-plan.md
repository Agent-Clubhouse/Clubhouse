Issue #566 / M-15 Test Plan

Acceptance criteria
- Agent lifecycle metadata is owned by a single registry in `agent-system`.
- Agent registry entries are removed on both natural exit and explicit kill paths.
- Kill routing uses the registry's recorded runtime before falling back to manager-local liveness checks.

Test cases
- PTY spawn stores project path, resolved orchestrator, runtime, and nonce in the registry.
- PTY, headless, and structured exit callbacks all remove tracked metadata.
- Killing a tracked headless or structured agent still routes to the correct manager even if that manager's own lookup is stale.
- PTY kill continues to use the tracked orchestrator when selecting the provider exit command.
