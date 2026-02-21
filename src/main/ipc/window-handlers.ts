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
    for (const [windowId, entry] of popoutWindows) {
      if (!entry.window.isDestroyed()) {
        list.push({ windowId, params: entry.params });
      }
    }
    return list;
  });
}
