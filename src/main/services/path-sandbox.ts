import * as path from 'path';
import * as fsp from 'fs/promises';
import { app } from 'electron';
import * as projectStore from './project-store';
import { appLog } from './log-service';
import { tel } from '../telemetry/facade';

/**
 * Returns the list of allowed root directories for IPC file operations.
 * Includes all registered project paths and the app data directory.
 */
export async function getAllowedRoots(): Promise<string[]> {
  const roots: string[] = [];

  for (const project of await projectStore.list()) {
    roots.push(path.resolve(project.path));
  }

  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  roots.push(path.resolve(app.getPath('home'), dirName));

  return roots;
}

/**
 * Check whether a resolved path falls under any of the given allowed roots.
 * Exported for direct testing.
 */
export function isPathAllowed(targetPath: string, allowedRoots: string[]): boolean {
  const resolved = path.resolve(targetPath);
  for (const rawRoot of allowedRoots) {
    const root = path.resolve(rawRoot);
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return true;
    }
  }
  return false;
}

/**
 * Where a path really leads, as a write to it would land (#3177): symlinks
 * followed, a dangling one too (writing creates its target), and for a file
 * that doesn't exist yet, through its nearest existing folder, so a new file
 * under a symlinked folder is placed where the folder really is.
 */
export async function resolveRealPath(p: string, depth = 0): Promise<string> {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await fsp.realpath(current), ...[...rest].reverse());
    } catch {
      // telemetry-exempt: a path that doesn't resolve (yet) is expected; it is followed by hand below
      try {
        const st = await fsp.lstat(current);
        if (st.isSymbolicLink() && depth < 40) {
          const link = await fsp.readlink(current);
          return resolveRealPath(path.join(path.resolve(path.dirname(current), link), ...[...rest].reverse()), depth + 1);
        }
      } catch {
        // telemetry-exempt: nothing here yet, so go up a folder
      }
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Assert that a filesystem path is within a registered project directory
 * or the app data directory. Throws if the path is outside allowed boundaries.
 * The path is judged where it really leads (resolveRealPath), against the
 * roots as registered and where they really are.
 */
export async function assertAllowedPath(targetPath: string): Promise<void> {
  const given = await getAllowedRoots();
  const roots = [...given, ...await Promise.all(given.map((r) => resolveRealPath(r)))];
  const realTarget = await resolveRealPath(targetPath);
  if (!isPathAllowed(realTarget, roots)) {
    tel.count('clubhouse.file.path_denied');
    const resolved = path.resolve(targetPath);
    appLog('core:file', 'error', 'Path access denied: outside allowed directories', {
      meta: { targetPath, resolved },
    });
    throw new Error(`Access denied: path "${resolved}" is outside allowed project directories`);
  }
}
