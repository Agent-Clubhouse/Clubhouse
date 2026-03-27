# Session Resume on Update — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve active agent sessions across app update restarts — warn before killing working agents, auto-resume idle sessions after relaunch.

**Architecture:** Intercept the update restart path with a gate that classifies live agents, captures session state to a JSON file, then drives a sequential-per-workspace resume queue on next startup. The Update Gate Modal replaces the existing inline "N agents will be stopped" confirmation in UpdateBanner.

**Tech Stack:** Electron (main + renderer), TypeScript, node-pty, React, Zustand, Tailwind CSS (Catppuccin theme), Vitest

**Spec:** `docs/superpowers/specs/2026-03-20-session-resume-on-update-design.md`

---

## Chunk 1: Main Process Foundation

### Task 1: Add `getAllRegistrations()` to AgentRegistry

**Files:**
- Modify: `src/main/services/agent-registry.ts:17-43`
- Test: `src/main/services/agent-registry.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/main/services/agent-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { agentRegistry } from './agent-registry';

describe('AgentRegistry', () => {
  beforeEach(() => {
    // Clean up by untracking any leftover registrations
    for (const [id] of agentRegistry.getAllRegistrations()) {
      agentRegistry.untrack(id);
    }
  });

  describe('getAllRegistrations', () => {
    it('returns empty map when no agents registered', () => {
      const all = agentRegistry.getAllRegistrations();
      expect(all.size).toBe(0);
    });

    it('returns all registered agents', () => {
      agentRegistry.register('agent-1', {
        projectPath: '/projects/a',
        orchestrator: 'claude-code',
        runtime: 'pty',
      });
      agentRegistry.register('agent-2', {
        projectPath: '/projects/b',
        orchestrator: 'copilot-cli',
        runtime: 'pty',
      });

      const all = agentRegistry.getAllRegistrations();
      expect(all.size).toBe(2);
      expect(all.get('agent-1')?.projectPath).toBe('/projects/a');
      expect(all.get('agent-2')?.orchestrator).toBe('copilot-cli');
    });

    it('returns a copy — mutations do not affect the registry', () => {
      agentRegistry.register('agent-1', {
        projectPath: '/projects/a',
        orchestrator: 'claude-code',
        runtime: 'pty',
      });

      const copy = agentRegistry.getAllRegistrations();
      copy.delete('agent-1');

      expect(agentRegistry.get('agent-1')).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/agent-registry.test.ts`
Expected: FAIL — `getAllRegistrations is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/main/services/agent-registry.ts`, add to the `AgentRegistry` class (after the `untrack` method, around line 42):

```typescript
  getAllRegistrations(): Map<string, AgentRegistration> {
    return new Map(this.registrations);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/services/agent-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/agent-registry.ts src/main/services/agent-registry.test.ts
git commit -m "feat(agent-registry): add getAllRegistrations() for session capture"
```

---

### Task 2: Add `getLastActivity()` to PtyManager

**Files:**
- Modify: `src/main/services/pty-manager.ts:185-188`
- Test: `src/main/services/pty-manager.test.ts` (new — focused test for the accessor)

- [ ] **Step 1: Write the failing test**

Create `src/main/services/pty-manager.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getLastActivity } from './pty-manager';

describe('pty-manager', () => {
  describe('getLastActivity', () => {
    it('returns null for non-existent agent', () => {
      expect(getLastActivity('nonexistent-agent')).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/pty-manager.test.ts`
Expected: FAIL — `getLastActivity is not exported`

- [ ] **Step 3: Write minimal implementation**

In `src/main/services/pty-manager.ts`, add after the `getBuffer` function (after line 188):

```typescript
/** Get the last activity timestamp for an agent's PTY session, or null if no session exists. */
export function getLastActivity(agentId: string): number | null {
  const session = sessions.get(agentId);
  return session ? session.lastActivity : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/services/pty-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/pty-manager.ts src/main/services/pty-manager.test.ts
git commit -m "feat(pty-manager): add getLastActivity() accessor for agent classification"
```

---

### Task 3: Add new IPC channels

**Files:**
- Modify: `src/shared/ipc-channels.ts:149-195` (APP section)

- [ ] **Step 1: Add the new IPC channel constants**

In `src/shared/ipc-channels.ts`, add inside the `APP` object (after `SAVE_EXPERIMENTAL_SETTINGS` on line 194, before the closing brace):

```typescript
    // Session resume on update
    GET_PENDING_RESUMES: 'app:get-pending-resumes',
    RESUME_MANUAL_AGENT: 'app:resume-manual-agent',
    RESUME_STATUS_UPDATE: 'app:resume-status-update',
    GET_LIVE_AGENTS_FOR_UPDATE: 'app:get-live-agents-for-update',
    RESOLVE_WORKING_AGENT: 'app:resolve-working-agent',
    CONFIRM_UPDATE_RESTART: 'app:confirm-update-restart',
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors related to IPC channels

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-channels.ts
git commit -m "feat(ipc): add session resume IPC channel constants"
```

---

### Task 4: Create `restart-session-service.ts`

**Files:**
- Create: `src/main/services/restart-session-service.ts`
- Test: `src/main/services/restart-session-service.test.ts` (new)

- [ ] **Step 1: Define the types**

First, add the shared types to `src/shared/types.ts` (at the end of the file, after the existing types). These types are used by both main and renderer — **never import from `src/main/` in renderer code** as they are separate Webpack compilations:

```typescript
// --- Session Resume on Update types ---

export type ResumeStrategy = 'auto' | 'manual';

export interface RestartSessionEntry {
  agentId: string;
  agentName: string;
  projectPath: string;
  orchestrator: OrchestratorId;
  sessionId: string | null;
  resumeStrategy: ResumeStrategy;
  worktreePath?: string;
  kind: AgentKind;
  mission?: string;
  model?: string;
}

export interface RestartSessionState {
  version: number;
  capturedAt: string;
  appVersion: string;
  sessions: RestartSessionEntry[];
}

export interface LiveAgentInfo {
  agentId: string;
  projectPath: string;
  orchestrator: OrchestratorId;
  runtime: string;
  isWorking: boolean;
  lastActivity: number | null;
}
```

Then create `src/main/services/restart-session-service.ts`:

```typescript
import { app } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from './log-service';
import { agentRegistry } from './agent-registry';
import * as ptyManager from './pty-manager';
import { getProvider, isSessionCapable } from '../orchestrators';
import { pathExists } from './fs-utils';
import type { AgentKind, RestartSessionEntry, RestartSessionState, LiveAgentInfo } from '../../shared/types';

const SCHEMA_VERSION = 1;
const STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const STATE_FILENAME = 'restart-session-state.json';

function getStatePath(): string {
  return path.join(app.getPath('userData'), STATE_FILENAME);
}
```

- [ ] **Step 2: Write tests for `captureSessionState`**

Create `src/main/services/restart-session-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-userdata'),
    getVersion: vi.fn().mockReturnValue('0.38.0'),
  },
}));

// Mock dependencies
vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('./agent-registry', () => {
  const registrations = new Map();
  return {
    agentRegistry: {
      getAllRegistrations: () => new Map(registrations),
      get: (id: string) => registrations.get(id),
      register: (id: string, reg: unknown) => registrations.set(id, reg),
      untrack: (id: string) => registrations.delete(id),
    },
  };
});

vi.mock('./pty-manager', () => ({
  getBuffer: vi.fn().mockReturnValue(''),
  getLastActivity: vi.fn().mockReturnValue(null),
  isRunning: vi.fn().mockReturnValue(false),
}));

vi.mock('../orchestrators', () => ({
  getProvider: vi.fn().mockReturnValue({
    id: 'claude-code',
    capabilities: { sessionResume: true },
    extractSessionId: vi.fn().mockReturnValue(null),
  }),
  isSessionCapable: vi.fn().mockReturnValue(true),
}));

import { captureSessionState, loadPendingResume, clearPendingResume } from './restart-session-service';
import { agentRegistry } from './agent-registry';
import * as ptyManager from './pty-manager';
import { getProvider, isSessionCapable } from '../orchestrators';

describe('restart-session-service', () => {
  const statePath = '/tmp/test-userdata/restart-session-state.json';

  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up registry
    for (const [id] of agentRegistry.getAllRegistrations()) {
      agentRegistry.untrack(id);
    }
  });

  afterEach(async () => {
    try { await fsp.unlink(statePath); } catch {}
  });

  describe('captureSessionState', () => {
    it('writes state file with PTY agents only', async () => {
      agentRegistry.register('darling-gazelle', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'pty',
      });
      agentRegistry.register('headless-one', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'headless',
      });

      const provider = {
        id: 'claude-code',
        capabilities: { sessionResume: true },
        extractSessionId: vi.fn().mockReturnValue('session-abc'),
      };
      vi.mocked(getProvider).mockReturnValue(provider as never);
      vi.mocked(isSessionCapable).mockReturnValue(true);
      vi.mocked(ptyManager.getBuffer).mockReturnValue('session: session-abc');
      vi.mocked(ptyManager.getLastActivity).mockReturnValue(Date.now());

      const agentNames = new Map([['darling-gazelle', 'darling-gazelle']]);
      await captureSessionState(agentNames);

      const raw = await fsp.readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);

      expect(state.version).toBe(1);
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0].agentId).toBe('darling-gazelle');
      expect(state.sessions[0].sessionId).toBe('session-abc');
      expect(state.sessions[0].resumeStrategy).toBe('auto');
    });

    it('sets manual strategy when orchestrator lacks sessionResume', async () => {
      agentRegistry.register('mega-camel', {
        projectPath: '/projects/club',
        orchestrator: 'copilot-cli' as const,
        runtime: 'pty',
      });

      const provider = {
        id: 'copilot-cli',
        capabilities: { sessionResume: false },
      };
      vi.mocked(getProvider).mockReturnValue(provider as never);
      vi.mocked(isSessionCapable).mockReturnValue(false);

      const agentNames = new Map([['mega-camel', 'mega-camel']]);
      await captureSessionState(agentNames);

      const raw = await fsp.readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);

      expect(state.sessions[0].resumeStrategy).toBe('manual');
      expect(state.sessions[0].sessionId).toBeNull();
    });
  });

  describe('loadPendingResume', () => {
    it('returns null when file does not exist', async () => {
      const result = await loadPendingResume();
      expect(result).toBeNull();
    });

    it('returns null and deletes file when version mismatches', async () => {
      await fsp.mkdir(path.dirname(statePath), { recursive: true });
      await fsp.writeFile(statePath, JSON.stringify({
        version: 999,
        capturedAt: new Date().toISOString(),
        appVersion: '0.38.0',
        sessions: [],
      }));

      const result = await loadPendingResume();
      expect(result).toBeNull();
    });

    it('returns null and deletes file when stale (>24h)', async () => {
      await fsp.mkdir(path.dirname(statePath), { recursive: true });
      const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await fsp.writeFile(statePath, JSON.stringify({
        version: 1,
        capturedAt: staleDate,
        appVersion: '0.38.0',
        sessions: [{ agentId: 'test', resumeStrategy: 'auto' }],
      }));

      const result = await loadPendingResume();
      expect(result).toBeNull();
    });

    it('returns sessions when file is valid and fresh', async () => {
      await fsp.mkdir(path.dirname(statePath), { recursive: true });
      await fsp.writeFile(statePath, JSON.stringify({
        version: 1,
        capturedAt: new Date().toISOString(),
        appVersion: '0.38.0',
        sessions: [{ agentId: 'darling-gazelle', resumeStrategy: 'auto', sessionId: 'abc' }],
      }));

      const result = await loadPendingResume();
      expect(result).not.toBeNull();
      expect(result!.sessions).toHaveLength(1);
      expect(result!.sessions[0].agentId).toBe('darling-gazelle');
    });
  });

  describe('clearPendingResume', () => {
    it('deletes the state file', async () => {
      await fsp.mkdir(path.dirname(statePath), { recursive: true });
      await fsp.writeFile(statePath, '{}');

      await clearPendingResume();

      await expect(fsp.access(statePath)).rejects.toThrow();
    });

    it('does not throw when file does not exist', async () => {
      await expect(clearPendingResume()).resolves.not.toThrow();
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/main/services/restart-session-service.test.ts`
Expected: FAIL — functions not implemented

- [ ] **Step 4: Implement `captureSessionState`**

Add to `src/main/services/restart-session-service.ts`:

```typescript
/**
 * Capture state for all live PTY agents. Called just before app.exit(0) during update restart.
 * @param agentNames — Map of agentId → display name (from renderer agent store or durable config)
 * @param agentMeta — Optional per-agent metadata for quick agents (mission, model, kind)
 */
export async function captureSessionState(
  agentNames: Map<string, string>,
  agentMeta?: Map<string, { kind: AgentKind; mission?: string; model?: string; worktreePath?: string }>,
): Promise<void> {
  const all = agentRegistry.getAllRegistrations();
  const sessions: RestartSessionEntry[] = [];

  for (const [agentId, reg] of all) {
    // Only capture PTY agents — headless/structured have no interactive session to resume
    if (reg.runtime !== 'pty') continue;

    const provider = getProvider(reg.orchestrator);
    if (!provider) continue;

    // Extract session ID from LIVE PTY buffer (not DurableAgentConfig — see spec)
    let sessionId: string | null = null;
    if (isSessionCapable(provider)) {
      const buffer = ptyManager.getBuffer(agentId);
      sessionId = provider.extractSessionId(buffer);
    }

    // Use isSessionCapable (not capabilities.sessionResume) — all four providers
    // have sessionResume: true in capabilities, but only Claude Code actually
    // implements the SessionCapable interface (extractSessionId, listSessions).
    const canResume = isSessionCapable(provider);
    const meta = agentMeta?.get(agentId);

    sessions.push({
      agentId,
      agentName: agentNames.get(agentId) || agentId,
      projectPath: reg.projectPath,
      orchestrator: reg.orchestrator,
      sessionId,
      resumeStrategy: canResume ? 'auto' : 'manual',
      worktreePath: meta?.worktreePath,
      kind: meta?.kind || 'durable',
      mission: meta?.mission,
      model: meta?.model,
    });
  }

  const state: RestartSessionState = {
    version: SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    sessions,
  };

  const statePath = getStatePath();
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
  appLog('update:session-resume', 'info', `Captured ${sessions.length} sessions for resume`, {
    meta: { sessionCount: sessions.length, agentIds: sessions.map((s) => s.agentId) },
  });
}
```

- [ ] **Step 5: Implement `loadPendingResume`**

Add to `src/main/services/restart-session-service.ts`:

```typescript
/**
 * Load pending resume state from disk. Returns null if no file, stale, or invalid.
 */
export async function loadPendingResume(): Promise<RestartSessionState | null> {
  const statePath = getStatePath();

  let raw: string;
  try {
    raw = await fsp.readFile(statePath, 'utf-8');
  } catch {
    return null; // No file
  }

  let state: RestartSessionState;
  try {
    state = JSON.parse(raw);
  } catch {
    appLog('update:session-resume', 'warn', 'Corrupt restart-session-state.json, deleting');
    await silentUnlink(statePath);
    return null;
  }

  // Version mismatch — discard
  if (state.version !== SCHEMA_VERSION) {
    appLog('update:session-resume', 'info', `Schema version mismatch (got ${state.version}, want ${SCHEMA_VERSION}), discarding`);
    await silentUnlink(statePath);
    return null;
  }

  // Staleness check
  const age = Date.now() - new Date(state.capturedAt).getTime();
  if (age > STALENESS_THRESHOLD_MS) {
    appLog('update:session-resume', 'info', `Restart state too old (${Math.round(age / 3600000)}h), discarding`);
    await silentUnlink(statePath);
    return null;
  }

  appLog('update:session-resume', 'info', `Loaded ${state.sessions.length} pending resumes`);
  return state;
}
```

- [ ] **Step 6: Implement `clearPendingResume` and helpers**

Add to `src/main/services/restart-session-service.ts`:

```typescript
/** Delete the restart state file. */
export async function clearPendingResume(): Promise<void> {
  await silentUnlink(getStatePath());
}

async function silentUnlink(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch {
    // File didn't exist — fine
  }
}

/**
 * Classify live PTY agents as working or idle for the Update Gate Modal.
 * Returns info for each PTY agent.
 */
export function getLiveAgentsForUpdate(): LiveAgentInfo[] {
  const all = agentRegistry.getAllRegistrations();
  const result: LiveAgentInfo[] = [];
  const now = Date.now();
  const WORKING_THRESHOLD_MS = 5000;

  for (const [agentId, reg] of all) {
    if (reg.runtime !== 'pty') continue;

    const lastActivity = ptyManager.getLastActivity(agentId);
    const isWorking = lastActivity !== null && (now - lastActivity) < WORKING_THRESHOLD_MS;

    result.push({
      agentId,
      projectPath: reg.projectPath,
      orchestrator: reg.orchestrator,
      runtime: reg.runtime,
      isWorking,
      lastActivity,
    });
  }

  return result;
}
```

- [ ] **Step 7: Run tests to verify all pass**

Run: `npx vitest run src/main/services/restart-session-service.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/services/restart-session-service.ts src/main/services/restart-session-service.test.ts
git commit -m "feat: add restart-session-service for session capture/load/clear"
```

---

### Task 5: Wire IPC handlers for session resume

**Files:**
- Modify: `src/main/ipc/app-handlers.ts` (imports and end of `registerAppHandlers()`) — **all `IPC.APP.*` channels must live in app-handlers.ts**, not agent-handlers.ts
- Modify: `src/preload/index.ts` (add preload bridge methods)

- [ ] **Step 1: Add IPC handlers in app-handlers.ts**

At the top of `src/main/ipc/app-handlers.ts`, add import:

```typescript
import { getLiveAgentsForUpdate, loadPendingResume, captureSessionState, clearPendingResume } from '../services/restart-session-service';
import * as ptyManager from '../services/pty-manager';
import * as agentSystem from '../services/agent-system';
import { withValidatedArgs, stringArg, objectArg } from './validation';
```

At the end of `registerAppHandlers()`, add:

```typescript
  // --- Session resume on update ---

  ipcMain.handle(IPC.APP.GET_LIVE_AGENTS_FOR_UPDATE, () => {
    return getLiveAgentsForUpdate();
  });

  ipcMain.handle(IPC.APP.GET_PENDING_RESUMES, () => {
    return loadPendingResume();
  });

  ipcMain.handle(IPC.APP.RESUME_MANUAL_AGENT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, agentId, projectPath, sessionId) => {
      // Delegate to agentSystem.spawnAgent with resume flag
      await agentSystem.spawnAgent({
        agentId,
        projectPath,
        cwd: projectPath,
        kind: 'durable',
        resume: true,
        sessionId: sessionId || undefined,
      });
    },
  ));

  ipcMain.handle(IPC.APP.RESOLVE_WORKING_AGENT, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, agentId, action) => {
      if (action === 'interrupt') {
        // Send Ctrl+C, then wait for graceful exit
        ptyManager.write(agentId, '\x03');
      } else if (action === 'kill') {
        ptyManager.kill(agentId);
      }
      // 'wait' requires no action — the renderer will poll via GET_LIVE_AGENTS_FOR_UPDATE
    },
  ));

  ipcMain.handle(IPC.APP.CONFIRM_UPDATE_RESTART, withValidatedArgs(
    [objectArg<{ agentNames: Record<string, string>; agentMeta?: Record<string, unknown> }>()],
    async (_event, data) => {
      const agentNames = new Map(Object.entries(data.agentNames));

      // Build meta map if provided
      let agentMeta: Map<string, { kind: 'durable' | 'quick'; mission?: string; model?: string; worktreePath?: string }> | undefined;
      if (data.agentMeta) {
        agentMeta = new Map(Object.entries(data.agentMeta)) as typeof agentMeta;
      }

      // Capture session state before exit
      await captureSessionState(agentNames, agentMeta);

      // Pre-exit cleanup (app.exit bypasses before-quit)
      const { restoreAll } = await import('../services/config-pipeline');
      const { flushAllAgentConfigs } = await import('../services/agent-config');
      await flushAllAgentConfigs();
      restoreAll();

      // Now apply the update (which calls app.exit)
      const { applyUpdate } = await import('../services/auto-update-service');
      await applyUpdate();
    },
  ));
```

- [ ] **Step 2: Add preload bridge methods**

In `src/preload/index.ts`, inside the `app` namespace (near the existing `applyUpdate` method around line 645), add:

```typescript
    getLiveAgentsForUpdate: () =>
      ipcRenderer.invoke(IPC.APP.GET_LIVE_AGENTS_FOR_UPDATE),
    getPendingResumes: () =>
      ipcRenderer.invoke(IPC.APP.GET_PENDING_RESUMES),
    resumeManualAgent: (agentId: string, projectPath: string, sessionId?: string) =>
      ipcRenderer.invoke(IPC.APP.RESUME_MANUAL_AGENT, agentId, projectPath, sessionId),
    resolveWorkingAgent: (agentId: string, action: string) =>
      ipcRenderer.invoke(IPC.APP.RESOLVE_WORKING_AGENT, agentId, action),
    confirmUpdateRestart: (data: { agentNames: Record<string, string>; agentMeta?: Record<string, unknown> }) =>
      ipcRenderer.invoke(IPC.APP.CONFIRM_UPDATE_RESTART, data),
    onResumeStatusUpdate: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on(IPC.APP.RESUME_STATUS_UPDATE, listener);
      return () => { ipcRenderer.removeListener(IPC.APP.RESUME_STATUS_UPDATE, listener); };
    },
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/app-handlers.ts src/preload/index.ts
git commit -m "feat: wire IPC handlers and preload bridge for session resume"
```

---

### Task 6: Integrate resume check into app startup

**Files:**
- Modify: `src/main/index.ts:124-202` (app.on('ready'))

- [ ] **Step 1: Add import at top of index.ts**

After line 17 (`import { preWarmShellEnvironment } from './util/shell';`):

```typescript
import { loadPendingResume, clearPendingResume } from './services/restart-session-service';
```

- [ ] **Step 2: Add resume check after startup**

In the `app.on('ready', ...)` handler, after `startHeadlessStaleSweep()` (line 197), add:

```typescript
  // Check for pending session resumes from a previous update restart.
  // The renderer will call GET_PENDING_RESUMES via IPC on mount to get the data.
  // We just log + clear here to prevent infinite restart loops on crash.
  loadPendingResume().then((pendingState) => {
    if (pendingState && pendingState.sessions.length > 0) {
      appLog('core:startup', 'info', `Found ${pendingState.sessions.length} sessions to resume after update`);
      // Clear immediately — the renderer will have already read it via IPC
      clearPendingResume().catch(() => {});
    }
  }).catch((err) => {
    appLog('core:startup', 'error', `Failed to load pending resumes: ${err instanceof Error ? err.message : String(err)}`);
  });
```

Note: **No broadcast to renderer here.** The renderer calls `window.clubhouse.app.getPendingResumes()` on mount (Task 12) to pull the data. This avoids an ad-hoc IPC channel and a timing race with renderer loading.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: check for pending session resumes on app startup"
```

---

## Chunk 2: Renderer — Update Gate Modal

### Task 7: Create the Update Gate Modal component

**Files:**
- Create: `src/renderer/features/app/UpdateGateModal.tsx`
- Test: `src/renderer/features/app/UpdateGateModal.test.tsx` (new)

- [ ] **Step 1: Write the test**

Create `src/renderer/features/app/UpdateGateModal.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { UpdateGateModal } from './UpdateGateModal';

describe('UpdateGateModal', () => {
  const mockOnCancel = vi.fn();
  const mockOnConfirm = vi.fn();
  const mockOnResolveAgent = vi.fn();

  const baseAgents = [
    {
      agentId: 'darling-gazelle',
      agentName: 'darling-gazelle',
      projectPath: '/projects/club',
      orchestrator: 'claude-code' as const,
      isWorking: true,
      resumeStrategy: 'auto' as const,
    },
    {
      agentId: 'mega-camel',
      agentName: 'mega-camel',
      projectPath: '/projects/club',
      orchestrator: 'copilot-cli' as const,
      isWorking: false,
      resumeStrategy: 'manual' as const,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders working agents with action buttons', () => {
    render(
      <UpdateGateModal
        agents={baseAgents}
        onCancel={mockOnCancel}
        onConfirm={mockOnConfirm}
        onResolveAgent={mockOnResolveAgent}
      />,
    );
    expect(screen.getByText('darling-gazelle')).toBeDefined();
    expect(screen.getByText(/actively generating/i)).toBeDefined();
    expect(screen.getByText('Interrupt & Resume')).toBeDefined();
  });

  it('renders idle agents in will-resume section', () => {
    render(
      <UpdateGateModal
        agents={baseAgents}
        onCancel={mockOnCancel}
        onConfirm={mockOnConfirm}
        onResolveAgent={mockOnResolveAgent}
      />,
    );
    expect(screen.getByText('mega-camel')).toBeDefined();
    expect(screen.getByText(/manual resume/i)).toBeDefined();
  });

  it('disables Restart Now when working agents exist', () => {
    render(
      <UpdateGateModal
        agents={baseAgents}
        onCancel={mockOnCancel}
        onConfirm={mockOnConfirm}
        onResolveAgent={mockOnResolveAgent}
      />,
    );
    const btn = screen.getByTestId('update-gate-restart-btn');
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('enables Restart Now when no working agents', () => {
    const allIdle = baseAgents.map((a) => ({ ...a, isWorking: false }));
    render(
      <UpdateGateModal
        agents={allIdle}
        onCancel={mockOnCancel}
        onConfirm={mockOnConfirm}
        onResolveAgent={mockOnResolveAgent}
      />,
    );
    const btn = screen.getByTestId('update-gate-restart-btn');
    expect(btn.hasAttribute('disabled')).toBe(false);
  });

  it('calls onResolveAgent with correct action', () => {
    render(
      <UpdateGateModal
        agents={baseAgents}
        onCancel={mockOnCancel}
        onConfirm={mockOnConfirm}
        onResolveAgent={mockOnResolveAgent}
      />,
    );
    fireEvent.click(screen.getByText('Kill'));
    expect(mockOnResolveAgent).toHaveBeenCalledWith('darling-gazelle', 'kill');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/app/UpdateGateModal.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the component**

Create `src/renderer/features/app/UpdateGateModal.tsx`:

```tsx
export interface UpdateGateAgent {
  agentId: string;
  agentName: string;
  projectPath: string;
  orchestrator: string;
  isWorking: boolean;
  resumeStrategy: 'auto' | 'manual';
}

interface UpdateGateModalProps {
  agents: UpdateGateAgent[];
  onCancel: () => void;
  onConfirm: () => void;
  onResolveAgent: (agentId: string, action: 'wait' | 'interrupt' | 'kill') => void;
}

export function UpdateGateModal({ agents, onCancel, onConfirm, onResolveAgent }: UpdateGateModalProps) {
  const workingAgents = agents.filter((a) => a.isWorking);
  const idleAgents = agents.filter((a) => !a.isWorking);
  const hasWorking = workingAgents.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="bg-ctp-mantle rounded-xl shadow-xl max-w-lg w-full mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-ctp-text text-sm font-semibold mb-3">Update Ready — Active Agents</h2>

        {workingAgents.length > 0 && (
          <div className="mb-3">
            <div className="text-ctp-subtext0 text-xs mb-2">These agents are still working:</div>
            {workingAgents.map((agent) => (
              <div key={agent.agentId} className="flex items-center justify-between bg-surface-0 rounded-lg px-3 py-2 mb-1">
                <div>
                  <span className="text-ctp-red mr-2 text-xs">●</span>
                  <span className="text-ctp-text text-xs font-medium">{agent.agentName}</span>
                  <span className="text-ctp-subtext0 text-xs ml-2">actively generating</span>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => onResolveAgent(agent.agentId, 'wait')}
                    className="px-2 py-0.5 text-xs rounded bg-ctp-blue/20 hover:bg-ctp-blue/30 text-ctp-blue transition-colors cursor-pointer"
                  >
                    Wait
                  </button>
                  <button
                    onClick={() => onResolveAgent(agent.agentId, 'interrupt')}
                    className="px-2 py-0.5 text-xs rounded bg-ctp-peach/20 hover:bg-ctp-peach/30 text-ctp-peach transition-colors cursor-pointer"
                  >
                    Interrupt & Resume
                  </button>
                  <button
                    onClick={() => onResolveAgent(agent.agentId, 'kill')}
                    className="px-2 py-0.5 text-xs rounded bg-ctp-red/20 hover:bg-ctp-red/30 text-ctp-red transition-colors cursor-pointer"
                  >
                    Kill
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {idleAgents.length > 0 && (
          <div className="mb-3">
            <div className="text-ctp-subtext0 text-xs mb-2">
              {workingAgents.length > 0 ? 'These agents will resume after restart:' : 'All agents will resume after restart:'}
            </div>
            {idleAgents.map((agent) => (
              <div key={agent.agentId} className="flex items-center justify-between bg-surface-0 rounded-lg px-3 py-2 mb-1">
                <div>
                  <span className={`mr-2 text-xs ${agent.resumeStrategy === 'auto' ? 'text-ctp-yellow' : 'text-ctp-blue'}`}>●</span>
                  <span className="text-ctp-text text-xs font-medium">{agent.agentName}</span>
                </div>
                <span className="text-ctp-subtext0 text-xs">
                  {agent.resumeStrategy === 'auto' ? '✓ Will auto-resume' : '⚠ Manual resume after restart'}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded bg-surface-1 hover:bg-surface-2 text-ctp-subtext0 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            data-testid="update-gate-restart-btn"
            onClick={onConfirm}
            disabled={hasWorking}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              hasWorking
                ? 'bg-ctp-info/10 text-ctp-info/40 cursor-not-allowed'
                : 'bg-ctp-info/20 hover:bg-ctp-info/30 text-ctp-info cursor-pointer'
            }`}
          >
            Restart Now
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/app/UpdateGateModal.test.tsx`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/app/UpdateGateModal.tsx src/renderer/features/app/UpdateGateModal.test.tsx
git commit -m "feat: add UpdateGateModal component for pre-restart agent management"
```

---

### Task 8: Replace UpdateBanner inline confirmation with Update Gate Modal

**Files:**
- Modify: `src/renderer/features/app/UpdateBanner.tsx`
- Modify: `src/renderer/features/app/UpdateBanner.test.tsx`

- [ ] **Step 1: Update UpdateBanner to open Update Gate Modal**

Replace the existing agent confirmation logic in `src/renderer/features/app/UpdateBanner.tsx`. The key changes:

1. Import `UpdateGateModal` and add a `showGate` state
2. Replace the inline `confirming` state with opening the modal
3. Add polling for live agent status while modal is open
4. Route the "Restart Now" through `confirmUpdateRestart` instead of `applyUpdate`

Replace the full file content of `UpdateBanner.tsx`:

```tsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { useUpdateStore } from '../../stores/updateStore';
import { useAgentStore } from '../../stores/agentStore';
import { UpdateGateModal, UpdateGateAgent } from './UpdateGateModal';

export function UpdateBanner() {
  const status = useUpdateStore((s) => s.status);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const applyUpdate = useUpdateStore((s) => s.applyUpdate);
  const openUpdateDownload = useUpdateStore((s) => s.openUpdateDownload);
  const agents = useAgentStore((s) => s.agents);
  const [showGate, setShowGate] = useState(false);
  const [gateAgents, setGateAgents] = useState<UpdateGateAgent[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const isReady = status.state === 'ready';
  const isApplyError = status.state === 'error' && !!status.artifactUrl;
  if ((!isReady && !isApplyError) || dismissed) return null;

  const hasFailedBefore = isReady && status.applyAttempted;
  const useWarningStyle = isApplyError || hasFailedBefore;

  const runningAgents = Object.values(agents).filter((a) => a.status === 'running');
  const hasRunningAgents = runningAgents.length > 0;

  const refreshGateAgents = useCallback(async () => {
    try {
      const live = await window.clubhouse.app.getLiveAgentsForUpdate();
      setGateAgents(
        live.map((a: { agentId: string; projectPath: string; orchestrator: string; isWorking: boolean }) => ({
          ...a,
          agentName: agents[a.agentId]?.name || a.agentId,
          resumeStrategy: (a as { resumeStrategy?: string }).resumeStrategy ||
            (a.orchestrator === 'claude-code' ? 'auto' : 'manual') as 'auto' | 'manual',
        })),
      );
    } catch { /* ignore */ }
  }, [agents]);

  useEffect(() => {
    if (showGate) {
      refreshGateAgents();
      pollRef.current = setInterval(refreshGateAgents, 2000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [showGate, refreshGateAgents]);

  const handleRestart = () => {
    if (hasRunningAgents) {
      setShowGate(true);
      return;
    }
    // No agents — go straight to restart with session capture
    window.clubhouse.app.confirmUpdateRestart({ agentNames: {} });
  };

  const handleGateConfirm = async () => {
    const agentNames: Record<string, string> = {};
    const agentMeta: Record<string, { kind: string; mission?: string; model?: string; worktreePath?: string }> = {};
    for (const a of gateAgents) {
      agentNames[a.agentId] = a.agentName;
      const storeAgent = agents[a.agentId];
      if (storeAgent) {
        agentMeta[a.agentId] = {
          kind: storeAgent.kind || 'durable',
          mission: storeAgent.mission,
          model: storeAgent.model,
          worktreePath: storeAgent.worktreePath,
        };
      }
    }
    setShowGate(false);
    await window.clubhouse.app.confirmUpdateRestart({ agentNames, agentMeta });
  };

  const handleGateResolve = async (agentId: string, action: 'wait' | 'interrupt' | 'kill') => {
    if (action === 'wait') return; // polling will pick up when it goes idle
    await window.clubhouse.app.resolveWorkingAgent(agentId, action);
    // If killed, remove from gate list immediately
    if (action === 'kill') {
      setGateAgents((prev) => prev.filter((a) => a.agentId !== agentId));
    }
    // Refresh after a brief delay (let the process react)
    setTimeout(refreshGateAgents, 1000);
  };

  const colorBase = useWarningStyle ? 'ctp-peach' : 'ctp-info';

  return (
    <>
      <div
        className={`flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-${colorBase}/10 border-b border-${colorBase}/20 text-${colorBase} text-sm`}
        data-testid="update-banner"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>

        {isApplyError ? (
          <span className="flex-1" data-testid="update-error-message">
            Update{status.availableVersion ? ` v${status.availableVersion}` : ''} failed to install
            {status.error ? <span className="opacity-60 ml-1">&mdash; {status.error}</span> : ''}
          </span>
        ) : hasFailedBefore ? (
          <span className="flex-1" data-testid="update-retry-message">
            Update v{status.availableVersion} did not apply successfully
          </span>
        ) : (
          <span className="flex-1">
            Update v{status.availableVersion} is ready
            {status.releaseMessage ? (
              <span className={`text-${colorBase}/60 ml-1`} data-testid="update-release-message">&mdash; {status.releaseMessage}</span>
            ) : '.'}
          </span>
        )}

        {isApplyError ? (
          <>
            <button onClick={openUpdateDownload} className={`px-3 py-1 text-xs rounded bg-${colorBase}/20 hover:bg-${colorBase}/30 transition-colors cursor-pointer`} data-testid="update-manual-download-btn">Download manually</button>
            <button onClick={dismiss} className={`text-${colorBase}/50 hover:text-${colorBase} transition-colors cursor-pointer px-1`} data-testid="update-dismiss-btn">x</button>
          </>
        ) : hasFailedBefore ? (
          <>
            {status.artifactUrl && (
              <button onClick={openUpdateDownload} className={`px-3 py-1 text-xs rounded bg-${colorBase}/20 hover:bg-${colorBase}/30 transition-colors cursor-pointer`} data-testid="update-manual-download-btn">Download manually</button>
            )}
            <button onClick={handleRestart} className={`text-${colorBase}/50 hover:text-${colorBase} transition-colors cursor-pointer px-2 text-xs`} data-testid="update-restart-btn">Try again</button>
            <button onClick={dismiss} className={`text-${colorBase}/50 hover:text-${colorBase} transition-colors cursor-pointer px-1`} data-testid="update-dismiss-btn">x</button>
          </>
        ) : (
          <>
            <button onClick={handleRestart} className={`px-3 py-1 text-xs rounded bg-${colorBase}/20 hover:bg-${colorBase}/30 transition-colors cursor-pointer`} data-testid="update-restart-btn">Restart to update</button>
            {status.artifactUrl && (
              <button onClick={openUpdateDownload} className={`text-${colorBase}/50 hover:text-${colorBase} transition-colors cursor-pointer px-2 text-xs`} data-testid="update-manual-download-btn">Download manually</button>
            )}
            <button onClick={dismiss} className={`text-${colorBase}/50 hover:text-${colorBase} transition-colors cursor-pointer px-1`} data-testid="update-dismiss-btn">x</button>
          </>
        )}
      </div>

      {showGate && (
        <UpdateGateModal
          agents={gateAgents}
          onCancel={() => setShowGate(false)}
          onConfirm={handleGateConfirm}
          onResolveAgent={handleGateResolve}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Update tests**

Update `src/renderer/features/app/UpdateBanner.test.tsx` to remove the old inline confirmation tests and add a test that the modal opens instead. Add a test that verifies clicking "Restart to update" with running agents opens the gate modal.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/renderer/features/app/UpdateBanner.test.tsx`
Expected: PASS (may need to update snapshot or mock expectations)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/features/app/UpdateBanner.tsx src/renderer/features/app/UpdateBanner.test.tsx
git commit -m "feat: replace inline agent confirmation with Update Gate Modal"
```

---

## Chunk 3: Resume Banner & Resume Queue

### Task 9: Create the Resume Banner component

**Files:**
- Create: `src/renderer/features/app/ResumeBanner.tsx`
- Test: `src/renderer/features/app/ResumeBanner.test.tsx` (new)

- [ ] **Step 1: Write the test**

Create `src/renderer/features/app/ResumeBanner.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResumeBanner } from './ResumeBanner';

describe('ResumeBanner', () => {
  it('renders nothing when no sessions', () => {
    const { container } = render(<ResumeBanner sessions={[]} onManualResume={vi.fn()} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders session count and statuses', () => {
    render(
      <ResumeBanner
        sessions={[
          { agentId: 'a', agentName: 'darling-gazelle', status: 'resumed' },
          { agentId: 'b', agentName: 'mega-camel', status: 'resuming' },
          { agentId: 'c', agentName: 'zesty-lynx', status: 'manual' },
        ]}
        onManualResume={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/resuming 3 sessions/i)).toBeDefined();
    expect(screen.getByText('darling-gazelle')).toBeDefined();
    expect(screen.getByText(/tap to resume/i)).toBeDefined();
  });

  it('calls onManualResume when tap to resume clicked', () => {
    const onManualResume = vi.fn();
    render(
      <ResumeBanner
        sessions={[{ agentId: 'c', agentName: 'zesty-lynx', status: 'manual' }]}
        onManualResume={onManualResume}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/tap to resume/i));
    expect(onManualResume).toHaveBeenCalledWith('c');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/app/ResumeBanner.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the component**

Create `src/renderer/features/app/ResumeBanner.tsx`:

```tsx
export type ResumeStatus = 'pending' | 'resuming' | 'resumed' | 'failed' | 'manual' | 'timed_out';

export interface ResumeBannerSession {
  agentId: string;
  agentName: string;
  status: ResumeStatus;
  error?: string;
}

interface ResumeBannerProps {
  sessions: ResumeBannerSession[];
  onManualResume: (agentId: string) => void;
  onDismiss: () => void;
}

const STATUS_ICON: Record<ResumeStatus, string> = {
  resumed: '✓',
  resuming: '◌',
  pending: '◌',
  manual: '⚠',
  failed: '✗',
  timed_out: '⏱',
};

const STATUS_COLOR: Record<ResumeStatus, string> = {
  resumed: 'text-ctp-green',
  resuming: 'text-ctp-yellow',
  pending: 'text-ctp-subtext0',
  manual: 'text-ctp-peach',
  failed: 'text-ctp-red',
  timed_out: 'text-ctp-peach',
};

export function ResumeBanner({ sessions, onManualResume, onDismiss }: ResumeBannerProps) {
  if (sessions.length === 0) return null;

  const allResolved = sessions.every((s) => s.status === 'resumed' || s.status === 'failed' || s.status === 'timed_out');

  return (
    <div
      className="flex-shrink-0 bg-ctp-info/10 border-b border-ctp-info/20 text-ctp-info text-sm px-4 py-2"
      data-testid="resume-banner"
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium">
          ↻ Resuming {sessions.length} session{sessions.length !== 1 ? 's' : ''} after update...
        </span>
        <button
          onClick={onDismiss}
          className="text-ctp-info/50 hover:text-ctp-info transition-colors cursor-pointer px-1 text-xs"
        >
          Dismiss
        </button>
      </div>
      {sessions.map((s) => (
        <div key={s.agentId} className="flex items-center gap-2 text-xs py-0.5">
          <span className={STATUS_COLOR[s.status]}>{STATUS_ICON[s.status]}</span>
          <span className="text-ctp-text">{s.agentName}</span>
          {s.status === 'resuming' && <span className="text-ctp-subtext0">resuming...</span>}
          {s.status === 'manual' && (
            <button
              onClick={() => onManualResume(s.agentId)}
              className="text-ctp-peach hover:text-ctp-peach/80 underline cursor-pointer"
            >
              tap to resume
            </button>
          )}
          {s.status === 'failed' && <span className="text-ctp-red">{s.error || 'Resume failed'}</span>}
          {s.status === 'timed_out' && (
            <button
              onClick={() => onManualResume(s.agentId)}
              className="text-ctp-peach hover:text-ctp-peach/80 underline cursor-pointer"
            >
              retry
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/app/ResumeBanner.test.tsx`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/app/ResumeBanner.tsx src/renderer/features/app/ResumeBanner.test.tsx
git commit -m "feat: add ResumeBanner component for post-restart session progress"
```

---

### Task 10: Add resume state to agentLifecycleSlice and wire ResumeBanner

**Files:**
- Modify: `src/renderer/stores/agent/agentLifecycleSlice.ts`
- Modify: `src/renderer/stores/agent/types.ts` (add ResumeStatus to slice type)

- [ ] **Step 1: Add resumingAgents state to the agent store types**

In `src/renderer/stores/agent/types.ts`, add to the `AgentLifecycleSlice` interface:

```typescript
  resumingAgents: Record<string, import('../../features/app/ResumeBanner').ResumeStatus>;
  setResumeStatus: (agentId: string, status: import('../../features/app/ResumeBanner').ResumeStatus) => void;
  clearResumingAgents: () => void;
```

- [ ] **Step 2: Implement in agentLifecycleSlice.ts**

In `createLifecycleSlice`, add the initial state and methods:

```typescript
    resumingAgents: {},

    setResumeStatus: (agentId, status) => {
      set((s) => ({
        resumingAgents: { ...s.resumingAgents, [agentId]: status },
      }));
    },

    clearResumingAgents: () => {
      set({ resumingAgents: {} });
    },
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/stores/agent/agentLifecycleSlice.ts src/renderer/stores/agent/types.ts
git commit -m "feat: add resumingAgents state to agent lifecycle slice"
```

---

### Task 11: Wire resume queue logic in renderer

**Files:**
- Create: `src/renderer/services/resume-queue.ts`

This service listens for pending resume data from the main process on startup, drives the sequential-per-workspace resume queue, and updates the agent store with progress.

- [ ] **Step 1: Create resume queue service**

Create `src/renderer/services/resume-queue.ts`:

```typescript
import { useAgentStore } from '../stores/agentStore';
import type { RestartSessionEntry, RestartSessionState } from '../../shared/types';
import type { ResumeStatus } from '../features/app/ResumeBanner';

const RESUME_TIMEOUT_MS = 60_000;

/**
 * Process pending resume entries after an update restart.
 * Sequential per workspace, parallel across workspaces.
 */
export async function processResumeQueue(state: RestartSessionState): Promise<void> {
  const store = useAgentStore.getState();

  // Group by projectPath for sequential processing
  const byProject = new Map<string, RestartSessionEntry[]>();
  for (const entry of state.sessions) {
    const key = entry.projectPath;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)!.push(entry);
  }

  // Set initial statuses
  for (const entry of state.sessions) {
    const status: ResumeStatus = entry.resumeStrategy === 'manual' ? 'manual' : 'pending';
    store.setResumeStatus(entry.agentId, status);
  }

  // Process all workspaces in parallel, but sequential within each workspace
  await Promise.allSettled(
    [...byProject.entries()].map(([_projectPath, entries]) =>
      processWorkspaceQueue(entries),
    ),
  );
}

async function processWorkspaceQueue(entries: RestartSessionEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.resumeStrategy === 'manual') continue; // User will trigger manually
    await resumeAgent(entry);
  }
}

async function resumeAgent(entry: RestartSessionEntry): Promise<void> {
  const store = useAgentStore.getState();
  store.setResumeStatus(entry.agentId, 'resuming');

  try {
    const cwd = entry.worktreePath || entry.projectPath;

    await window.clubhouse.agent.spawnAgent({
      agentId: entry.agentId,
      projectPath: entry.projectPath,
      cwd,
      kind: entry.kind,
      resume: true,
      sessionId: entry.sessionId || undefined,
      orchestrator: entry.orchestrator,
      model: entry.model,
      mission: entry.mission,
    });

    // Wait for agent to appear as running, with timeout
    await waitForAgentRunning(entry.agentId, RESUME_TIMEOUT_MS);
    store.setResumeStatus(entry.agentId, 'resumed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.setResumeStatus(entry.agentId, 'failed');
    console.error(`Failed to resume agent ${entry.agentId}:`, msg);
  }
}

function waitForAgentRunning(agentId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      useAgentStore.getState().setResumeStatus(agentId, 'timed_out');
      resolve(); // Don't reject — just mark timed out and move on
    }, timeoutMs);

    const check = () => {
      const agent = useAgentStore.getState().agents[agentId];
      if (agent?.status === 'running') {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    };

    // Check immediately
    check();

    // Subscribe to store changes
    const unsubscribe = useAgentStore.subscribe(check);
  });
}

/**
 * Resume a single manual agent (user clicked "Tap to resume").
 */
export async function resumeManualAgent(agentId: string, entry: RestartSessionEntry): Promise<void> {
  await resumeAgent(entry);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/services/resume-queue.ts
git commit -m "feat: add resume queue service for sequential-per-workspace session restore"
```

---

### Task 12: Mount ResumeBanner in the app layout

**Files:**
- Find and modify the top-level layout component that renders `UpdateBanner` — mount `ResumeBanner` below it.

- [ ] **Step 1: Find where UpdateBanner is mounted**

Run: `grep -r 'UpdateBanner' src/renderer/ --include='*.tsx' -l` to find the parent layout.

- [ ] **Step 2: Import and mount ResumeBanner**

In the same parent component, add:

```tsx
import { ResumeBanner } from '../features/app/ResumeBanner';
import { useAgentStore } from '../stores/agentStore';
```

Mount `<ResumeBanner>` below `<UpdateBanner>`, connected to the `resumingAgents` state from the agent store.

- [ ] **Step 3: Initialize the resume listener on app mount**

In the app's root initialization (where `initUpdateListener` is called), add:

```typescript
// Check for pending resumes on startup
window.clubhouse.app.getPendingResumes().then((state) => {
  if (state && state.sessions.length > 0) {
    processResumeQueue(state);
  }
});
```

- [ ] **Step 4: Verify the app compiles and renders**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add -A  # Stage all layout/init changes
git commit -m "feat: mount ResumeBanner and initialize resume queue on startup"
```

---

## Chunk 4: Integration & Edge Cases

### Task 13: Handle edge cases in the resume flow

**Files:**
- Modify: `src/renderer/services/resume-queue.ts`
- Modify: `src/main/services/restart-session-service.ts`

- [ ] **Step 1: Add project directory validation**

In `restart-session-service.ts`, enhance `loadPendingResume` to validate project paths:

```typescript
// After loading and validating the state file, filter out sessions with missing project directories
const validSessions: RestartSessionEntry[] = [];
for (const session of state.sessions) {
  const dirExists = await pathExists(session.worktreePath || session.projectPath);
  if (dirExists) {
    validSessions.push(session);
  } else {
    appLog('update:session-resume', 'warn', `Skipping resume for ${session.agentId} — directory missing: ${session.worktreePath || session.projectPath}`);
  }
}
state.sessions = validSessions;
```

- [ ] **Step 2: Add --continue fallback in resume queue**

In `resume-queue.ts`, update `resumeAgent` to retry with `--continue` if `--resume <id>` fails:

```typescript
// Inside resumeAgent, after the first spawnAgent call fails:
catch (err) {
  // If we had a specific sessionId and it failed, try --continue fallback
  if (entry.sessionId && entry.resumeStrategy === 'auto') {
    try {
      await window.clubhouse.agent.spawnAgent({
        ...spawnParams,
        sessionId: undefined, // --continue instead of --resume <id>
      });
      await waitForAgentRunning(entry.agentId, RESUME_TIMEOUT_MS);
      store.setResumeStatus(entry.agentId, 'resumed');
      return;
    } catch { /* fall through to failure */ }
  }
  // Mark as failed
  store.setResumeStatus(entry.agentId, 'failed');
}
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/services/restart-session-service.ts src/renderer/services/resume-queue.ts
git commit -m "feat: add edge case handling — missing dirs, --continue fallback, timeouts"
```

---

### Task 14: Update existing tests for modified files

**Files:**
- Modify: `src/main/ipc/app-handlers.test.ts` (add new IPC channels to the expected registration list)
- Modify: `src/renderer/features/app/UpdateBanner.test.tsx` (update for new modal flow)

- [ ] **Step 1: Update app-handlers test**

In `src/main/ipc/app-handlers.test.ts`, add the new IPC channels to the expected `handle` registration list (around line 169, where other `IPC.APP.*` channels are listed):

```typescript
IPC.APP.GET_PENDING_RESUMES, IPC.APP.RESUME_MANUAL_AGENT,
IPC.APP.RESOLVE_WORKING_AGENT, IPC.APP.CONFIRM_UPDATE_RESTART,
IPC.APP.GET_LIVE_AGENTS_FOR_UPDATE,
```

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/app-handlers.test.ts src/renderer/features/app/UpdateBanner.test.tsx
git commit -m "test: update existing tests for session resume IPC channels and UpdateBanner changes"
```

---

### Task 15: Final verification and cleanup

- [ ] **Step 1: Run full TypeScript compilation**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Run linter**

Run: `npx eslint src/main/services/restart-session-service.ts src/renderer/features/app/UpdateGateModal.tsx src/renderer/features/app/ResumeBanner.tsx src/renderer/services/resume-queue.ts --fix`
Expected: No errors or auto-fixed

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -A
git commit -m "chore: lint fixes for session resume feature"
```
