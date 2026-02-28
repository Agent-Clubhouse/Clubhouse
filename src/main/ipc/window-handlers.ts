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

const popoutWindows = new Map<number, PopoutEntry>();

function getThemeColors(): { bg: string; mantle: string; text: string } {
  try {
    const { themeId } = getThemeSettings();
    return getThemeColorsForTitleBar(themeId);
  } catch {
    return getThemeColorsForTitleBar('catppuccin-mocha');
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
    const allWindows = BrowserWindow.getAllWindows();
    const mainWindow = allWindows.find(w => !popoutWindows.has(w.id) && !w.isDestroyed());
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (agentId) {
        mainWindow.webContents.send(IPC.WINDOW.NAVIGATE_TO_AGENT, agentId);
      }
    }
  });

  // Relay agent state from the main window to a requesting popout window.
  // The popout invokes GET_AGENT_STATE → main process sends REQUEST_AGENT_STATE
  // to the main renderer → main renderer responds via AGENT_STATE_RESPONSE.
  ipcMain.handle(IPC.WINDOW.GET_AGENT_STATE, (_event) => {
    return new Promise((resolve) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (w) => !popoutWindows.has(w.id) && !w.isDestroyed(),
      );
      if (!mainWindow) {
        resolve({ agents: {}, agentDetailedStatus: {}, agentIcons: {} });
        return;
      }

      const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      const channel = `${IPC.WINDOW.AGENT_STATE_RESPONSE}:${requestId}`;

      const handler = (_e: any, state: any) => {
        clearTimeout(timeout);
        resolve(state);
      };

      const timeout = setTimeout(() => {
        ipcMain.removeListener(channel, handler);
        resolve({ agents: {}, agentDetailedStatus: {}, agentIcons: {} });
      }, 5000);

      ipcMain.once(channel as any, handler);

      mainWindow.webContents.send(IPC.WINDOW.REQUEST_AGENT_STATE, requestId);
    });
  });

  // Forward state responses from the main renderer back to the correct
  // ipcMain.once listener keyed by requestId.
  ipcMain.on(IPC.WINDOW.AGENT_STATE_RESPONSE, (_event, requestId: string, state: any) => {
    // Re-emit on the keyed channel so the handle() above resolves
    ipcMain.emit(`${IPC.WINDOW.AGENT_STATE_RESPONSE}:${requestId}`, _event, state);
  });

  // ── Hub state sync (leader/follower) ─────────────────────────────────
  //
  // Same relay pattern as agent state: pop-out → main process → main
  // renderer → main process → pop-out. The main window's hub store is
  // the single authority; pop-outs are followers.

  // Pop-out requests current hub state snapshot
  ipcMain.handle(IPC.WINDOW.GET_HUB_STATE, (_event, hubId: string, scope: string, projectId?: string) => {
    return new Promise((resolve) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (w) => !popoutWindows.has(w.id) && !w.isDestroyed(),
      );
      if (!mainWindow) {
        resolve(null);
        return;
      }

      const requestId = `hub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      const channel = `${IPC.WINDOW.HUB_STATE_RESPONSE}:${requestId}`;

      const handler = (_e: any, state: any) => {
        clearTimeout(timeout);
        resolve(state);
      };

      const timeout = setTimeout(() => {
        ipcMain.removeListener(channel, handler);
        resolve(null);
      }, 5000);

      ipcMain.once(channel as any, handler);

      mainWindow.webContents.send(IPC.WINDOW.REQUEST_HUB_STATE, requestId, hubId, scope, projectId);
    });
  });

  // Forward hub state responses from the main renderer
  ipcMain.on(IPC.WINDOW.HUB_STATE_RESPONSE, (_event, requestId: string, state: any) => {
    ipcMain.emit(`${IPC.WINDOW.HUB_STATE_RESPONSE}:${requestId}`, _event, state);
  });

  // Main renderer broadcasts hub state changes → forward to all pop-outs
  ipcMain.on(IPC.WINDOW.HUB_STATE_CHANGED, (_event, state: any) => {
    for (const [, entry] of popoutWindows) {
      if (!entry.window.isDestroyed()) {
        entry.window.webContents.send(IPC.WINDOW.HUB_STATE_CHANGED, state);
      }
    }
  });

  // Pop-out sends a hub mutation → forward to main renderer
  ipcMain.on(IPC.WINDOW.HUB_MUTATION, (_event, hubId: string, scope: string, mutation: any, projectId?: string) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (w) => !popoutWindows.has(w.id) && !w.isDestroyed(),
    );
    if (mainWindow) {
      mainWindow.webContents.send(IPC.WINDOW.REQUEST_HUB_MUTATION, hubId, scope, mutation, projectId);
    }
  });
}
