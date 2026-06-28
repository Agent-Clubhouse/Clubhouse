import type { PluginModule } from '../../shared/plugin-types';

/**
 * Dynamic import wrapper — in a separate module so tests can mock it.
 *
 * Two distinct paths, selected by the renderer's origin:
 *
 * 1. Dev mode (renderer served from http://localhost by the webpack dev
 *    server): Chromium's ES module loader blocks cross-origin import() of
 *    file:// URLs. We read the file via IPC and import from a unique blob:
 *    URL, which sidesteps the cross-origin restriction without unsafe-eval.
 *    (A blob: URL has no path component, so a multi-file plugin's relative
 *    imports cannot resolve — but the cross-origin block leaves dev no other
 *    option. Production uses the direct path below, which does resolve them.)
 *
 * 2. Production mode (renderer on file://): import the file:// URL directly so
 *    the module keeps a real filesystem path and its relative/bare imports
 *    (e.g. `import './util.js'`) resolve. The renderer is same-origin with the
 *    plugin files — CSP allows it via `script-src 'self'`, and the files are
 *    served by the main-process `protocol.handle('file', …)` handler. We strip
 *    the `?v=` cache-busting query first: Chromium's ESM loader does not
 *    support query params on file:// URLs and would otherwise fail with
 *    "Cannot find module …?v=…".
 *
 * Routing *all* imports through a blob URL (as #1499 did) broke multi-file
 * plugins in production, because blob: URLs have no path for relative imports
 * to resolve against. This wrapper restores the direct production import.
 *
 * The webpackIgnore comment prevents webpack from statically analyzing the import().
 */

/**
 * Indirection around the native dynamic import. Kept on an object so tests can
 * spy on it without depending on the runtime's module resolver, while the
 * webpackIgnore comment still suppresses webpack's static analysis.
 * @internal — only the export name is internal; the behavior is production code.
 */
export const _internals = {
  rawImport: (specifier: string): Promise<PluginModule> =>
    import(/* webpackIgnore: true */ specifier),
};

export async function dynamicImportModule(url: string): Promise<PluginModule> {
  if (url.startsWith('file:') && window.location.protocol !== 'file:') {
    // Dev mode: read the module source via IPC and import from a blob URL.
    // Strip the scheme prefix and any query params to get the filesystem path.
    const filePath = decodeURIComponent(
      url.replace(/^file:\/\//, '').replace(/\?.*$/, ''),
    );
    const contents = await window.clubhouse.plugin.loadModuleSource(filePath);
    const blob = new Blob([contents], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await _internals.rawImport(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  // Production (file:// origin) and any non-file URL: import directly so the
  // module's relative/bare imports resolve against its real path. Strip the
  // ?v= cache-busting query from file:// URLs — Chromium's ESM loader rejects
  // query params on file:// URLs.
  const importUrl = url.startsWith('file:') ? url.replace(/\?.*$/, '') : url;
  return _internals.rawImport(importUrl);
}
