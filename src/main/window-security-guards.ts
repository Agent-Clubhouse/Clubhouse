/**
 * Shared security guards for BrowserWindows.
 *
 * Applies will-navigate, setWindowOpenHandler, and will-attach-webview
 * guards to prevent navigation to external URLs, creation of unguarded
 * webviews, and opening of arbitrary windows.
 */

import { BrowserWindow, shell } from 'electron';
import { securitySettings } from './ipc/settings-handlers';
import { isAllowedNavigation, isOpenExternalAllowed } from './navigation-guard';
import { appLog } from './services/log-service';

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return 'invalid';
  }
}

/**
 * Hand an http, https or mailto link to the system browser or mail app, as
 * the app's openExternal IPC does. Anything else is dropped.
 */
function openExternally(url: string): void {
  if (!isOpenExternalAllowed(url)) return;
  void shell.openExternal(url).catch(() => {
    appLog('core:security', 'warn', 'Could not open a link externally', { meta: { protocol: protocolOf(url) } });
  });
}

/**
 * @param entryUrl the app page this window loads (`MAIN_WINDOW_WEBPACK_ENTRY`).
 *   The window may never navigate anywhere else (#3881).
 */
export function applyWindowSecurityGuards(win: BrowserWindow, entryUrl: string): void {
  // The window only ever shows the app's own page. A link to the web opens in
  // the system browser; everything else (another file, a dropped file, another
  // localhost port, data:, javascript:) is blocked.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, entryUrl)) return;
    event.preventDefault();
    appLog('core:security', 'warn', 'Blocked app window navigation', { meta: { protocol: protocolOf(url) } });
    openExternally(url);
  });

  win.webContents.on('will-redirect', (event, url) => {
    if (isAllowedNavigation(url, entryUrl)) return;
    event.preventDefault();
    appLog('core:security', 'warn', 'Blocked app window redirect', { meta: { protocol: protocolOf(url) } });
  });

  // Renderer-created children inherit the privileged preload, even for local
  // files and localhost. App popouts are created explicitly in the main process;
  // no renderer URL is allowed to mint another privileged app window (#2081).
  // A web link (target=_blank, window.open) opens in the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    appLog('core:security', 'warn', 'Blocked renderer window.open', { meta: { protocol: protocolOf(url) } });
    openExternally(url);
    return { action: 'deny' };
  });

  // Restrict webview creation to safe URL schemes
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    (webPreferences as Record<string, unknown>).nodeIntegrationInSubFrames = false;

    const src = params.src || '';
    if (!src || src.startsWith('about:blank')) return;

    const isHttp = src.startsWith('http://') || src.startsWith('https://');
    const isFile = src.startsWith('file://');

    if (isHttp) return;

    if (isFile) {
      const settings = securitySettings.getSettings();
      if (settings.allowLocalFileWebviews) return;

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
}
