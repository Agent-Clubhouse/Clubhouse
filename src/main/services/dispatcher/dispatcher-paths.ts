import * as path from 'path';
import { getBaseDirPath } from '../base-dir';

/**
 * The Dispatcher's folder (#2533): `dispatcher` under the Clubhouse base dir.
 * Not `~/.clubhouse/assistant`, which is the removed Assistant's and may still
 * hold its data. It is no git repo, and the Dispatcher's agent config lives in
 * its `.clubhouse/`.
 *
 * Since #3036 the Dispatcher is two agents under one identity: the one in this
 * folder (it keeps the id, connections and links it always had) does the work
 * and is never shown, and the chat the user talks to lives in
 * {@link getDispatcherChatPath}. Code calls the first the "coordinator"; no
 * user-facing text ever does.
 */
export function getDispatcherPath(): string {
  return path.join(getBaseDirPath(), 'dispatcher');
}

/**
 * The chat's folder (#3036): a sibling of the Dispatcher's, never inside it.
 * CLIs read instructions files from parent folders too (Claude Code walks up
 * for CLAUDE.md), so a chat inside the coordinator's folder would also be told
 * the coordinator's instructions.
 */
export function getDispatcherChatPath(): string {
  return path.join(getBaseDirPath(), 'dispatcher-chat');
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

/**
 * The Dispatcher's memory (#3038): plain markdown, read by any provider. The
 * chat reads it with read_memory (#3036), never writes it.
 */
export function getDispatcherMemoryPath(): string {
  return path.join(getDispatcherPath(), 'memory');
}

/** Both of the Dispatcher's folders: the coordinator's first, then the chat's. */
export function getDispatcherFolders(): [string, string] {
  return [getDispatcherPath(), getDispatcherChatPath()];
}

/** Case-insensitive on Windows, like the helper index's project keys. */
function pathKey(p: string): string {
  return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
}

/** True when `p` names the coordinator's folder, the one that holds the Dispatcher's id. */
export function isDispatcherCoordinatorPath(p: string | undefined | null): boolean {
  if (!p) return false;
  return pathKey(p) === pathKey(getDispatcherPath());
}

/** True when `p` names the chat's folder. */
export function isDispatcherChatPath(p: string | undefined | null): boolean {
  if (!p) return false;
  return pathKey(p) === pathKey(getDispatcherChatPath());
}

/**
 * True when `p` names either of the Dispatcher's folders. Both are in no
 * project, hold no git repo, and are created and guarded by Clubhouse alone.
 */
export function isDispatcherPath(p: string | undefined | null): boolean {
  return isDispatcherCoordinatorPath(p) || isDispatcherChatPath(p);
}
