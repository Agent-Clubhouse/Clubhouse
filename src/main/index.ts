import { app, BrowserWindow, dialog } from 'electron';
import { registerAllHandlers } from './ipc';
import { killAll } from './services/pty-manager';
import { restoreAll } from './services/config-pipeline';
import { buildMenu } from './menu';
import { getSettings as getThemeSettings } from './services/theme-service';
import * as safeMode from './services/safe-mode';
import { appLog } from './services/log-service';

// Set the app name early so the dock, menu bar, and notifications all say "Clubhouse"
// instead of "Electron" during development.
app.name = 'Clubhouse';

// Catch-all handlers for truly unexpected errors. These fire *after* logService.init()
// has been called (in registerAllHandlers), so early crashes before `ready` won't log —
// but those are visible in stderr anyway.
process.on('uncaughtException', (err) => {
  appLog('core:process', 'fatal', 'Uncaught exception', {
    meta: { error: err.message, stack: err.stack },
  });
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  appLog('core:process', 'error', 'Unhandled promise rejection', {
    meta: { error: msg, stack },
  });
});

app.setAboutPanelOptions({
  applicationName: 'Clubhouse',
  applicationVersion: app.getVersion(),
  copyright: 'Supported Plugin API Versions: 0.1, 0.2',
});

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (require('electron-squirrel-startup')) {
  app.quit();
}

const THEME_BG_COLORS: Record<string, string> = {
  'catppuccin-mocha': '#1e1e2e',
  'catppuccin-latte': '#eff1f5',
  'solarized-dark': '#002b36',
  'terminal': '#0a0a0a',
  'nord': '#2e3440',
  'dracula': '#282a36',
  'tokyo-night': '#1a1b26',
  'gruvbox-dark': '#282828',
};

function getThemeBgColor(): string {
  try {
    const { themeId } = getThemeSettings();
    return THEME_BG_COLORS[themeId] || '#1e1e2e';
  } catch {
    return '#1e1e2e';
  }
}

let mainWindow: BrowserWindow | null = null;

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: getThemeBgColor(),
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Show window once the renderer is ready (avoids white flash on startup).
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

app.on('ready', () => {
  registerAllHandlers();
  buildMenu();

  appLog('core:startup', 'info', `Clubhouse v${app.getVersion()} starting`, {
    meta: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      packaged: app.isPackaged,
    },
  });

  // Safe mode: check --safe-mode flag or startup marker crash counter
  const forceSafeMode = process.argv.includes('--safe-mode');
  if (!forceSafeMode && safeMode.shouldShowSafeModeDialog()) {
    const marker = safeMode.readMarker();
    const pluginList = marker?.lastEnabledPlugins?.join(', ') || 'unknown';
    appLog('core:safe-mode', 'warn', 'Startup crash loop detected, prompting safe mode', {
      meta: { attempt: marker?.attempt, lastEnabledPlugins: marker?.lastEnabledPlugins },
    });
    const response = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Clubhouse — Safe Mode',
      message: 'Clubhouse failed to start properly on the last attempt.',
      detail: `This may be caused by a plugin. Last enabled plugins: ${pluginList}\n\nWould you like to start in safe mode (all plugins disabled)?`,
      buttons: ['Start in Safe Mode', 'Try Again Normally'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      appLog('core:safe-mode', 'warn', 'User chose safe mode — disabling all plugins');
      // Safe mode — clear marker so we don't loop, renderer will see safeModeActive
      safeMode.clearMarker();
      // Set env var so renderer knows to activate safe mode
      process.env.CLUBHOUSE_SAFE_MODE = '1';
    }
  }

  if (forceSafeMode) {
    appLog('core:safe-mode', 'warn', 'Safe mode forced via --safe-mode flag');
    safeMode.clearMarker();
    process.env.CLUBHOUSE_SAFE_MODE = '1';
  }

  createWindow();

  // macOS notification permission is triggered on-demand when the user
  // sends their first test notification or an agent event fires.
  // The app must be codesigned (even ad-hoc) for macOS to show the prompt.
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  appLog('core:shutdown', 'info', 'App shutting down, restoring configs and killing all PTY sessions');
  restoreAll();
  killAll();
});
