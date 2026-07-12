import type { PluginModule } from '../../shared/plugin-types';
import { PLUGIN_PROTOCOL_SCHEME, parsePluginModuleUrl } from '../../shared/plugin-protocol-url';
import { nativeDynamicImport } from './native-import';

/**
 * Dynamic import wrapper — in a separate module so tests can mock it.
 *
 * Community plugin modules are served over the custom same-origin
 * `clubhouse-plugin:` scheme (Part B). Because that scheme is a *standard*
 * scheme backed by a main-process handler, the module keeps a real path, so its
 * relative/bare imports resolve — in both dev and prod — and the version prefix
 * in the URL path provides cache-busting on reload.
 *
 * - **Production** (renderer on `file://`): import the `clubhouse-plugin:` URL
 *   directly. This is the durable path and the one the E2E covers.
 * - **Dev** (renderer on `http://localhost`): the import is cross-origin. The
 *   privileged scheme + CORS header are meant to allow it; if a given Electron
 *   build still blocks it, we fall back to reading the source via IPC and
 *   importing from a blob URL so dev keeps loading. (Blob URLs have no path, so
 *   multi-file relative imports are unsupported in that fallback — a long-
 *   standing dev limitation; production uses the protocol. This is the approved
 *   dev posture: never weaken CSP or ship a broken dev path to force one route.)
 *
 * The actual `import()` lives in native-import.js (plain JS). It MUST stay there:
 * under tsconfig's `module: "commonjs"`, ts-loader downlevels a TS `import()`
 * into `require()` and drops the `webpackIgnore` comment, which throws
 * `Cannot find module 'clubhouse-plugin://…'` and never reaches the protocol
 * handler. See native-import.js for the full rationale.
 */

/**
 * Indirection around the native dynamic import so tests can spy on it without
 * depending on the runtime's module resolver.
 * @internal — only the export name is internal; the behavior is production code.
 */
export const _internals = {
  rawImport: (specifier: string): Promise<PluginModule> => nativeDynamicImport(specifier),
};

async function importViaBlob(filePath: string): Promise<PluginModule> {
  const contents = await window.clubhouse.plugin.loadModuleSource(filePath);
  const blob = new Blob([contents], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    return await _internals.rawImport(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export async function dynamicImportModule(url: string): Promise<PluginModule> {
  const isPluginScheme = url.startsWith(`${PLUGIN_PROTOCOL_SCHEME}:`);

  // Dev (non-file origin): try the protocol, fall back to the blob path so dev
  // still loads if the cross-origin import is blocked.
  if (isPluginScheme && window.location.protocol !== 'file:') {
    try {
      return await _internals.rawImport(url);
    } catch {
      const parsed = parsePluginModuleUrl(url);
      return importViaBlob(parsed?.filePath ?? url);
    }
  }

  // Production (file: origin) and any other URL: import directly.
  return _internals.rawImport(url);
}
