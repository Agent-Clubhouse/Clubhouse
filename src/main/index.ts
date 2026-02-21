import { app, BrowserWindow, dialog } from 'electron';
import { registerAllHandlers } from './ipc';
import { killAll } from './services/pty-manager';
import { restoreAll } from './services/config-pipeline';
import { buildMenu } from './menu';
import { getSettings as getThemeSettings } from './services/theme-service';
import { getThemeColorsForTitleBar } from './title-bar-colors';
import * as safeMode from './services/safe-mode';
import { appLog } from './services/log-service';
import { startPeriodicChecks as startUpdateChecks, stopPeriodicChecks as stopUpdateChecks, applyUpdateOnQuit } from './services/auto-update-service';
import * as annexServer from './services/annex-server';

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


declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (require('electron-squirrel-startup')) {
  app.quit();
}

function getThemeColors(): { bg: string; mantle: string; text: string } {
  try {
    const { themeId } = getThemeSettings();
    return getThemeColorsForTitleBar(themeId);
  } catch {
    return getThemeColorsForTitleBar('catppuccin-mocha');
  }
}

let mainWindow: BrowserWindow | null = null;

const createWindow = (): void => {
  const isWin = process.platform === 'win32';
  const themeColors = getThemeColors();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // macOS: hide the native title bar but keep traffic lights
    // Windows: use titleBarOverlay to replace native title bar with themed controls
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

  // Start periodic update checks (respects user's autoUpdate setting)
  startUpdateChecks();

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
  stopUpdateChecks();

  // Silently apply any downloaded update before quitting so the next launch
  // gets the new version without user action.
  try {
    applyUpdateOnQuit();
  } catch (err) {
    appLog('core:shutdown', 'error', `Failed to apply update on quit: ${err instanceof Error ? err.message : String(err)}`);
  }

  annexServer.stop();
  restoreAll();
  killAll();
});
