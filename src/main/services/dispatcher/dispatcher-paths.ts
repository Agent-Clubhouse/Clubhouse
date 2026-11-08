import * as path from 'path';
import { getBaseDirPath } from '../base-dir';

/**
 * The Dispatcher's folder (#2533): `dispatcher` under the Clubhouse base dir.
 * Not `~/.clubhouse/assistant`, which is the removed Assistant's and may still
 * hold its data. It is no git repo, and the Dispatcher's agent config lives in
 * its `.clubhouse/`.
 */
export function getDispatcherPath(): string {
  return path.join(getBaseDirPath(), 'dispatcher');
}

/**
 * The Dispatcher's old workspace for plans and state between sessions. Retired
 * by #3038: its contents are sorted into memory once, and the folder is renamed
 * to getDispatcherNotesArchivePath().
 */
export function getDispatcherNotesPath(): string {
  return path.join(getDispatcherPath(), 'notes');
}

/**
 * Where the retired `notes/` folder goes, as it was (#3038). Outside memory, so
 * its bundles don't count toward memory size or search. It is memory from before
 * the migration: Forget everything clears it too (a `notes/` that appeared again
 * later goes to `notes-archive-2` and so on; see listNotesArchives).
 */
export function getDispatcherNotesArchivePath(): string {
  return path.join(getDispatcherPath(), 'notes-archive');
}

/** The Dispatcher's memory (#3038): plain markdown, read by any provider. */
export function getDispatcherMemoryPath(): string {
  return path.join(getDispatcherPath(), 'memory');
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
