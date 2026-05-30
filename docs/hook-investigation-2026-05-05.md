# Hook Integration Investigation — Claude Code vs Copilot CLI vs Codex CLI

**Date:** 2026-05-05
**Author:** faithful-urchin
**Context:** Triggered by a stuck-state bug on a local GHCP agent (`lucky-mantis`) where the `permissionRequest` hook timed out after 120s and the agent stalled. Root cause and fixes shipped in PR `faithful-urchin/hook-resilience`. This report covers the gap analysis the user asked for, separately from the code changes — to inform follow-up work as GitHub Copilot CLI moves from beta to GA and a large user base migrates from Claude Code → GHCP.

---

## 1. Root cause recap

**Symmetric 120s timeout race.** GHCP's `permissionRequest` hook config had `timeoutSec: 120` (set in `copilot-cli-provider.ts:244`). Our permission queue also resolved at exactly `120_000` ms (`hook-server.ts:115`). Both expired at the same instant — GHCP killed the curl child *before* our `decision.then(...)` callback wrote the `'ask'` fallback response. From GHCP's POV the hook returned nothing → fell through to its own TUI prompt UI in a hidden PTY → agent stalled with no human watching.

**Fixed in this PR** by:
- Plumbing a shared `PERMISSION_HOOK_TIMEOUT_SEC = 120` constant through all three providers and deriving `PERMISSION_QUEUE_TIMEOUT_MS = 110_000` (10s safety margin) for the queue. Queue now resolves before the orchestrator times out.
- Adding `core:hook-server` and `core:permission-queue` lifecycle logging at INFO/WARN (the bug was effectively invisible in logs before).
- Adding a settings toggle to disable the hook server entirely as a durable escape hatch.

The `'timeout' → 'ask'` fallback semantic was kept per user direction — interactive PTYs can still recover by responding to the prompt.

---

## 2. Hook event coverage — provider matrix

| Normalized kind     | Claude Code event           | Copilot CLI event       | Codex CLI event             |
|---------------------|-----------------------------|-------------------------|-----------------------------|
| `pre_tool`          | `PreToolUse`                | `preToolUse`            | `PreToolUse`                |
| `post_tool`         | `PostToolUse`               | `postToolUse`           | `PostToolUse`               |
| `tool_error`        | `PostToolUseFailure`        | `errorOccurred`         | `PostToolUseFailure`        |
| `stop`              | `Stop`                      | — (no equivalent)       | `Stop`                      |
| `notification`      | `Notification`              | `sessionStart`, `userPromptSubmitted` (both mapped → notification) | `Notification` |
| `permission_request`| `PermissionRequest`         | `permissionRequest`     | `PermissionRequest`         |

**Observations:**

1. **GHCP has no `Stop` equivalent.** Claude Code and Codex emit a `Stop` hook when the model finishes its response cycle; GHCP does not. We currently lose the per-cycle "agent went idle" signal for GHCP. Two GHCP events (`sessionStart`, `userPromptSubmitted`) are crammed into our `notification` bucket — they're roughly informational but the loss of cycle-end is real.

2. **GHCP event-name casing differs.** All three CLIs use snake_case for `hook_event_name` in stdin payloads, but **GHCP uses camelCase event names** (`preToolUse` not `PreToolUse`). The hook config writers and `EVENT_NAME_MAP` per provider already handle this; just calling it out for future event additions.

3. **GHCP doesn't include `hook_event_name` in stdin** for some hooks — our hook server compensates by injecting from the URL path (`/hook/{agentId}/{eventHint}`). This mismatch is documented in `hook-server.ts:171-174`.

4. **All three use 5s timeout for non-permission hooks**, 120s for `permissionRequest`. After this PR, the 120s value is shared via `PERMISSION_HOOK_TIMEOUT_SEC`; the 5s values remain hardcoded per-provider (low risk — no permission queue race for those).

---

## 3. Hook lifecycle differences

### Claude Code
- Reads `.claude/settings.local.json` at session start.
- Session resume (`--resume`) re-reads the file.
- No internal "workspace recycling" inside a single CLI process — process lifecycle is 1:1 with hook config reload.

### GHCP (Copilot CLI)
- Reads `.github/hooks/hooks.json` at session start.
- **Internal workspace recycling**: a single CLI process can close and re-init workspaces (we observed it in `lucky-mantis`'s log: `Closing session c1b73d32...` → `Workspace initialized: 137768d6...` 2.5 days later, same process). Whether the hook config is re-read at workspace re-init is **undocumented** and a meaningful unknown for long-running agents. See draft upstream issue below.
- `--continue` resumes the most recent session. Hook config behavior on `--continue` is the same — but if Clubhouse code changed between sessions, the on-disk hook config might be different than what GHCP cached in memory.

**Mitigation already in place**: `agent-system.ts:337` calls `provider.writeHooksConfig()` on every spawn, and each provider's writeHooksConfig strips and replaces stale Clubhouse entries via `isClubhouseHookEntry`. So the on-disk config is always fresh on spawn. The risk window is purely *during* a long-running CLI session that internally re-uses without a process restart — which is more theoretical than observed for now.

### Codex CLI
- Reads `.codex/hooks.json` at session start. Same shape as Claude Code. No known internal workspace recycling concern.

---

## 4. `permissionDecision` semantics

Per [GitHub Copilot CLI hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference), valid values are `"allow"`, `"deny"`, and `"ask"`. The docs define:
- `"allow"` — short-circuits permission flow, tool runs.
- `"deny"` — short-circuits, tool is rejected with "Permission Denied" feedback.
- `"ask"` — falls through to interactive user prompt in the PTY.

**Edge cases the public docs do not address:**
- What happens on hook timeout? Documented behavior for non-permission hooks is "fire-and-forget; never blocks." For `permissionRequest`, undocumented. Empirically (per `lucky-mantis` log) GHCP records `Hook execution failed: Error: Hook command timed out after 120 seconds` and falls through to its own UI — same path as `"ask"`.
- What happens on unrecognized values? Undocumented. We were not testing this; safe to assume unrecognized → falls through to default behavior.

**Claude Code** uses identical semantics for the three values per its docs.

**Codex CLI** is undocumented at this level; the EVENT_NAME_MAP and hook shape mirror Claude Code so we assume parity.

---

## 5. Known upstream issues we're exposed to

### `github/copilot-cli` #2586 — "Notification hook fires for already-approved tools in interactive mode"
The Notification hook fires asynchronously and does NOT correspond 1:1 to actual permission state. Our renderer uses Notification events for status-tracking heuristics — there's a soft risk of UI showing "needs permission" when the tool is actually already approved. Low impact today (we don't auto-act on those), but worth tracking if we expand.

### `github/copilot-cli` #1651 — "Add hook for permission prompt"
Already resolved — the `permissionRequest` hook this PR depends on. Mentioned for breadcrumb context.

---

## 6. Draft follow-up issues (Clubhouse repo)

The user asked us to draft these but NOT to file them. Bodies below for review.

---

### Draft issue 1: Add agent-restart UX for the hook server toggle

**Title**: `Wire renderer notice for AGENTS_NEED_RESTART after hook server toggle`

**Body**:

The new `IPC.HOOK_SERVER.AGENTS_NEED_RESTART` event (added in #PR_NUMBER) is broadcast to all renderer windows when the user toggles the global hook server enable setting. The preload bridge exposes a subscription via `window.clubhouse.hookServer.onAgentsNeedRestart`. Today nothing in the renderer subscribes to it, so users don't see a notice and may not know to restart affected agents.

**Proposal**:
- Subscribe in a new top-level effect (e.g. inside the agent hub layout).
- On event, show a non-blocking toast / status pill near each affected agent: "Hook server toggled — restart this agent for changes to take effect."
- Offer a per-agent restart button on the toast.
- **Do NOT auto-restart** — same constraint as the original design: killing PTYs mid-task loses work.

Acceptance:
- [ ] Toggling the hook server off with running agents surfaces a visible notice.
- [ ] The notice shows the count and (optionally) names of affected agents.
- [ ] Restart is gated on user click.

---

### Draft issue 2: GHCP `--continue` hook config reload is unverified

**Title**: `Verify GHCP --continue picks up new hook config after Clubhouse upgrade`

**Body**:

`agent-system.ts:337` calls `provider.writeHooksConfig()` on every spawn, so the on-disk hook config is fresh after a Clubhouse upgrade. But within a long-running GHCP CLI process, workspace recycling can re-init internal session state without re-reading the hook config (observed in `lucky-mantis`: 2.5-day idle → workspace re-init in same process). Whether GHCP re-reads `.github/hooks/hooks.json` on workspace re-init is **undocumented**.

Risk window: a Clubhouse upgrade that changes hook timeouts (e.g. the `PERMISSION_HOOK_TIMEOUT_SEC` constant added in #PR_NUMBER) would not take effect for an agent whose CLI process survives the upgrade. Today this is theoretical — Electron app restart kills child processes — but it's worth confirming.

**Proposal**:
1. Set up a repro: spawn a GHCP agent, wait for workspace re-init (or force it), modify hook config on disk, fire a permission request, observe whether the new value is honored.
2. If the answer is "GHCP caches in memory and ignores disk changes mid-process," consider a heartbeat that re-issues `writeHooksConfig` periodically, OR fail closed on workspace re-init.
3. File an upstream issue if GHCP behavior is surprising — see draft below.

Acceptance:
- [ ] Documented behavior in the orchestrator notes.
- [ ] Test (manual or automated) confirming the contract.

---

### Draft issue 3: Hook server load test + stuck-permission alerting

**Title**: `Stress test the permission queue with concurrent + duplicate requests`

**Body**:

The current permission queue (`annex-permission-queue.ts`) has no deduplication or per-agent rate limiting. Tests confirm multiple permission entries from the same agent are stored independently. The queue test only covers happy paths — we have no regression coverage for:

1. **Burst scenarios**: 50+ concurrent permissions from a single agent. Memory + listener storm risk.
2. **Duplicate request behavior**: GHCP issue #2586 (notification hook firing for already-approved tools) suggests upstream may send duplicates. We treat each as a fresh request → independent timeouts → potential UI confusion.
3. **Stuck-permission alerting**: This PR added a 30s scanner that logs WARN for pending permissions older than 30s. There's no UI surface — would be useful as a status pill on the agent or in a hub-level notification.

**Proposal**:
- Add a vitest stress test with 100 concurrent `createPermission` calls; assert no memory leak, all resolve cleanly on `clearForAgent`.
- Add deduplication keyed on `(agentId, toolName, JSON.stringify(toolInput))` with a configurable window — return the existing `requestId` instead of creating a new entry.
- Surface stuck-permission warnings to the renderer (toast or status pill).

Acceptance:
- [ ] Stress test in CI.
- [ ] Dedup design + implementation.
- [ ] Renderer surface for the stuck-permission warning.

---

## 7. Draft upstream issue (`github/copilot-cli`)

The user said to write the body but not file it.

---

### Draft upstream issue: Document `permissionRequest` hook timeout behavior

**Title**: `[docs] Clarify what happens when a permissionRequest hook times out`

**Body**:

The [hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference) describes `permissionRequest` as accepting `permissionDecision` values of `"allow"`, `"deny"`, or `"ask"`. The reference also says hook failures "are logged and skipped — they never block agent execution."

What's *not* documented:

1. **Timeout fallthrough**: When `timeoutSec` elapses and the hook command is killed, what happens? Does the CLI fall through to interactive prompt (same as `"ask"`)? Treat as `"deny"`? Hard-fail the tool call?
2. **Empty / unrecognized output**: If the hook returns no `permissionDecision` field, is that the same as `"ask"`?
3. **Race window**: If a hook process exits at the exact moment of timeout, is its output read?

We hit a real bug in our integration ([Clubhouse PR](https://github.com/anthropics/clubhouse-clubhouse/pull/PR_NUMBER)) caused by a symmetric 120s timeout race — our server held the response open for 120s, GHCP also waited 120s, and both expired at the same instant. We worked around it by resolving server-side at 110s. Documenting the timeout fallthrough behavior would help other integrators avoid the same trap.

**Suggested addition** to the docs:
- A short section under `permissionRequest` titled "Hook failure / timeout behavior" stating which fallthrough path applies.
- A recommendation: integrators that hold the response open for remote approval should resolve at `timeoutSec - safety_margin` to avoid races.

---

## 8. Other observations worth recording

- **Hook server only logs on failure today** — this PR fixes that with comprehensive INFO/WARN logging in `hook-server.ts` and a new `core:permission-queue` namespace. Future bugs in this area should be visible in logs.

- **No periodic snapshot of pending permissions** — added in this PR. Every 30s, any pending permission older than 30s logs WARN with `requestId`, `agentId`, `toolName`, `ageMs`, `remainingMs`. Bridges the gap between "queue silently stuck" and "user reports symptom."

- **Settings toggle is the durable escape hatch** — added in this PR. Disabling strips Clubhouse hooks from running agents and short-circuits the hook server. Users who get stuck (in any future bug we don't anticipate) can recover by toggling off.

- **All three providers share the timeout constant now** — `PERMISSION_HOOK_TIMEOUT_SEC` in `orchestrators/types.ts`. If we ever need different per-provider values, the right move is an optional method on `HookCapable`. Not needed today.
