import type { PluginModule } from '../../shared/plugin-types';

/**
 * Dynamic import wrapper — in a separate module so tests can mock it.
 *
 * In dev mode the renderer is served from http://localhost (webpack dev server),
 * so Chromium's ES module loader blocks cross-origin import() of file:// URLs.
 * We work around this by reading the file via IPC and importing from a data: URI.
 */
export async function dynamicImportModule(url: string): Promise<PluginModule> {
  // Use indirect eval to prevent webpack from analyzing the expression
  const importFn = new Function('path', 'return import(path)') as (path: string) => Promise<PluginModule>;

  // In dev mode (http origin), file:// imports are cross-origin and blocked.
  // Read file contents via IPC and import from a data: URI instead.
  if (url.startsWith('file:') && window.location.protocol !== 'file:') {
    const filePath = decodeURIComponent(
      url.replace(/^file:\/\/\/?/, '').replace(/\?.*$/, ''),
    );
    const contents = await window.clubhouse.plugin.loadModuleSource(filePath);
    const encoded = btoa(unescape(encodeURIComponent(contents)));
    const dataUrl = `data:text/javascript;base64,${encoded}`;
    return importFn(dataUrl);
  }

  return importFn(url);
}
