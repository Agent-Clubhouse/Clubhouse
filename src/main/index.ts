import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, ipcMain, powerMonitor, session, net, protocol } from 'electron';
import { cleanupTranscriptStaging } from './services/agent-runtime/chat-transcript';
import { scheduleChatMediaPrune } from './services/agent-runtime/chat-media-retention';
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
import { isFailedCopilotWrite } from './chat/copilot/failed-writes';
import { startPeriodicChecks as startUpdateChecks, stopPeriodicChecks as stopUpdateChecks, applyUpdateOnQuit, shouldAutoCheckOnStartup } from './services/auto-update-service';
import { startPeriodicPluginUpdateChecks, stopPeriodicPluginUpdateChecks } from './services/plugin-update-service';
import * as annexServer from './services/annex-server';
import { bridgeServer as mcpBridgeServer } from './services/clubhouse-mcp';
import { unpublishCliEndpoint } from './services/cli-endpoint';
import { flushAllPending as flushPendingBroadcasts } from './util/ipc-broadcast';
import { preWarmShellEnvironment } from './util/shell';
import { initializeRipgrep } from './services/search-service';
import { loadPendingResume } from './services/restart-session-service';
import { applyWindowSecurityGuards } from './window-security-guards';
import { installClientCertificatePolicy } from './client-certificate-policy';
import { generateCspNonce, getCspNonce, buildProductionCsp } from './csp-nonce';
import { createBeforeQuitHandler } from './shutdown-guard';
import { runAppShutdown, setShutdownBegin } from './services/app-shutdown';
import { initProtocolHandler } from './services/protocol-service';
import { resolvePluginModulePath, pluginModuleResponseHeaders } from './plugin-protocol';
import { PLUGIN_PROTOCOL_SCHEME } from '../shared/plugin-protocol-url';
import { getCommunityPluginsDir } from './services/plugin-discovery';
import { getGlobalPluginDataDir } from './services/plugin-storage';
import { cleanupRetiredPluginData } from './services/retired-plugin-cleanup';
import { noteRetiredPlugins } from './services/retired-plugin-data';
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
import { installHelperUsageTelemetry } from './telemetry/helper-usage';
import { installActionsTelemetry } from './telemetry/actions-telemetry';
import { getBaseDirPath } from './services/base-dir';
import { installIpcTelemetry } from './telemetry/ipc-telemetry';
import { installOsSessionEndFlush } from './os-session-end';
import { getAgentOrchestrator } from './services/agent-registry';
import { NEW_CHROME_ARG } from '../shared/chrome-flag';
import { windowsPtyLaunchArgs } from './util/windows-pty';
import { newChromeEnabled, titleBarOptions } from './window-chrome';
import { isPreviewEligible } from './services/preview-eligible';
import { isChatEnabled } from './services/chat-runtime-settings';
import { shutdownFeedback, startFeedback } from './services/framebriar';
import { installHelperDeliverySeam } from './services/clubhouse-mcp/tools/helper-delivery-seam';
import { codeOf } from './services/managed-agents/log-code';

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

// Opt-in telemetry export, off by default. Reads its settings after
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
// OS shutdown, restart and logoff skip before-quit on Windows: flush synchronously then.
installOsSessionEndFlush();
installAgentTelemetry(getAgentOrchestrator);
installChatTelemetry();
installHelperUsageTelemetry({ ledgerFile: path.join(getBaseDirPath(), 'helper-decisions.json') });
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

// Catch-all handlers for truly unexpected errors. Lines logged before the
// recorder is ready are held and written once it is (#2301).
process.on('uncaughtException', (err) => {
  appLog('core:process', 'fatal', 'Uncaught exception', {
    meta: { error: err.message, stack: err.stack },
  });
  reportMainProcessError(err, 'uncaught');
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  // A failed Copilot message write, usually to a CLI that is going away, that
  // its caller already got as an error. vscode-jsonrpc 8.2.1 left a second
  // copy of every failed request write; 10.0.0 doesn't, but a notification
  // write still rethrows, so the guard stays (#2706, failed-writes.ts).
  if (isFailedCopilotWrite(reason)) {
    appLog('core:process', 'warn', 'A Copilot message write failed, and its request already failed with it', { meta: { error: msg, stack } });
    return;
  }
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

installClientCertificatePolicy(app);

app.on('ready', () => {
  void cleanupTranscriptStaging();
  // Chat media is capped across agents (#2828); check once a few minutes after startup.
  scheduleChatMediaPrune(5 * 60_000);
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
  // E2E only: a no-op unless unpackaged and asked for (#2490).
  installHelperDeliverySeam();
  // In the background, never blocking startup: the settings migration (D61), and the built-in
  // agent parts (#2902) install or update, then sleeping legacy-configured agents switch to managed once (D59).
  void import('./services/managed-agents/auto-migrate').then(({ startManagedAtAppStart }) => startManagedAtAppStart(
    () => import('./services/managed-agents').then(({ ensureBuiltinsOnce }) => ensureBuiltinsOnce()),
  )).catch((err) => {
    appLog('core:managed', 'warn', 'The managed agents startup work stopped', { meta: { code: codeOf(err) } });
  });
  // The app event bus (#2950): fed from here on, then "Clubhouse started" once subscribers listen.
  void import('./services/app-event-sources').then(async ({ startAppEventSources, publishAppStarted }) => {
    await startAppEventSources();
    // Actions (#2918) subscribe before "Clubhouse started" goes out.
    try {
      const { startActions, observeActions } = await import('./services/actions');
      // Telemetry listens first, so the "Clubhouse started" triggers are counted. It never changes a run.
      installActionsTelemetry(observeActions);
      await startActions();
    } catch (err) {
      appLog('core:actions', 'error', 'Actions did not start', { meta: { code: codeOf(err) } });
    }
    // The Dispatcher's hidden upkeep and check-ins (#3040) are Actions, so they start after them.
    try {
      const { startDispatcherBackground } = await import('./services/dispatcher/dispatcher-background');
      startDispatcherBackground();
    } catch (err) {
      appLog('core:dispatcher', 'warn', 'The Dispatcher background work did not start', { meta: { code: codeOf(err) } });
    }
    publishAppStarted();
  }).catch((err) => {
    appLog('core:app-events', 'warn', 'The app event bus did not start', { meta: { code: codeOf(err) } });
  });
  // Commits, branch switches and remote-tracking updates for the bus (#2955).
  void import('./services/git-watcher').then(({ startGitWatcher }) => startGitWatcher()).catch((err) => {
    appLog('core:app-events', 'warn', 'The git watcher did not start', { meta: { code: codeOf(err) } });
  });
  // Provider profiles were removed (#2749): one log line, once, for anyone who had saved some.
  void import('./services/provider-profiles-removed').then(({ noteRemovedProviderProfiles }) => noteRemovedProviderProfiles()).catch((err) => {
    appLog('core:agent', 'warn', 'Could not check for removed provider profiles', { meta: { code: codeOf(err) } });
  });
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
    // The network may have changed while asleep: advertise again on it (#1921).
    try { annexServer.republishAdvertisement(); } catch { /* telemetry-exempt: Annex may not be running */ }
  });

  appLog('core:startup', 'info', `Clubhouse v${app.getVersion()} starting`, {
    meta: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      packaged: app.isPackaged,
      // What's in force for this launch, not what's saved. scripts/ci/stable-candidate.mjs reads these.
      previewEligible: isPreviewEligible(),
      newChrome: newChromeEnabled(),
      chatEnabled: isChatEnabled(),
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

  // Delete plugin data left behind by removed built-in plugins (Hub, Sessions,
  // Agent Queue).
  projectStore.list()
    .then((projects) => cleanupRetiredPluginData({
      globalPluginDataDir: getGlobalPluginDataDir(),
      communityPluginsDir: getCommunityPluginsDir(),
      projects,
    }))
    .catch((err) => {
      appLog('core:plugins', 'warn', `Retired plugin cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });

  // Retired Workshop plugins (Lounge, KanBoss, Bug Report; #2756) keep their
  // data: log once where it is, never delete it.
  projectStore.list()
    .then((projects) => noteRetiredPlugins({
      globalPluginDataDir: getGlobalPluginDataDir(),
      communityPluginsDir: getCommunityPluginsDir(),
      projects,
      markerFile: path.join(getGlobalPluginDataDir(), '_system', 'retired-plugins-noted.json'),
    }))
    .catch((err) => {
      appLog('core:plugins', 'warn', `Retired plugin check failed: ${err instanceof Error ? err.message : String(err)}`);
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
  unpublishCliEndpoint();
  stopAllWatches();
  void import('./services/git-watcher').then(({ stopGitWatcher }) => stopGitWatcher()).catch((): void => undefined);
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
