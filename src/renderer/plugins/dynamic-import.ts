import type { PluginModule } from '../../shared/plugin-types';

/**
 * Dynamic import wrapper — in a separate module so tests can mock it.
 *
 * All file:// imports are routed through IPC + blob URL for two reasons:
 *
 * 1. Dev mode (renderer on http://localhost): Chromium blocks cross-origin
 *    import() of file:// URLs; blob: avoids this without unsafe-eval.
 *
 * 2. Production mode (renderer on file://): Chromium's ESM loader does not
 *    support query parameters in file:// URLs, so passing ?v=… cache-busting
 *    params directly to import() causes "Cannot find module" errors.  Routing
 *    through a unique blob URL both strips the query param and provides the
 *    same cache-busting guarantee in production.
 *
 * The webpackIgnore comment prevents webpack from statically analyzing the import().
 */
export async function dynamicImportModule(url: string): Promise<PluginModule> {
  if (url.startsWith('file:')) {
    // Strip scheme prefix and any query params to get the filesystem path.
    const filePath = decodeURIComponent(
      url.replace(/^file:\/\//, '').replace(/\?.*$/, ''),
    );
    const contents = await window.clubhouse.plugin.loadModuleSource(filePath);
    const blob = new Blob([contents], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await import(/* webpackIgnore: true */ blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  return import(/* webpackIgnore: true */ url);
}
