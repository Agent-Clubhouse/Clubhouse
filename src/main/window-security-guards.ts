/**
 * Shared security guards for BrowserWindows.
 *
 * Applies will-navigate, setWindowOpenHandler, and will-attach-webview
 * guards to prevent navigation to external URLs, creation of unguarded
 * webviews, and opening of arbitrary windows.
 */

import { BrowserWindow } from 'electron';
import { isAllowedNavigation } from './navigation-guard';
import { appLog } from './services/log-service';

export function applyWindowSecurityGuards(win: BrowserWindow): void {
  // Block navigation to external URLs
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      appLog('core:security', 'warn', `Blocked navigation to external URL: ${url}`);
    }
  });

  // Block window.open() and <a target="_blank"> from opening external URLs
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedNavigation(url)) {
      appLog('core:security', 'warn', `Blocked window.open to external URL: ${url}`);
      return { action: 'deny' };
    }
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
      const { securitySettings } = require('./ipc/settings-handlers');
      const settings = securitySettings.get();
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
