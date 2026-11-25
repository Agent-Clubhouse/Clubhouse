/**
 * Shared security guards for BrowserWindows.
 *
 * Applies will-navigate, setWindowOpenHandler, and will-attach-webview
 * guards to prevent navigation to external URLs, creation of unguarded
 * webviews, and opening of arbitrary windows. Attached webview guests get
 * their own navigation, redirect and popup guards (#3869).
 */

import { BrowserWindow } from 'electron';
import type { WebContents, WebPreferences } from 'electron';
import { BROWSER_FILE_SETTING_LOCATION, isBrowserFileAccessAllowed } from './browser-file-access';
import { isAllowedNavigation } from './navigation-guard';
import { appLog } from './services/log-service';

export type WebviewUrlVerdict = 'allow' | 'file-off' | 'scheme';

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Whether a webview may load `url`. Top-level loads allow http, https,
 * about:blank, and file when the Browser's "Allow file:// URLs" setting is on.
 * Subframes also allow about:, data: and blob:, which ordinary pages use for
 * embedded frames; Chromium already keeps those from reaching the top level.
 */
export function webviewUrlVerdict(url: string, opts: { subframe?: boolean } = {}): WebviewUrlVerdict {
  const parsed = parse(url);
  const protocol = parsed?.protocol ?? null;
  if (protocol === 'http:' || protocol === 'https:') return 'allow';
  if (protocol === 'about:') return opts.subframe || parsed?.pathname === 'blank' ? 'allow' : 'scheme';
  if (opts.subframe && (protocol === 'data:' || protocol === 'blob:')) return 'allow';
  if (protocol === 'file:') return isBrowserFileAccessAllowed() ? 'allow' : 'file-off';
  return 'scheme';
}

function logBlocked(verdict: Exclude<WebviewUrlVerdict, 'allow'>, stage: string, url: string): void {
  const meta = { stage, src: url.slice(0, 200) };
  if (verdict === 'file-off') {
    appLog('core:security', 'info', `Blocked file:// in a webview. Turn on ${BROWSER_FILE_SETTING_LOCATION} to load local files.`, { meta });
  } else {
    appLog('core:security', 'warn', 'Blocked webview URL with a disallowed scheme', { meta });
  }
}

/**
 * Force safe webPreferences on a webview, whatever the <webview> tag asked for.
 * The app doesn't use a webview preload, so any preload is removed.
 */
export function hardenWebviewPreferences(webPreferences: WebPreferences): void {
  const prefs = webPreferences as WebPreferences & Record<string, unknown>;
  delete prefs.preload;
  delete prefs.preloadURL;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.nodeIntegrationInWorker = false;
  prefs.contextIsolation = true;
  prefs.sandbox = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
}

type NavigationEvent = { preventDefault(): void; url?: string; isMainFrame?: boolean };

/** Guard a webview guest's navigations, redirects and popups. */
export function applyWebviewGuestGuards(guest: WebContents): void {
  const guard = (stage: string) => (event: NavigationEvent, legacyUrl?: unknown, _isInPlace?: unknown, legacyIsMainFrame?: unknown) => {
    const url = typeof event.url === 'string' ? event.url : typeof legacyUrl === 'string' ? legacyUrl : '';
    const isMainFrame = typeof event.isMainFrame === 'boolean'
      ? event.isMainFrame
      : typeof legacyIsMainFrame === 'boolean' ? legacyIsMainFrame : true;
    // will-navigate already covers the main frame; will-frame-navigate adds subframes.
    if (stage === 'will-frame-navigate' && isMainFrame) return;
    const verdict = webviewUrlVerdict(url, { subframe: !isMainFrame });
    if (verdict === 'allow') return;
    event.preventDefault();
    logBlocked(verdict, stage, url);
  };

  guest.on('will-navigate', guard('will-navigate') as never);
  guest.on('will-frame-navigate', guard('will-frame-navigate') as never);
  guest.on('will-redirect', guard('will-redirect') as never);

  // <webview> tags don't set allowpopups, so pages never got new windows.
  // Enforce that here instead of trusting the tag.
  guest.setWindowOpenHandler(({ url }) => {
    appLog('core:security', 'warn', 'Blocked webview popup', { meta: { src: (url || '').slice(0, 200) } });
    return { action: 'deny' };
  });
}

export function applyWindowSecurityGuards(win: BrowserWindow): void {
  // Block navigation to external URLs
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      appLog('core:security', 'warn', `Blocked navigation to external URL: ${url}`);
    }
  });

  // Renderer-created children inherit the privileged preload, even for local
  // files and localhost. App popouts are created explicitly in the main process;
  // no renderer URL is allowed to mint another privileged app window (#2081).
  win.webContents.setWindowOpenHandler(({ url }) => {
    appLog('core:security', 'warn', `Blocked renderer window.open: ${url}`);
    return { action: 'deny' };
  });

  // Force safe preferences and restrict the first URL of every webview
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    hardenWebviewPreferences(webPreferences);

    const src = params.src || '';
    if (!src) return;
    const verdict = webviewUrlVerdict(src);
    if (verdict === 'allow') return;
    logBlocked(verdict, 'will-attach-webview', src);
    event.preventDefault();
  });

  // Guard everything the guest does after it attaches
  win.webContents.on('did-attach-webview', (_event, guest) => {
    applyWebviewGuestGuards(guest);
  });
}
