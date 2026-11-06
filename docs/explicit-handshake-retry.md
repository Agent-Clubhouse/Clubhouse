# Explicit chat handshake retry

Agent Settings → General → Runtime offers **Retry handshake** for a local user.
It does not wake, restart or start a session. The result does not verify model
access, tools or credentials and is not a saved readiness flag.

The recovery gap is health backoff, not a cached failed probe. After three failures
a driver key is paused for 30 minutes. Its key includes driver, binary, environment
and Command prefix text, not the bytes of a sourced script. Repairing a script at
the same path can therefore leave the key paused. Normal failures and backoff are
unchanged; only the explicit action bypasses the relevant pause and success cache.
Concurrent checks still share the existing in-flight probe, and a failed retry
counts one failure. A successful policy-allowed check clears only its matching
failure key. Retry does not cache successful readiness.

Main resolves the registered project and durable agent, effective provider,
selected registered driver, binary, profile environment and prefix. The real
launch and retry share `resolveOrchestrator`, `resolveProfileEnv`,
`resolveCommandPrefix`, `chatLaunchEnvironment`, `resolveRuntimeMode` and
`resolveChatDriver`. The action accepts no renderer-provided binary, environment,
prefix or alternate driver.

Main revalidates the target, driver object, binary identity, environment, prefix,
worktree and agent lifecycle generation at probe dispatch and receipt. A stale
result is discarded without clearing failure state. Login required, version-policy
blocked, failed handshake, unavailable target and stale context are distinct from
a passed point-in-time check. No result changes saved settings or selects a
fallback driver. The UI rejects stale target replies and does not enable launch
based on this result. Changes to external script contents are not watched; a
passed handshake describes the check that actually ran, not future readiness.

Only a top frame of a local Clubhouse window can invoke this IPC. It is not
exposed through MCP, Annex or other agent control APIs. It injects no bridge or
materialized config and grants no new authority.

## No model request

The action calls only the registered driver's existing `probe`, never `start`:

| Driver | Probe protocol |
| --- | --- |
| Codex app-server | `initialize`, `initialized`, then kill; no thread/turn |
| ACP, including Copilot | `initialize`, then kill; no session/prompt |
| Claude stream-json / Agent SDK | Initialize transport, then close; no prompt |
| Copilot SDK | Connect, `getStatus` and `getAuthStatus`, then close; no session |

The Codex and ACP protocol tests assert the exact message list. Claude and
Copilot have synthetic probe tests too. Recovery regressions use temporary fake
binary files and a fake probe that reads a repaired fixture; no installed provider,
authentication or model is called. This shared path applies on all three platforms.

This is separate from model/auth refresh (#2786), automatic script watching and
MCP editor/delivery repair (#2849).
