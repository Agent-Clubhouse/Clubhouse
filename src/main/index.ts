import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, ipcMain, powerMonitor, session, net, protocol } from 'electron';
import { cleanupTranscriptStaging } from './services/agent-runtime/chat-transcript';
import { registerAllHandlers } from './ipc';
import { configurePluginMcpHost } from './ipc/plugin-mcp-handlers';
import { startStaleSweep as startPtyStaleSweep, stopStaleSweep as stopPtyStaleSweep } from './services/pty-manager';
import { cleanupWatchesForWindow, getActiveWatchCount, stopAllWatches } from './services/file-watch-service';
import { startStaleSweep as startHeadlessStaleSweep, stopStaleSweep as stopHeadlessStaleSweep } from './services/headless-manager';
import { buildMenu } from './menu';
import { getSettings as getThemeSettings } from './services/theme-service';
import { getThemeColorsForTitleBar } from './title-bar-colors';
import * as safeMode from './services/safe-mode';
import { appLog } from './services/log-service';
import { startPeriodicChecks as startUpdateChecks, stopPeriodicChecks as stopUpdateChecks, applyUpdateOnQuit, shouldAutoCheckOnStartup } from './services/auto-update-service';
import { startPeriodicPluginUpdateChecks, stopPeriodicPluginUpdateChecks } from './services/plugin-update-service';
import * as annexServer from './services/annex-server';
import { bridgeServer as mcpBridgeServer } from './services/clubhouse-mcp';
import { flushAllPending as flushPendingBroadcasts } from './util/ipc-broadcast';
import { preWarmShellEnvironment } from './util/shell';
import { initializeRipgrep } from './services/search-service';
import { loadPendingResume } from './services/restart-session-service';
import { applyWindowSecurityGuards } from './window-security-guards';
import { generateCspNonce, getCspNonce, buildProductionCsp } from './csp-nonce';
import { createBeforeQuitHandler } from './shutdown-guard';
import { runAppShutdown, setShutdownBegin } from './services/app-shutdown';
import { initProtocolHandler } from './services/protocol-service';
import { resolvePluginModulePath, pluginModuleResponseHeaders } from './plugin-protocol';
import { PLUGIN_PROTOCOL_SCHEME } from '../shared/plugin-protocol-url';
import { getCommunityPluginsDir } from './services/plugin-discovery';
import { getGlobalPluginDataDir } from './services/plugin-storage';
import { cleanupRetiredPluginData } from './services/retired-plugin-cleanup';
import * as projectStore from './services/project-store';
import { initTelemetry, recordAppSession, flushBeforeExit, tel, ATTR } from './telemetry';
import { installCrashTelemetry, reportMainProcessError } from './telemetry/crash-handlers';
import { installHealthTelemetry } from './telemetry/health';
import { installWorkspaceTelemetry } from './telemetry/workspace-gauges';
import {
  checkPreviousSession,
  completeStartup,
  installLifecycleTelemetry,
  markStartup,
} from './telemetry/lifecycle';
import { onRendererReady } from './telemetry/renderer-bridge';
import { registerTelemetryRendererHandlers } from './ipc/telemetry-renderer-handlers';
import { configuredRecordingLevel } from './telemetry/bootstrap';
import { installAgentTelemetry } from './telemetry/agent-telemetry';
import { installChatTelemetry } from './telemetry/chat-telemetry';
import { installIpcTelemetry } from './telemetry/ipc-telemetry';
import { getAgentOrchestrator } from './services/agent-registry';
import { NEW_CHROME_ARG } from '../shared/chrome-flag';
import { windowsPtyLaunchArgs } from './util/windows-pty';
import { newChromeEnabled, titleBarOptions } from './window-chrome';
import { shutdownFeedback, startFeedback } from './services/framebriar';

// On macOS, Electron's readable PTY handles can occupy the default four libuv
// workers indefinitely, starving every fs.promises operation after an agent
// starts. Force libuv to initialize a larger app pool, then remove only the
// value injected here so spawned agent processes do not inherit 64 workers.
if (process.platform === 'darwin' && !process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '64';
  fs.stat(process.execPath, () => {});
  delete process.env.UV_THREADPOOL_SIZE;
}

// Allow overriding userData path for running multiple isolated instances (e.g. testing,
// dual-instance Annex V2 workflows). Must be set before app.name so that any early
// app.getPath('userData') calls after 'ready' resolve to the custom directory.
if (process.env.CLUBHOUSE_USER_DATA) {
  app.setPath('userData', process.env.CLUBHOUSE_USER_DATA);
  // Several app-owned registries intentionally live below app.getPath('home')
  // rather than userData. Redirect home as well for explicitly isolated
  // instances so E2E workers and Annex dual-instance tests cannot share
  // projects, agent state, or group-project state with another app process.
  app.setPath('home', process.env.CLUBHOUSE_USER_DATA);
}

// Opt-in telemetry export (experimental.telemetry). Reads its settings after
// the userData override above; when enabled, the SDK chunk loads in the
// background and never blocks `ready`. When disabled, nothing is imported.
initTelemetry();
// Renderer → main telemetry IPC and crash/hang signals (spec §4.2, §6.2).
// Both are inert while telemetry is off.
registerTelemetryRendererHandlers({
  getMainWebContentsId: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : undefined),
  getConfiguredLevel: () => configuredRecordingLevel(),
});
installCrashTelemetry();
installLifecycleTelemetry();
installAgentTelemetry(getAgentOrchestrator);
installChatTelemetry();
// Before registerAllHandlers, so every app invoke handler is timed at the
// Detailed level. Telemetry's own handlers (registered above) stay untimed.
installIpcTelemetry(ipcMain);
// The startup span (§4.1) ends when the main window's initApp() resolves.
onRendererReady((atMs, marks) => completeStartup(marks, undefined, atMs));

// Set the app name early so the dock, menu bar, and notifications all say "Clubhouse"
// instead of "Electron" during development.
app.name = 'Clubhouse';

// Windows requires an explicit AppUserModelID for toast notifications to work.
// This must match the ID used by the Squirrel installer's Start Menu shortcut
// so Windows can associate notifications with the correct app.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.mason-allen.clubhouse');
}

// Register the custom plugin-module scheme as privileged. MUST run before the
// app 'ready' event (i.e. at module load), per Electron. `standard` makes
// relative ESM imports resolve via normal URL resolution; `secure` keeps it a
// secure context; `supportFetchAPI` + `corsEnabled` let the dev renderer
// (http://localhost) import cross-origin when the handler returns ACAO. The
// handler itself is wired after 'ready' (see below).
protocol.registerSchemesAsPrivileged([
  {
    scheme: PLUGIN_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// Catch-all handlers for truly unexpected errors. These fire *after* logService.init()
// has been called (in registerAllHandlers), so early crashes before `ready` won't log —
// but those are visible in stderr anyway.
process.on('uncaughtException', (err) => {
  appLog('core:process', 'fatal', 'Uncaught exception', {
    meta: { error: err.message, stack: err.stack },
  });
  reportMainProcessError(err, 'uncaught');
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  appLog('core:process', 'error', 'Unhandled promise rejection', {
    meta: { error: msg, stack },
  });
  reportMainProcessError(reason, 'unhandled-rejection');
});


declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

// Register the clubhouse:// protocol and acquire the single-instance lock as
// early as possible. If another instance already holds the lock, this one
// hands its protocol argv to the running instance (via second-instance) and
// quits immediately.
const gotInstanceLock = initProtocolHandler({
  getWindow: () => mainWindow,
  listProjects: () => projectStore.list(),
});
if (!gotInstanceLock) {
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

const createWindow = (): void => {
  const themeColors = getThemeColors();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: path.resolve(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    // macOS keeps the traffic lights; Windows (and Linux in the new layout)
    // draws themed controls over the app's title bar (window-chrome.ts).
    ...titleBarOptions(process.platform, newChromeEnabled(), themeColors),
    backgroundColor: themeColors.bg,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // The chrome layout and pty backend are fixed per session; preload reads
      // them synchronously.
      additionalArguments: [...(newChromeEnabled() ? [NEW_CHROME_ARG] : []), ...windowsPtyLaunchArgs()],
    },
  });

  markStartup('create_window_start');
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  // A main window that never loads also ends the startup span, as a failure.
  mainWindow.webContents.once('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) completeStartup(undefined, 'window_load_failed');
  });

  // Apply security guards (will-navigate, setWindowOpenHandler, will-attach-webview)
  applyWindowSecurityGuards(mainWindow);


  // Clean up file watchers when the window is about to close (before webContents is destroyed)
  mainWindow.on('close', () => {
    if (mainWindow) {
      cleanupWatchesForWindow(mainWindow);
    }
  });

  // Show window once the renderer is ready (avoids white flash on startup).
  mainWindow.once('ready-to-show', () => {
    markStartup('window_ready_to_show');
    mainWindow?.show();
  });

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

app.on('ready', () => {
  void cleanupTranscriptStaging();
  // Pre-warm the shell environment cache in background so the first agent
  // wake doesn't pay the 500ms–2s login shell penalty.
  preWarmShellEnvironment();

  // Pre-resolve ripgrep binary path in background so the first search
  // doesn't block the main process with a synchronous `which` call.
  initializeRipgrep();

  // Safe mode: check --safe-mode flag or startup marker crash counter.
  // Must run before registerAllHandlers(), which reads CLUBHOUSE_SAFE_MODE
  // when initializing trusted manifests.
  markStartup('ready');
  const crashLoop = safeMode.shouldShowSafeModeDialog();
  safeMode.handleSafeModeStartup();
  recordAppSession();
  checkPreviousSession(crashLoop);
  installHealthTelemetry();
  installWorkspaceTelemetry({
    projectCount: async () => (await projectStore.list()).length,
    activeWatchCount: getActiveWatchCount,
  });

  markStartup('register_ipc_start');
  registerAllHandlers();
  // Only the main window's app page may mint plugin MCP tokens.
  configurePluginMcpHost({
    getMainWebContentsId: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : undefined),
    entryUrl: MAIN_WINDOW_WEBPACK_ENTRY,
  });
  markStartup('register_ipc_end');
  buildMenu();

  // Resume satellite connections when the machine wakes from sleep
  // and notify clipboard guard to defer reads during pasteboard warmup.
  powerMonitor.on('resume', () => {
    try {
      const { notifyResume } = require('./services/clipboard-guard');
      notifyResume();
    } catch { /* clipboard guard may not be loaded */ }
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

  // Generate a per-run CSP nonce before creating any windows.
  // The nonce is injected into index.html and the CSP header so that inline
  // scripts (import map, flash-prevention) are allowed while unsafe-inline is
  // removed from script-src. Only applied to file:// (production) requests —
  // dev mode uses the webpack dev server which has its own CSP relaxations.
  const cspNonce = generateCspNonce();

  // Intercept file:// requests so we can inject the nonce into index.html.
  // All other file:// requests are passed through unchanged.
  session.defaultSession.protocol.handle('file', async (request) => {
    const rawPath = decodeURIComponent(
      new URL(request.url).pathname,
    );
    // On Windows, pathname is '/C:/path' — strip the leading slash.
    const filePath = process.platform === 'win32' && /^\/[A-Za-z]:\//.test(rawPath)
      ? rawPath.slice(1)
      : rawPath;

    if (path.basename(filePath) === 'index.html') {
      try {
        const html = await fs.promises.readFile(filePath, 'utf-8');
        return new Response(html.replace(/%%NONCE%%/g, cspNonce), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      } catch {
        // Fall through to default handling if read fails
      }
    }

    return net.fetch(request as unknown as Request, { bypassCustomProtocolHandlers: true });
  });

  // Serve plugin modules over the custom same-origin `clubhouse-plugin:` scheme
  // (Part B). The path is resolved + validated symlink-safely against the
  // plugins root; relative imports inside a module resolve back through this
  // same handler (the version prefix in the path propagates to siblings, giving
  // cache-busting). CORS header lets the dev renderer (http origin) import it too.
  session.defaultSession.protocol.handle(PLUGIN_PROTOCOL_SCHEME, async (request) => {
    try {
      const realPath = await resolvePluginModulePath(
        request.url,
        getCommunityPluginsDir(),
        (p) => fs.promises.realpath(p),
      );
      const source = await fs.promises.readFile(realPath, 'utf-8');
      tel.count('clubhouse.plugin.protocol.requests', 1, [ATTR.pluginProtocolResult('ok')]);
      // CORS header is required: importing this scheme is always cross-origin
      // from the file://-or-http:// renderer. See pluginModuleResponseHeaders.
      return new Response(source, { headers: pluginModuleResponseHeaders() });
    } catch (err) {
      const denied = err instanceof Error && /^(Invalid plugin module URL|Access denied)/.test(err.message);
      tel.count('clubhouse.plugin.protocol.requests', 1, [ATTR.pluginProtocolResult(denied ? 'denied' : 'not_found')]);
      appLog('core:plugins', 'warn', 'clubhouse-plugin: request denied', {
        meta: { url: request.url, error: err instanceof Error ? err.message : String(err) },
      });
      return new Response('Not found', { status: 404 });
    }
  });

  // Enforce CSP via HTTP header on the main-frame HTML response (production only).
  // This replaces the <meta> CSP tag that was removed from index.html.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'mainFrame' && details.url.startsWith('file://')) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            buildProductionCsp(getCspNonce()),
          ],
        },
      });
    } else {
      callback({ responseHeaders: details.responseHeaders });
    }
  });

  createWindow();

  // Framebriar screenshot feedback: restores enrollment and resumes queued reports.
  startFeedback();

  // Start periodic update checks (respects user's autoUpdate setting).
  // Skipped for unpackaged builds (dev / E2E) so a mid-run "update ready"
  // banner can't overlay the UI and flake unrelated tests. Manual checks
  // still work via the "check for updates" action.
  if (shouldAutoCheckOnStartup()) {
    startUpdateChecks();
  }

  // Start periodic plugin update checks
  startPeriodicPluginUpdateChecks();

  // Delete data left behind by removed built-in features (Hub, Sessions,
  // Agent Queue, Assistant).
  projectStore.list()
    .then((projects) => cleanupRetiredPluginData({
      globalPluginDataDir: getGlobalPluginDataDir(),
      communityPluginsDir: getCommunityPluginsDir(),
      projects,
      retiredFeatureDirs: [
        path.join(app.getPath('home'), '.clubhouse', 'assistant'),
        path.join(app.getPath('home'), app.isPackaged ? '.clubhouse' : '.clubhouse-dev', 'agent-queues'),
      ],
    }))
    .catch((err) => {
      appLog('core:plugins', 'warn', `Retired plugin cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });

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

// Quit, the update restart and the app restart share one shutdown (#2053);
// this is what it stops first, before the agents.
setShutdownBegin(() => {
  stopUpdateChecks();
  stopPeriodicPluginUpdateChecks();

  // Flush any pending throttled IPC broadcasts before tearing down
  flushPendingBroadcasts();

  stopPtyStaleSweep();
  stopHeadlessStaleSweep();
  annexServer.stop();
  mcpBridgeServer.stop();
  stopAllWatches();
  // Bounded; queued feedback stays on disk for the next run.
  void shutdownFeedback();
});

app.on('before-quit', createBeforeQuitHandler({
  shutdown: (after) => runAppShutdown('quit', after),
  flushTelemetry: () => flushBeforeExit(),
  applyUpdateOnQuit,
  appQuit: () => app.quit(),
  onCleanupError: (operation, error) => {
    appLog('core:shutdown', 'error', `Failed to ${operation}: ${error instanceof Error ? error.message : String(error)}`);
  },
}));
