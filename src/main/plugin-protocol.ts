/**
 * Main-process resolution + security validation for the `clubhouse-plugin:`
 * module protocol (Part B). The URL format itself lives in the shared,
 * renderer-safe `plugin-protocol-url` module; this file adds the parts that are
 * main-only: filesystem resolution and the symlink-safe within-root check.
 *
 * Pure-ish: imports only `path` (no Electron, no direct `fs`). The `realpath`
 * function is injected so the traversal/symlink-escape logic is fully
 * unit-testable; the Electron wiring in `index.ts` passes `fs.promises.realpath`.
 */
import * as path from 'path';
import { parsePluginModuleUrl } from '../shared/plugin-protocol-url';

/**
 * True iff `target` is the root itself or strictly underneath it. Compares
 * against `root + sep` so `/a/plugins-evil` does NOT match root `/a/plugins`.
 */
export function isPathWithinRoot(target: string, root: string): boolean {
  const normRoot = path.resolve(root);
  const normTarget = path.resolve(target);
  return normTarget === normRoot || normTarget.startsWith(normRoot + path.sep);
}

/**
 * Resolve a `clubhouse-plugin://` request URL to a real, validated file path.
 *
 * Order matters (mirrors the existing PLUGIN.LOAD_MODULE_SOURCE handler):
 *   1. parse the URL → absolute candidate path
 *   2. `realpath` it — FOLLOWS symlinks (and throws if the file is missing)
 *   3. THEN check the realpath is within the plugins root
 * Doing realpath before the check is what prevents a symlink inside the plugins
 * dir from pointing outside it and escaping the sandbox.
 *
 * Throws on malformed URL, missing file, or out-of-root path. `realpathFn` is
 * injected for testability.
 */
export async function resolvePluginModulePath(
  url: string,
  pluginsRoot: string,
  realpathFn: (p: string) => Promise<string>,
): Promise<string> {
  const parsed = parsePluginModuleUrl(url);
  if (!parsed) {
    throw new Error(`Invalid plugin module URL: ${url}`);
  }
  const candidate = path.resolve(parsed.filePath);
  const realPath = await realpathFn(candidate);
  if (!isPathWithinRoot(realPath, pluginsRoot)) {
    throw new Error(`Access denied: "${parsed.filePath}" is outside the plugins root`);
  }
  return realPath;
}
