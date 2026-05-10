import type { PluginModule } from '../../shared/plugin-types';

/**
 * Dynamic import wrapper — in a separate module so tests can mock it.
 *
 * In dev mode the renderer is served from http://localhost (webpack dev server),
 * so Chromium's ES module loader blocks cross-origin import() of file:// URLs.
 * We work around this by reading the file via IPC and importing from a blob: URI,
 * which avoids the cross-origin restriction without requiring unsafe-eval or data:.
 *
 * The webpackIgnore comment prevents webpack from statically analyzing the import().
 */
export async function dynamicImportModule(url: string): Promise<PluginModule> {
  if (url.startsWith('file:') && window.location.protocol !== 'file:') {
    // Strip only the 'file://' scheme prefix, preserving the leading '/' for absolute paths.
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
