/**
 * Shared URL format for the custom `clubhouse-plugin:` module protocol (Part B).
 *
 * This is the single source of truth for the URL shape so the renderer (which
 * BUILDS the URL in plugin-loader) and the main process (which PARSES it in the
 * protocol handler) can never drift. Pure — no Electron, no fs — so it unit-tests
 * trivially and can be imported from either layer.
 *
 * Shape: `clubhouse-plugin://plugin/v<version>/<absolute-file-path>`
 *
 * The cache-busting version lives in the PATH (not a query) on purpose: a custom
 * standard scheme resolves relative imports via normal URL resolution, so an
 * entry at `…/v<ts>/<dir>/main.js` resolves `import './util.js'` to
 * `…/v<ts>/<dir>/util.js` — the version prefix propagates to every sibling, so a
 * hot-reload (new <ts>) busts the whole module subtree. A query param would NOT
 * propagate to sibling URLs, leaving them ESM-cached. This also sidesteps the
 * `?v=`-on-`file://` failure (#1499 Bug 2) entirely.
 */

export const PLUGIN_PROTOCOL_SCHEME = 'clubhouse-plugin';

/** Fixed authority. The real plugin path lives in the URL path, not the host. */
export const PLUGIN_PROTOCOL_HOST = 'plugin';

/**
 * Build a `clubhouse-plugin://` URL for an absolute plugin module path.
 * `version` is typically `Date.now()` captured at (re)load time for cache-busting.
 */
export function buildPluginModuleUrl(absFilePath: string, version: number | string): string {
  // Normalize Windows backslashes to forward slashes for URL pathing.
  const normalized = absFilePath.replace(/\\/g, '/');
  // Guarantee a single leading slash (macOS/Linux already have it; Windows
  // "C:/…" does not), then percent-encode each segment but keep '/' separators.
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  // Percent-encode each segment, but keep ':' literal so a Windows drive letter
  // ("C:") stays readable — ':' is valid in a non-leading URL path segment.
  const encodedPath = withSlash
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/');
  return `${PLUGIN_PROTOCOL_SCHEME}://${PLUGIN_PROTOCOL_HOST}/v${version}${encodedPath}`;
}

/**
 * Parse a `clubhouse-plugin://` URL back into its version + absolute file path.
 * Returns null for anything that isn't a well-formed URL for this scheme/host.
 * PURE — does no filesystem access or security validation; the caller (main
 * process) must `realpath` + validate the path is within the plugins root.
 */
export function parsePluginModuleUrl(url: string): { version: string; filePath: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PLUGIN_PROTOCOL_SCHEME}:`) return null;
  if (parsed.hostname !== PLUGIN_PROTOCOL_HOST) return null;

  // pathname is `/v<version>/<abs path…>` (percent-encoded). Decode, then split
  // the version prefix from the absolute path.
  const decoded = decodeURIComponent(parsed.pathname);
  const match = decoded.match(/^\/v([^/]+)(\/.+)$/);
  if (!match) return null;

  const version = match[1];
  let filePath = match[2]; // begins with '/'

  // Windows: "/C:/Users/…" → "C:/Users/…"
  if (/^\/[A-Za-z]:\//.test(filePath)) {
    filePath = filePath.slice(1);
  }

  return { version, filePath };
}
