import * as path from 'path';
import { getBaseDirPath } from '../base-dir';

/**
 * The Dispatcher's folder (#2533): `dispatcher` under the Clubhouse base dir.
 * Not `~/.clubhouse/assistant`, which cleanupRetiredPluginData deletes. It is
 * no git repo, and the Dispatcher's agent config lives in its `.clubhouse/`.
 */
export function getDispatcherPath(): string {
  return path.join(getBaseDirPath(), 'dispatcher');
}

/** The hidden built-in persona only the Dispatcher has (#2535). */
export const DISPATCHER_PERSONA = 'dispatcher';

/** The Dispatcher's workspace for plans and state between sessions. */
export function getDispatcherNotesPath(): string {
  return path.join(getDispatcherPath(), 'notes');
}

/** Case-insensitive on Windows, like the helper index's project keys. */
function pathKey(p: string): string {
  return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
}

/** True when `p` names the Dispatcher's folder. */
export function isDispatcherPath(p: string | undefined | null): boolean {
  if (!p) return false;
  return pathKey(p) === pathKey(getDispatcherPath());
}
