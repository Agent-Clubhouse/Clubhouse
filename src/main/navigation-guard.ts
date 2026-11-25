/**
 * Navigation rules for app windows (the main window and popouts).
 *
 * An app window may only show the app's own page, the entry it was loaded
 * from (`MAIN_WINDOW_WEBPACK_ENTRY`). Anything else, including other local
 * files and other localhost ports, would run under the privileged preload.
 *
 * - file:// entry (packaged builds): only that exact document, ignoring query
 *   and hash.
 * - http(s) entry (the dev server): only that exact origin.
 * - Any other scheme: only that exact document.
 */

/**
 * A URL reduced to the document it names, or '' if it doesn't parse.
 *
 * Query and hash are dropped. The pathname is decoded, because Node (which
 * parses the entry URL) and Chromium (which reports frame and navigation
 * URLs) don't percent-encode the same characters ({ } ^ | among them). The
 * host and a Windows drive letter (/C: vs /c:) compare case-insensitively.
 */
export function documentUrl(url: string): string {
  try {
    const u = new URL(url);
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Malformed escapes: compare as spelled.
    }
    pathname = pathname.replace(/^\/([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}:`);
    return `${u.protocol}//${u.host.toLowerCase()}${pathname}`;
  } catch {
    return '';
  }
}

/** True when `url` is the app's own page for an app window loaded from `entryUrl`. */
export function isAllowedNavigation(url: string, entryUrl: string): boolean {
  let target: URL;
  let entry: URL;
  try {
    target = new URL(url);
    entry = new URL(entryUrl);
  } catch {
    return false;
  }
  if (entry.protocol === 'http:' || entry.protocol === 'https:') {
    return target.origin === entry.origin;
  }
  const doc = documentUrl(url);
  return doc !== '' && doc === documentUrl(entryUrl);
}

/** Protocols allowed for shell.openExternal. Blocks file:, data:, javascript: and the rest. */
export const OPEN_EXTERNAL_ALLOWED_PROTOCOLS = ['https:', 'http:', 'mailto:'];

export function isOpenExternalAllowed(url: string): boolean {
  try {
    return OPEN_EXTERNAL_ALLOWED_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
