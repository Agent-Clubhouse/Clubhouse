import * as path from 'path';
import { app, BrowserWindow, dialog, powerMonitor } from 'electron';
import { registerAllHandlers } from './ipc';
import { killAll, startStaleSweep as startPtyStaleSweep, stopStaleSweep as stopPtyStaleSweep } from './services/pty-manager';
import { cleanupWatchesForWindow, stopAllWatches } from './services/file-watch-service';
import { startStaleSweep as startHeadlessStaleSweep, stopStaleSweep as stopHeadlessStaleSweep } from './services/headless-manager';
import { restoreAll } from './services/config-pipeline';
import { buildMenu } from './menu';
import { getSettings as getThemeSettings } from './services/theme-service';
import { getThemeColorsForTitleBar } from './title-bar-colors';
import * as safeMode from './services/safe-mode';
import { appLog } from './services/log-service';
import { startPeriodicChecks as startUpdateChecks, stopPeriodicChecks as stopUpdateChecks, applyUpdateOnQuit } from './services/auto-update-service';
import { startPeriodicPluginUpdateChecks, stopPeriodicPluginUpdateChecks } from './services/plugin-update-service';
import * as annexServer from './services/annex-server';
import { bridgeServer as mcpBridgeServer } from './services/clubhouse-mcp';
import { flushAllPending as flushPendingBroadcasts } from './util/ipc-broadcast';
import { flushAllAgentConfigs } from './services/agent-config';
import { preWarmShellEnvironment } from './util/shell';
import { initializeRipgrep } from './services/search-service';
import { loadPendingResume } from './services/restart-session-service';
import { isAllowedNavigation } from './navigation-guard';

// Allow overriding userData path for running multiple isolated instances (e.g. testing,
// dual-instance Annex V2 workflows). Must be set before app.name so that any early
// app.getPath('userData') calls after 'ready' resolve to the custom directory.
if (process.env.CLUBHOUSE_USER_DATA) {
  app.setPath('userData', process.env.CLUBHOUSE_USER_DATA);
}

// Set the app name early so the dock, menu bar, and notifications all say "Clubhouse"
// instead of "Electron" during development.
app.name = 'Clubhouse';

// Windows requires an explicit AppUserModelID for toast notifications to work.
// This must match the ID used by the Squirrel installer's Start Menu shortcut
// so Windows can associate notifications with the correct app.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.mason-allen.clubhouse');
}

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
    icon: path.resolve(__dirname, 'icon.png'),
    autoHideMenuBar: true,
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
      webviewTag: true,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Block navigation to external URLs — prevents renderer or plugin from loading
  // arbitrary content. Allow only the app's own URLs (file:// or dev server).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      appLog('core:security', 'warn', `Blocked navigation to external URL: ${url}`);
    }
  });

  // Block window.open() and <a target="_blank"> from opening external URLs.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedNavigation(url)) {
      appLog('core:security', 'warn', `Blocked window.open to external URL: ${url}`);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  // SEC-11: Restrict webview creation to safe URL schemes.
  // webviewTag is enabled for the built-in browser plugin, but without this
  // guard any renderer code (including community plugins) could create webviews
  // loading javascript: or data: URLs to bypass CSP and exfiltrate data.
  // file:// URLs are gated behind the allowLocalFileWebviews setting.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    // Enforce security defaults on all webviews
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    (webPreferences as Record<string, unknown>).nodeIntegrationInSubFrames = false;

    const src = params.src || '';
    if (!src || src.startsWith('about:blank')) return;

    const isHttp = src.startsWith('http://') || src.startsWith('https://');
    const isFile = src.startsWith('file://');

    if (isHttp) return; // always allowed

    if (isFile) {
      const { securitySettings } = require('./ipc/settings-handlers');
      const settings = securitySettings.get();
      if (settings.allowLocalFileWebviews) return; // user opted in

      appLog('core:security', 'info', 'Blocked file:// webview — enable "Allow local file webviews" in Settings > Security', {
        meta: { src: src.slice(0, 200) },
      });
      event.preventDefault();
      return;
    }

    // Block all other schemes (javascript:, data:, blob:, etc.)
    appLog('core:security', 'warn', 'Blocked webview with disallowed URL scheme', {
      meta: { src: src.slice(0, 200) },
    });
    event.preventDefault();
  });


  // Clean up file watchers when the window is about to close (before webContents is destroyed)
  mainWindow.on('close', () => {
    if (mainWindow) {
      cleanupWatchesForWindow(mainWindow);
    }
  });

  // Show window once the renderer is ready (avoids white flash on startup).
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

app.on('ready', () => {
  // Pre-warm the shell environment cache in background so the first agent
  // wake doesn't pay the 500ms–2s login shell penalty.
  preWarmShellEnvironment();

  // Pre-resolve ripgrep binary path in background so the first search
  // doesn't block the main process with a synchronous `which` call.
  initializeRipgrep();

  registerAllHandlers();
  buildMenu();

  // Resume satellite connections when the machine wakes from sleep
  powerMonitor.on('resume', () => {
    try {
      const annexClient = require('./services/annex-client');
      annexClient.resumeAllConnections();
    } catch { /* annex client may not be loaded */ }
  });

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

  // Start periodic plugin update checks
  startPeriodicPluginUpdateChecks();

  // Start stale session sweeps (safety net for leaked sessions)
  startPtyStaleSweep();
  startHeadlessStaleSweep();

  // Check for pending session resumes from a previous update restart.
  // Just log here — the renderer reads the file via GET_PENDING_RESUMES IPC
  // and clears it after processing. We don't clear here to avoid a race
  // condition where the file is deleted before the renderer reads it.
  loadPendingResume().then((pendingState) => {
    if (pendingState && pendingState.sessions.length > 0) {
      appLog('core:startup', 'info', `Found ${pendingState.sessions.length} sessions to resume after update`);
    }
  }).catch((err) => {
    appLog('core:startup', 'error', `Failed to load pending resumes: ${err instanceof Error ? err.message : String(err)}`);
  });

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

let isQuitting = false;
app.on('before-quit', (event) => {
  if (isQuitting) return; // Re-entrance guard — already shutting down
  isQuitting = true;

  appLog('core:shutdown', 'info', 'App shutting down, restoring configs and killing all PTY sessions');
  stopUpdateChecks();
  stopPeriodicPluginUpdateChecks();

  // Silently apply any downloaded update before quitting so the next launch
  // gets the new version without user action.
  try {
    applyUpdateOnQuit();
  } catch (err) {
    appLog('core:shutdown', 'error', `Failed to apply update on quit: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Flush any pending throttled IPC broadcasts before tearing down
  flushPendingBroadcasts();

  stopPtyStaleSweep();
  stopHeadlessStaleSweep();
  annexServer.stop();
  mcpBridgeServer.stop();
  restoreAll();
  stopAllWatches();

  // Delay quit to await async cleanup (killAll, flushAllAgentConfigs).
  // Without this, Electron may exit before PTY processes are terminated,
  // leaving orphaned processes.
  event.preventDefault();
  Promise.all([
    killAll().catch((err) => {
      appLog('core:shutdown', 'error', `Failed to kill PTY sessions: ${err instanceof Error ? err.message : String(err)}`);
    }),
    flushAllAgentConfigs().catch((err) => {
      appLog('core:shutdown', 'error', `Failed to flush agent configs: ${err instanceof Error ? err.message : String(err)}`);
    }),
  ]).finally(() => {
    app.quit();
  });
});
