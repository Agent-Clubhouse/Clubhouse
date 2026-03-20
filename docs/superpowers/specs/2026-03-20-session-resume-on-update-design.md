# Session Resume on Update

**Date:** 2026-03-20
**Status:** Approved (design phase)

## Problem

When Clubhouse applies an update, `app.exit(0)` kills all running agent sessions. Users lose their active context windows — conversations, in-flight work, and prompt state. After restart, they must manually remember which agents were active and re-launch each one. This is stressful and error-prone, especially with multiple agents across projects.

## Goals

1. Active agents that are mid-work get a **warning modal** before restart — user chooses per-agent what to do
2. Idle agents (prompt open, waiting for input) **automatically resume** after restart with full conversation context
3. Agent identity is **strictly preserved** — "darling-gazelle" resumes its own session, never another agent's
4. Multiple agents in the same workspace resume **sequentially** to avoid conflicts
5. Works for Claude Code (full auto-resume). Other CLIs get manual "Tap to resume" until they support per-session resume.

## Non-Goals

- Continuous state persistence (crash recovery) — out of scope, capture only at restart time
- Restoring PTY buffer separately — the CLI's `--resume` replays conversation history naturally
- Supporting resume for orchestrators without session resume capability (they get manual flow)

## Architecture: Restart Interceptor (Approach A)

### Overview

Intercept the update restart path with a gate that captures session state before exit, then drives a resume queue on next startup.

```
User clicks "Restart"
  → Main process classifies live agents (working vs idle)
  → If working agents exist → IPC to renderer → Update Gate Modal
  → User resolves all working agents
  → captureSessionState() → writes restart-session-state.json
  → app.exit(0) → update applies → app relaunches
  → loadPendingResume() → Resume Queue processes entries
  → Resume Banner shows progress in Hub
  → cleanup: delete restart-session-state.json
```

### 1. Restart State File

Written to `app.getPath('userData')/restart-session-state.json` at the moment of restart.

```json
{
  "version": 1,
  "capturedAt": "2026-03-20T14:30:00Z",
  "appVersion": "0.38.0",
  "sessions": [
    {
      "agentId": "darling-gazelle",
      "agentName": "darling-gazelle",
      "projectPath": "/Users/gary/projects/Clubhouse",
      "orchestrator": "claude-code",
      "sessionId": "abc-123-def",
      "resumeStrategy": "auto",
      "worktreePath": "/Users/gary/projects/Clubhouse/.worktrees/darling-gazelle"
    },
    {
      "agentId": "mega-camel",
      "agentName": "mega-camel",
      "projectPath": "/Users/gary/projects/Clubhouse",
      "orchestrator": "copilot-cli",
      "sessionId": null,
      "resumeStrategy": "manual"
    }
  ]
}
```

**Fields:**
- `version`: Schema version for forward compatibility
- `capturedAt`: ISO timestamp, used for staleness check (discard if > 24 hours old)
- `appVersion`: The version that captured this state (informational)
- `sessions[].agentId`: Unique agent identifier — the key for strict identity mapping
- `sessions[].sessionId`: CLI-specific session ID extracted from the **live PTY buffer** at capture time via `provider.extractSessionId()`. NOT read from `DurableAgentConfig.lastSessionId` (which may reflect a previous session — the current session's ID hasn't been persisted to disk yet because the `onExit` handler hasn't fired). Null if the orchestrator doesn't support session resume or if extraction fails.
- `sessions[].resumeStrategy`: `"auto"` (Claude Code — has `--resume <id>`) or `"manual"` (everything else)
- `sessions[].worktreePath`: If agent uses a worktree, resume in that directory, not the parent project
- `sessions[].kind`: `"durable"` or `"quick"` — determines resume behavior
- `sessions[].mission`: Original mission/prompt text (quick agents only, needed for fallback re-spawn)
- `sessions[].model`: Model override if any (quick agents only)

**Schema versioning:** If the loaded file's `version` does not match the current expected version, discard and delete. Given the file is ephemeral (< 24 hours), migration is not worth the complexity.

**Lifecycle:** Written once at restart. Read once at next startup. Deleted after the resume queue is built (early delete prevents infinite restart loops on crash).

### 2. Update Gate Modal

Shown in the renderer when the user triggers restart and live agents exist.

**Agent classification:**
- `working`: `PtyManager.lastActivity` within last 5 seconds. This is a heuristic — an agent waiting on a long API call with no PTY output may be misclassified as idle, and a prompt redraw may make an idle agent look active. The modal UX handles both cases gracefully: a misclassified-working agent just gets a "Wait" option (harmless), and a misclassified-idle agent will auto-resume fine since it wasn't actually doing anything.
- `idle`: everything else (waiting for input, needs permission, etc.)

**Scope — PTY agents only:** This feature covers agents running in `pty` execution mode. Headless agents (`headless-manager.ts`) and structured-mode agents (`structured-manager.ts`) are excluded from the Update Gate Modal and resume flow. Rationale: headless agents are short-lived quick missions with no interactive session to resume. Structured-mode agents are API-driven and don't have a PTY buffer or user-facing prompt. If a headless/structured agent is running at update time, it will be killed — same as today. This can be revisited if these runtimes gain session persistence.

**Modal layout:**

Working agents section (top):
- Each shows agent name, project, orchestrator, status
- Per-agent actions: **Wait** | **Interrupt & Resume** | **Kill**

Will-resume section (bottom):
- Idle agents auto-listed here
- Shows resume strategy: "Will auto-resume" (Claude Code) or "Manual resume after restart" (others)

**Behavior:**
- "Restart Now" button **disabled** while any agent is unresolved `working`
- **Wait**: keeps modal open, polls agent every 2 seconds. When it goes idle, moves to will-resume section.
- **Interrupt & Resume**: sends Ctrl+C via PTY, waits up to 10 seconds for graceful CLI exit, extracts session ID from PTY buffer. If no session ID can be extracted after interrupt, falls back to `--continue` strategy (marks `sessionId: null` but keeps `resumeStrategy: "auto"` so the resume queue will use `--continue` instead of `--resume <id>`).
- **Kill**: hard kills the PTY process. No resume entry saved for this agent.
- **Cancel**: closes modal, no restart

### 3. Resume Queue

Processes `restart-session-state.json` entries after app relaunch.

**Processing rules:**
- **Per-workspace sequential**: agents sharing the same `projectPath` resume one at a time. Next agent starts after the previous is alive and idle.
- **Cross-workspace parallel**: agents in different projects resume simultaneously.
- **`auto` strategy**: spawn agent with `resume: true, sessionId: <saved-id>`. CLI repopulates conversation.
- **`manual` strategy**: agent tab appears in Hub in "Ready to resume" state. User clicks to start.

**Edge cases:**
- **Stale state file** (> 24 hours old): ignore and delete
- **Project directory gone**: skip agent, show warning in resume banner
- **Session ID invalid** (`--resume <id>` fails): fall back to `--continue`. If that fails too, show "Resume failed" with option to start fresh.
- **Quick agents**: saved with `agentId`, `projectPath`, `sessionId`, `mission`, `model`, `orchestrator`, and `kind: "quick"` in the state file. On resume, spawn a new quick agent with `--resume <sessionId>` if supported. If resume isn't available, re-spawn with the original `mission` text. Quick agents don't have `DurableAgentConfig`, so ALL their context must come from the state file.
- **Per-workspace resume timeout**: if a resuming agent does not reach idle state within 60 seconds, skip it and proceed to the next agent in that workspace. Show "Resume timed out" in the banner with an option to retry manually.

### 4. Main Process Changes

**New file: `src/main/services/restart-session-service.ts`**

Three functions:
- `captureSessionState()`: calls `AgentRegistry.getAllRegistrations()` (new method — see below) to enumerate live agents. For each PTY agent, extracts the session ID from the **live PTY buffer** via `provider.extractSessionId(ptyManager.getBuffer(agentId))` — NOT from `DurableAgentConfig.lastSessionId`, which may reflect a previous session since the current session's `onExit` handler hasn't fired yet. Determines `resumeStrategy` from orchestrator `capabilities.sessionResume`. Writes state file.
- `loadPendingResume()`: reads and validates state file (checks `version` matches expected, `capturedAt` within 24 hours), returns session list or null
- `clearPendingResume()`: deletes state file

**Modified: `src/main/services/auto-update-service.ts`**

`applyUpdate()` intercepted:
1. Query AgentRegistry for live agents
2. If none → `captureSessionState()` (writes empty sessions) → `app.exit(0)`
3. If any working → IPC to renderer → Update Gate Modal → wait for resolution
4. All resolved → `captureSessionState()` → `app.exit(0)`

**`applyUpdateOnQuit()` does NOT capture session state.** This path fires during normal quit (`app.quit()`), meaning the user intentionally closed the app. Resuming sessions they chose to close would be confusing. Session capture only happens in the explicit `applyUpdate()` restart path.

**Pre-exit cleanup:** Since `app.exit(0)` bypasses the `before-quit` handler, the explicit restart path must run config cleanup before exiting: `configPipeline.restoreAll()` and `agentConfig.flushAllDirty()`. This ensures materialized config files (MCP, permissions, etc.) are cleaned up before the restart.

**Modified: `src/main/index.ts`**

In `app.whenReady()` startup, after services initialize:
1. Call `loadPendingResume()`
2. If pending sessions exist → IPC to renderer (show resume banner) → feed entries into agent-system spawn queue
3. Call `clearPendingResume()` immediately after parsing (not after completion)

**Modified: `src/main/ipc/agent-handlers.ts`**

Two new IPC channels:
- `IPC.APP.GET_PENDING_RESUMES`: renderer calls on startup to get session list
- `IPC.APP.RESUME_MANUAL_AGENT`: renderer calls when user taps "Resume" on a manual-strategy agent

### 5. Renderer Changes

**New: `src/renderer/components/UpdateGateModal.tsx`**
- Triggered via IPC when auto-update-service detects live agents at restart time
- Polls agent status every 2 seconds to detect when working agents finish
- Emits per-agent decisions to main via IPC
- "Restart Now" enabled only when all working agents resolved

**New: `src/renderer/components/ResumeBanner.tsx`**
- Shown at top of Hub on startup when pending resumes exist
- Per-agent status: checkmark (resumed), spinner (in progress), warning (manual/failed)
- Manual-strategy agents show "Tap to resume" button
- "Dismiss" hides banner (doesn't cancel anything)
- Auto-dismisses when all agents resolved

**Modified: `src/renderer/stores/agent/agentLifecycleSlice.ts`**
- New state: `resumingAgents: Record<agentId, ResumeStatus>`
- `ResumeStatus`: `'pending' | 'resuming' | 'resumed' | 'failed' | 'manual'`
- Existing `spawnAgent` flow handles `resume: true` unchanged

**Resume status IPC flow:**
- Main process drives the resume queue and sends status updates to renderer via a new `IPC.APP.RESUME_STATUS_UPDATE` channel: `{ agentId, status: ResumeStatus, error?: string }`
- Renderer `agentLifecycleSlice` listens for these events and updates `resumingAgents` state
- `ResumeBanner` reads from `resumingAgents` to render per-agent progress

**No changes to:** agent cards, terminal views, PTY rendering, settings, sidebar.

## CLI Resume Support Matrix

| Orchestrator | Resume Command | Per-Session | Strategy |
|---|---|---|---|
| Claude Code | `--resume <sessionId>` | Yes | `auto` |
| Copilot CLI | `--continue` | No (most recent only) | `manual` |
| OpenCode | None | No | `manual` |
| Codex CLI | None | No | `manual` |

As orchestrators add per-session resume, update their provider's `capabilities.sessionResume` flag and they'll automatically get `auto` strategy.

## File Inventory

| Action | File | Notes |
|---|---|---|
| Create | `src/main/services/restart-session-service.ts` | Core capture/load/clear logic |
| Create | `src/renderer/components/UpdateGateModal.tsx` | Pre-restart modal with per-agent controls |
| Create | `src/renderer/components/ResumeBanner.tsx` | Post-restart resume progress banner |
| Modify | `src/main/services/auto-update-service.ts` | Gate in `applyUpdate()`, pre-exit cleanup |
| Modify | `src/main/services/agent-registry.ts` | Add `getAllRegistrations()` public method |
| Modify | `src/main/services/pty-manager.ts` | Add `getLastActivity(agentId)` public accessor (`getBuffer` already exists) |
| Modify | `src/main/index.ts` | Startup resume check |
| Modify | `src/main/ipc/agent-handlers.ts` | New IPC channels for resume |
| Modify | `src/shared/ipc-channels.ts` | New channel constants |
| Modify | `src/renderer/stores/agent/agentLifecycleSlice.ts` | `resumingAgents` state + IPC listeners |

## Testing Strategy

- **Unit tests** for `restart-session-service.ts`: capture, load, clear, staleness, missing directories
- **Unit tests** for agent classification logic: working vs idle based on lastActivity threshold
- **Integration test**: mock AgentRegistry + PtyManager, trigger captureSessionState, verify file contents, load it back
- **E2E test**: spawn agent, trigger update flow, verify modal appears, confirm restart, verify resume on relaunch
- **Edge case tests**: stale file, missing project, invalid session ID fallback, quick agent resume
