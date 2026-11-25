import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from './log-service';

/**
 * Plugin companion agents were removed in Clubhouse 1.0. Each one worked in a
 * git repo at `~/.clubhouse/plugin-workspaces/<pluginId>` (the path the removed
 * companion-workspace service used). This deletes that folder, and logs what it held.
 * No built-in or Workshop plugin ever used companions, so on almost every
 * machine there is nothing to remove. Deleting work an agent committed in a
 * companion workspace is intended: the maintainer cleared full data removal
 * (2026-11-25). A symlink there is kept and logged, a plain file left alone.
 */
export function companionWorkspacesDir(home: string): string {
  return path.join(home, '.clubhouse', 'plugin-workspaces');
}

/** Returns the removed folder, or null when there was none. Best-effort: failures are logged, never thrown. */
export async function removeCompanionState(home: string): Promise<string | null> {
  const dir = companionWorkspacesDir(home);
  let workspaces: string[];
  try {
    const stat = await fsp.lstat(dir);
    if (stat.isSymbolicLink()) {
      // Never follow it: the folder it points at isn't Clubhouse's to delete.
      appLog('core:plugins', 'info', 'Kept the plugin companion workspaces link; delete it if you don\'t need it', { meta: { dir } });
      return null;
    }
    if (!stat.isDirectory()) return null;
    workspaces = await fsp.readdir(dir);
  } catch { // telemetry-exempt: no folder is the usual answer
    return null;
  }
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    appLog('core:plugins', 'info', 'Removed plugin companion workspaces (companion agents were removed in Clubhouse 1.0)', {
      meta: { dir, workspaces },
    });
    return dir;
  } catch (err) { // telemetry-exempt: logged; retried next launch
    appLog('core:plugins', 'warn', 'Failed to remove plugin companion workspaces', {
      meta: { dir, error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}
