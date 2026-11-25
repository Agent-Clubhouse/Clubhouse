import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from './log-service';

/**
 * The remote chat CLI kill switch is gone (#3515, decision on #2827). Older
 * builds saved the list their update manifest carried in `chat-cli-denylist.json`
 * in the app data folder; nothing reads it now. Remove it once, with the exact
 * recovery and temp copies the settings store (settings-store.ts) writes beside
 * it: after the first run no file matches, so later starts do nothing. Any other
 * name, such as `chat-cli-denylist.json.bak`, was not written by the app and stays.
 */
export const RETIRED_CHAT_CLI_DENYLIST_FILE = 'chat-cli-denylist.json';

const FILE = RETIRED_CHAT_CLI_DENYLIST_FILE.replace(/\./g, '\\.');
/** The file, `.unreadable` and `.unreadable.<n>` (recoveryCopyPath), and the temp names `<name>.tmp-<pid>-<n>` with or without the leading dot (replaceFile, sweepTempFiles). */
const RETIRED_NAME = new RegExp(`^(?:${FILE}(?:\\.unreadable(?:\\.[1-9]\\d*)?)?|\\.?${FILE}\\.tmp-[1-9]\\d*-[1-9]\\d*)$`);

export const isRetiredChatCliDenylistName = (name: string): boolean => RETIRED_NAME.test(name);

/** Best-effort, one file at a time: a failure on one is logged and the rest still go. Returns the removed names. */
export async function removeSavedChatCliDenylist(userDataDir: string): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = (await fsp.readdir(userDataDir)).filter(isRetiredChatCliDenylistName);
  } catch (err) {
    // telemetry-exempt: best-effort startup cleanup, logged to the app log
    appLog('core:chat', 'warn', 'Could not look for the saved chat CLI denylist', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return removed;
  }
  for (const name of names) {
    const file = path.join(userDataDir, name);
    try {
      const stat = await fsp.lstat(file);
      // A folder with one of these names is not ours; a symlink is unlinked, never followed.
      if (stat.isDirectory()) continue;
      await fsp.rm(file, { force: true });
      removed.push(name);
    } catch (err) {
      // telemetry-exempt: best-effort startup cleanup, logged to the app log
      appLog('core:chat', 'warn', 'Could not remove a saved chat CLI denylist file', {
        meta: { name, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  if (removed.length > 0) {
    appLog('core:chat', 'info', 'Removed the saved chat CLI denylist; the remote kill switch no longer exists', {
      meta: { removed },
    });
  }
  return removed;
}
