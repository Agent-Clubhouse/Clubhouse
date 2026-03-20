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
- `sessions[].sessionId`: CLI-specific session ID from `DurableAgentConfig.lastSessionId` or PTY buffer extraction. Null if orchestrator doesn't support it.
- `sessions[].resumeStrategy`: `"auto"` (Claude Code — has `--resume <id>`) or `"manual"` (everything else)
- `sessions[].worktreePath`: If agent uses a worktree, resume in that directory, not the parent project

**Lifecycle:** Written once at restart. Read once at next startup. Deleted after the resume queue is built (early delete prevents infinite restart loops on crash).

### 2. Update Gate Modal

Shown in the renderer when the user triggers restart and live agents exist.

**Agent classification:**
- `working`: `PtyManager.lastActivity` within last 3 seconds, OR `AgentDetailedState === 'working'` from structured mode
- `idle`: everything else (waiting for input, needs permission, etc.)

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
- **Interrupt & Resume**: sends Ctrl+C via PTY, waits for graceful CLI exit, captures session ID, marks for auto-resume
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
- **Quick agents**: saved with `agentId`, `projectPath`, `sessionId`, `mission`. Resume via `--resume <sessionId>` if supported, otherwise re-spawn with original mission text.

### 4. Main Process Changes

**New file: `src/main/services/restart-session-service.ts`**

Three functions:
- `captureSessionState()`: queries AgentRegistry + PtyManager for live agents, resolves session IDs from DurableAgentConfig (durable agents) or PTY buffer extraction (quick agents), determines resumeStrategy from orchestrator capabilities, writes state file
- `loadPendingResume()`: reads and validates state file, returns session list or null
- `clearPendingResume()`: deletes state file

**Modified: `src/main/services/auto-update-service.ts`**

`applyUpdate()` intercepted:
1. Query AgentRegistry for live agents
2. If none → `captureSessionState()` (writes empty sessions) → `app.exit(0)`
3. If any working → IPC to renderer → Update Gate Modal → wait for resolution
4. All resolved → `captureSessionState()` → `app.exit(0)`

`applyUpdateOnQuit()` also calls `captureSessionState()` so silent-update-on-quit preserves sessions too.

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

| Action | File |
|---|---|
| Create | `src/main/services/restart-session-service.ts` |
| Create | `src/renderer/components/UpdateGateModal.tsx` |
| Create | `src/renderer/components/ResumeBanner.tsx` |
| Modify | `src/main/services/auto-update-service.ts` |
| Modify | `src/main/index.ts` |
| Modify | `src/main/ipc/agent-handlers.ts` |
| Modify | `src/shared/ipc-channels.ts` |
| Modify | `src/renderer/stores/agent/agentLifecycleSlice.ts` |

## Testing Strategy

- **Unit tests** for `restart-session-service.ts`: capture, load, clear, staleness, missing directories
- **Unit tests** for agent classification logic: working vs idle based on lastActivity threshold
- **Integration test**: mock AgentRegistry + PtyManager, trigger captureSessionState, verify file contents, load it back
- **E2E test**: spawn agent, trigger update flow, verify modal appears, confirm restart, verify resume on relaunch
- **Edge case tests**: stale file, missing project, invalid session ID fallback, quick agent resume
