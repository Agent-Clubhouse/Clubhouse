import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getSettings as getThemeSettings } from '../services/theme-service';
import { getThemeColorsForTitleBar } from '../title-bar-colors';
import { appLog } from '../services/log-service';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

export interface PopoutParams {
  type: 'agent' | 'hub';
  agentId?: string;
  hubId?: string;
  projectId?: string;
  title?: string;
}

interface PopoutEntry {
  window: BrowserWindow;
  params: PopoutParams;
}

interface AgentStateSnapshot {
  agents: Record<string, unknown>;
  agentDetailedStatus: Record<string, unknown>;
  agentIcons: Record<string, string>;
}

interface HubStateSnapshot {
  hubId: string;
  paneTree: unknown;
  focusedPaneId: string;
  zoomedPaneId: string | null;
}

const EMPTY_AGENT_STATE: AgentStateSnapshot = { agents: {}, agentDetailedStatus: {}, agentIcons: {} };

/** Reduced timeout for relay round-trips (was 5s). */
const RELAY_TIMEOUT_MS = 1500;

const popoutWindows = new Map<number, PopoutEntry>();

// ── State caches ──────────────────────────────────────────────────────────
// The main renderer broadcasts state changes which we cache here.
// GET_AGENT_STATE / GET_HUB_STATE can serve from cache instantly instead
// of performing a round-trip relay.

let cachedAgentState: AgentStateSnapshot | null = null;

/** Hub state keyed by hubId. */
const cachedHubState = new Map<string, HubStateSnapshot>();

// ── Batching ──────────────────────────────────────────────────────────────
// When the cache is cold (e.g. first popout before any broadcast),
// concurrent GET requests are batched so only one relay round-trip fires.

let pendingAgentRelay: Promise<AgentStateSnapshot> | null = null;

/** @internal Reset module state for testing. */
export function _resetForTesting(): void {
  popoutWindows.clear();
  cachedAgentState = null;
  cachedHubState.clear();
  pendingAgentRelay = null;
}

function getThemeColors(): { bg: string; mantle: string; text: string } {
  try {
    const { themeId } = getThemeSettings();
    return getThemeColorsForTitleBar(themeId);
  } catch {
    return getThemeColorsForTitleBar('catppuccin-mocha');
  }
}

function findMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(
    (w) => !popoutWindows.has(w.id) && !w.isDestroyed(),
  );
}

/**
 * Relay agent state from the main renderer. Batches concurrent requests
 * so only one IPC round-trip is fired.
 */
function relayAgentState(): Promise<AgentStateSnapshot> {
  if (pendingAgentRelay) return pendingAgentRelay;

  pendingAgentRelay = new Promise<AgentStateSnapshot>((resolve) => {
    const mainWindow = findMainWindow();
    if (!mainWindow) {
      resolve(EMPTY_AGENT_STATE);
      return;
    }

    const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const channel = `${IPC.WINDOW.AGENT_STATE_RESPONSE}:${requestId}`;

    const handler = (_e: any, state: AgentStateSnapshot) => {
      clearTimeout(timeout);
      cachedAgentState = state;
      resolve(state);
    };

    const timeout = setTimeout(() => {
      ipcMain.removeListener(channel, handler);
      resolve(cachedAgentState ?? EMPTY_AGENT_STATE);
    }, RELAY_TIMEOUT_MS);

    ipcMain.once(channel as any, handler);
    mainWindow.webContents.send(IPC.WINDOW.REQUEST_AGENT_STATE, requestId);
  }).finally(() => {
    pendingAgentRelay = null;
  });

  return pendingAgentRelay;
}

function broadcastToPopouts(channel: string, ...args: any[]): void {
  for (const [, entry] of popoutWindows) {
    if (!entry.window.isDestroyed()) {
      entry.window.webContents.send(channel, ...args);
    }
  }
}

export function registerWindowHandlers(): void {
  ipcMain.handle(IPC.WINDOW.CREATE_POPOUT, (_event, params: PopoutParams) => {
    const themeColors = getThemeColors();
    const isWin = process.platform === 'win32';

    const additionalArguments = [
      `--popout-type=${params.type}`,
    ];
    if (params.agentId) additionalArguments.push(`--popout-agent-id=${params.agentId}`);
    if (params.hubId) additionalArguments.push(`--popout-hub-id=${params.hubId}`);
    if (params.projectId) additionalArguments.push(`--popout-project-id=${params.projectId}`);

    const win = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 400,
      minHeight: 300,
      title: params.title || `Clubhouse — ${params.type === 'agent' ? 'Agent' : 'Hub'}`,
      show: false,
      ...(isWin
        ? {
            titleBarStyle: 'hidden',
            titleBarOverlay: {
              color: themeColors.mantle,
              symbolColor: themeColors.text,
              height: 38,
            },
          }
        : { titleBarStyle: 'hiddenInset' as const }),
      backgroundColor: themeColors.bg,
      webPreferences: {
        preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments,
      },
    });

    const windowId = win.id;
    popoutWindows.set(windowId, { window: win, params });

    win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

    win.once('ready-to-show', () => {
      win.show();
    });

    win.on('closed', () => {
      popoutWindows.delete(windowId);
      appLog('core:window', 'info', 'Pop-out window closed', { meta: { windowId } });
    });

    appLog('core:window', 'info', 'Pop-out window created', {
      meta: { windowId, type: params.type, agentId: params.agentId },
    });

    return windowId;
  });

  ipcMain.handle(IPC.WINDOW.CLOSE_POPOUT, (_event, windowId: number) => {
    const entry = popoutWindows.get(windowId);
    if (entry && !entry.window.isDestroyed()) {
      entry.window.close();
    }
    popoutWindows.delete(windowId);
  });

  ipcMain.handle(IPC.WINDOW.LIST_POPOUTS, () => {
    const list: Array<{ windowId: number; params: PopoutParams }> = [];
    const staleIds: number[] = [];
    for (const [windowId, entry] of popoutWindows) {
      if (!entry.window.isDestroyed()) {
        list.push({ windowId, params: entry.params });
      } else {
        staleIds.push(windowId);
      }
    }
    // Clean up stale entries for destroyed windows
    for (const id of staleIds) {
      popoutWindows.delete(id);
    }
    return list;
  });

  ipcMain.handle(IPC.WINDOW.FOCUS_MAIN, (_event, agentId?: string) => {
    const mainWindow = findMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (agentId) {
        mainWindow.webContents.send(IPC.WINDOW.NAVIGATE_TO_AGENT, agentId);
      }
    }
  });

  // ── Agent state sync ────────────────────────────────────────────────────
  //
  // The main renderer broadcasts AGENT_STATE_CHANGED on every store change.
  // We cache the latest snapshot and forward it to all popouts.
  // GET_AGENT_STATE serves from cache when available; otherwise it falls
  // back to a batched relay round-trip with a reduced 1.5s timeout.

  ipcMain.handle(IPC.WINDOW.GET_AGENT_STATE, () => {
    if (cachedAgentState) return cachedAgentState;
    return relayAgentState();
  });

  // Forward relay responses from main renderer → keyed ipcMain.once listener
  ipcMain.on(IPC.WINDOW.AGENT_STATE_RESPONSE, (_event, requestId: string, state: any) => {
    ipcMain.emit(`${IPC.WINDOW.AGENT_STATE_RESPONSE}:${requestId}`, _event, state);
  });

  // Main renderer broadcasts agent state changes → cache + forward to popouts
  ipcMain.on(IPC.WINDOW.AGENT_STATE_CHANGED, (_event, state: AgentStateSnapshot) => {
    cachedAgentState = state;
    broadcastToPopouts(IPC.WINDOW.AGENT_STATE_CHANGED, state);
  });

  // ── Hub state sync (leader/follower) ─────────────────────────────────
  //
  // Same pattern: cache from HUB_STATE_CHANGED broadcasts, serve from
  // cache on GET_HUB_STATE, fall back to batched relay with 1.5s timeout.

  ipcMain.handle(IPC.WINDOW.GET_HUB_STATE, (_event, hubId: string, scope: string, projectId?: string) => {
    const cached = cachedHubState.get(hubId);
    if (cached) return cached;

    return new Promise((resolve) => {
      const mainWindow = findMainWindow();
      if (!mainWindow) {
        resolve(null);
        return;
      }

      const requestId = `hub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      const channel = `${IPC.WINDOW.HUB_STATE_RESPONSE}:${requestId}`;

      const handler = (_e: any, state: any) => {
        clearTimeout(timeout);
        if (state && state.hubId) cachedHubState.set(state.hubId, state);
        resolve(state);
      };

      const timeout = setTimeout(() => {
        ipcMain.removeListener(channel, handler);
        resolve(null);
      }, RELAY_TIMEOUT_MS);

      ipcMain.once(channel as any, handler);
      mainWindow.webContents.send(IPC.WINDOW.REQUEST_HUB_STATE, requestId, hubId, scope, projectId);
    });
  });

  // Forward hub state relay responses from the main renderer
  ipcMain.on(IPC.WINDOW.HUB_STATE_RESPONSE, (_event, requestId: string, state: any) => {
    ipcMain.emit(`${IPC.WINDOW.HUB_STATE_RESPONSE}:${requestId}`, _event, state);
  });

  // Main renderer broadcasts hub state changes → cache + forward to popouts
  ipcMain.on(IPC.WINDOW.HUB_STATE_CHANGED, (_event, state: any) => {
    if (state && state.hubId) cachedHubState.set(state.hubId, state);
    broadcastToPopouts(IPC.WINDOW.HUB_STATE_CHANGED, state);
  });

  // Pop-out sends a hub mutation → forward to main renderer
  ipcMain.on(IPC.WINDOW.HUB_MUTATION, (_event, hubId: string, scope: string, mutation: any, projectId?: string) => {
    const mainWindow = findMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC.WINDOW.REQUEST_HUB_MUTATION, hubId, scope, mutation, projectId);
    }
  });
}
