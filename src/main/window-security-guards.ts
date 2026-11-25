/**
 * Shared security guards for BrowserWindows.
 *
 * Applies will-navigate, setWindowOpenHandler, and will-attach-webview
 * guards to prevent navigation to external URLs, creation of unguarded
 * webviews, and opening of arbitrary windows. Attached webview guests get
 * their own navigation, redirect and popup guards (#3869).
 */

import { BrowserWindow, shell } from 'electron';
import type { WebContents, WebPreferences } from 'electron';
import { BROWSER_WEBVIEW_PARTITION } from '../shared/browser-partition';
import { BROWSER_FILE_SETTING_LOCATION, isBrowserFileAccessAllowed } from './browser-file-access';
import { isAllowedNavigation, isOpenExternalAllowed } from './navigation-guard';
import { appLog } from './services/log-service';

export type WebviewUrlVerdict = 'allow' | 'file-off' | 'scheme' | 'file-redirect';

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Whether a webview may load `url`. Top-level loads allow http, https, blob:,
 * about:blank, and file when the Browser's "Allow file:// URLs" setting is on.
 * Subframes also allow about: and data:, which ordinary pages use for
 * embedded frames.
 */
export function webviewUrlVerdict(url: string, opts: { subframe?: boolean } = {}): WebviewUrlVerdict {
  const parsed = parse(url);
  const protocol = parsed?.protocol ?? null;
  if (protocol === 'http:' || protocol === 'https:') return 'allow';
  if (protocol === 'about:') return opts.subframe || parsed?.pathname === 'blank' ? 'allow' : 'scheme';
  // blob: URLs belong to the page's own origin (e.g. a generated PDF opened in the same tab).
  if (protocol === 'blob:') return 'allow';
  if (opts.subframe && protocol === 'data:') return 'allow';
  if (protocol === 'file:') return isBrowserFileAccessAllowed() ? 'allow' : 'file-off';
  return 'scheme';
}

function logBlocked(verdict: Exclude<WebviewUrlVerdict, 'allow'>, stage: string, url: string): void {
  // Protocol and host only: paths and queries can hold local file paths or tokens.
  const meta = { stage, protocol: parse(url)?.protocol ?? 'invalid', host: parse(url)?.host ?? '' };
  if (verdict === 'file-off') {
    appLog('core:security', 'info', `Blocked file:// in a webview. Turn on ${BROWSER_FILE_SETTING_LOCATION} to load local files.`, { meta });
  } else if (verdict === 'file-redirect') {
    appLog('core:security', 'warn', 'Blocked a redirect into file:// in a webview', { meta });
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
  // A guest page must not create its own <webview>: nested guests attach to
  // the guest's webContents, where none of these guards run.
  prefs.webviewTag = false;
}

// The Browser's session. Other sessions are refused: the default session has
// the app's own file and plugin protocol handlers and cookies.
export { BROWSER_WEBVIEW_PARTITION };

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
    // A redirect never lands on a local file, whatever the setting: a web page
    // must not be able to send the Browser to disk. Not left to Chromium's own
    // ERR_UNSAFE_REDIRECT.
    if (stage === 'will-redirect' && parse(url)?.protocol === 'file:') {
      event.preventDefault();
      logBlocked('file-redirect', stage, url);
      return;
    }
    const verdict = webviewUrlVerdict(url, { subframe: !isMainFrame });
    if (verdict === 'allow') return;
    event.preventDefault();
    logBlocked(verdict, stage, url);
  };

  guest.on('will-navigate', guard('will-navigate') as never);
  guest.on('will-frame-navigate', guard('will-frame-navigate') as never);
  guest.on('will-redirect', guard('will-redirect') as never);

  // Programmatic loads skip the will-* events. The renderer's <webview>.loadURL()
  // and src changes reach main as calls to this guest's loadURL (Electron's
  // guest-view manager calls guest[method]), and so do main's own calls (the
  // agent navigate tool). Refuse disallowed schemes before any navigation
  // starts. file: goes on to the Browser session's file gate, which applies the
  // setting to every file: request.
  const loadURL = guest.loadURL.bind(guest);
  guest.loadURL = ((url: string, options?: Electron.LoadURLOptions) => {
    if (webviewUrlVerdict(url) === 'scheme') {
      logBlocked('scheme', 'loadURL', url);
      return Promise.reject(new Error('This kind of address is blocked in the Browser.'));
    }
    return loadURL(url, options);
  }) as typeof guest.loadURL;

  // Backstop for loads that skip the will-* events: the renderer changing a
  // <webview> src after attach and webContents.loadURL both navigate
  // programmatically. file: is handled by the Browser session's own protocol
  // gate (browser-session-guard.ts), which covers every route. For the other
  // disallowed schemes, stop the load, but only after the event returns:
  // cancelling a navigation from inside did-start-navigation crashed the main
  // process (SIGTRAP) in E2E.
  guest.on('did-start-navigation', ((event: NavigationEvent & { isSameDocument?: boolean }, legacyUrl?: unknown, legacyIsInPlace?: unknown, legacyIsMainFrame?: unknown) => {
    const url = typeof event.url === 'string' ? event.url : typeof legacyUrl === 'string' ? legacyUrl : '';
    const isMainFrame = typeof event.isMainFrame === 'boolean'
      ? event.isMainFrame
      : typeof legacyIsMainFrame === 'boolean' ? legacyIsMainFrame : true;
    const isSameDocument = typeof event.isSameDocument === 'boolean'
      ? event.isSameDocument
      : legacyIsInPlace === true;
    // Subframes are skipped: nothing in the app loads a guest subframe
    // programmatically (the agent tools only navigate the main frame), and
    // page-initiated subframe loads are checked by will-frame-navigate.
    if (!isMainFrame || isSameDocument) return;
    const verdict = webviewUrlVerdict(url);
    if (verdict !== 'scheme') return;
    logBlocked(verdict, 'did-start-navigation', url);
    setImmediate(() => {
      if (!guest.isDestroyed()) guest.stop();
    });
  }) as never);

  // <webview> tags don't set allowpopups, so pages never got new windows.
  // Enforce that here instead of trusting the tag.
  guest.setWindowOpenHandler(({ url }) => {
    appLog('core:security', 'warn', 'Blocked webview popup', { meta: { protocol: parse(url)?.protocol ?? 'invalid', host: parse(url)?.host ?? '' } });
    return { action: 'deny' };
  });
}

function protocolOf(url: string): string {
  return parse(url)?.protocol ?? 'invalid';
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

  // App windows have no subframes today, so isMainFrame isn't checked: a
  // future iframe's redirects would be held to the same entry-only rule,
  // which fails closed (blocks) rather than open.
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

  // Force safe preferences and restrict the first URL of every webview
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    hardenWebviewPreferences(webPreferences);

    if (params.partition !== BROWSER_WEBVIEW_PARTITION) {
      appLog('core:security', 'warn', 'Blocked webview outside the Browser session', {
        meta: { partition: String(params.partition ?? '').slice(0, 80) },
      });
      event.preventDefault();
      return;
    }

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
