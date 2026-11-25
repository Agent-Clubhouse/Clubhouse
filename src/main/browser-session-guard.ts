/**
 * The Browser session's own file:// gate (#3869).
 *
 * Every file: request in the Browser's webview session (`persist:plugin-browser`)
 * comes through here, whatever started it: the first src, a src change after
 * attach, webview.loadURL, back/forward, a redirect or a subframe. When the
 * Browser's "Allow file:// URLs" setting is off in every scope, the request gets
 * a 403 and nothing from disk. Otherwise it passes through to Chromium's own file
 * handling unchanged.
 *
 * This replaces stopping file:// loads from did-start-navigation: cancelling a
 * navigation from inside its own start event crashed the main process (SIGTRAP)
 * in the E2E run. A protocol handler never touches navigation state.
 *
 * Only the Browser session is affected. The app's own file handler (CSP nonce
 * injection) is on the default session, in index.ts.
 */

import { net, session } from 'electron';
import { BROWSER_WEBVIEW_PARTITION } from '../shared/browser-partition';
import { BROWSER_FILE_SETTING_LOCATION, isBrowserFileAccessAllowed } from './browser-file-access';
import { appLog } from './services/log-service';

export interface BrowserFileGateDeps {
  allowed: () => boolean;
  passThrough: (request: Request) => Promise<Response>;
}

const defaultDeps: BrowserFileGateDeps = {
  allowed: () => isBrowserFileAccessAllowed(),
  passThrough: (request) => net.fetch(request, { bypassCustomProtocolHandlers: true }),
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Answer one file: request from the Browser session. */
export async function handleBrowserFileRequest(request: Request, deps: BrowserFileGateDeps = defaultDeps): Promise<Response> {
  if (deps.allowed()) {
    // bypassCustomProtocolHandlers sends this to Chromium's own file loader,
    // not back into this handler. A missing file or anything else it can't
    // read becomes a plain 404, never a throw out of the handler.
    try {
      return await deps.passThrough(request);
    } catch {
      return new Response('This local file could not be read.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  }
  // Protocol and host only: the path can hold a local file path.
  appLog('core:security', 'info', `Blocked file:// in a webview. Turn on ${BROWSER_FILE_SETTING_LOCATION} to load local files.`, {
    meta: { stage: 'browser-session-file', protocol: 'file:', host: hostOf(request.url) },
  });
  return new Response('Local files are off in the Browser.', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

let installed = false;

/**
 * Install the gate on the Browser session, once per process. index.ts calls
 * it on app ready, before the first window (and so any Browser webview)
 * exists. Later calls do nothing: protocol.handle throws if a scheme is
 * handled twice.
 */
export function installBrowserSessionGuard(): void {
  if (installed) return;
  session.fromPartition(BROWSER_WEBVIEW_PARTITION).protocol.handle('file', (request) => handleBrowserFileRequest(request));
  installed = true;
}

/** For tests only. */
export function _resetBrowserSessionGuardForTesting(): void {
  installed = false;
}
