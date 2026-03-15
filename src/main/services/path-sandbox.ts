import * as path from 'path';
import { app } from 'electron';
import * as projectStore from './project-store';
import { appLog } from './log-service';

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
 * Assert that a filesystem path is within a registered project directory
 * or the app data directory. Throws if the path is outside allowed boundaries.
 */
export async function assertAllowedPath(targetPath: string): Promise<void> {
  const roots = await getAllowedRoots();
  if (!isPathAllowed(targetPath, roots)) {
    const resolved = path.resolve(targetPath);
    appLog('core:file', 'error', 'Path access denied: outside allowed directories', {
      meta: { targetPath, resolved },
    });
    throw new Error(`Access denied: path "${resolved}" is outside allowed project directories`);
  }
}
