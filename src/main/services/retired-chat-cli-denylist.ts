import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from './log-service';

/**
 * The remote chat CLI kill switch is gone (#3515, decision on #2827). Older
 * builds saved the list their update manifest carried in `chat-cli-denylist.json`
 * in the app data folder; nothing reads it now. Remove it, and the recovery and
 * temp copies the settings store may have left beside it, once: after the first
 * run no file matches, so later starts do nothing.
 */
export const RETIRED_CHAT_CLI_DENYLIST_FILE = 'chat-cli-denylist.json';

const isRetiredName = (name: string): boolean =>
  name === RETIRED_CHAT_CLI_DENYLIST_FILE
  || name.startsWith(`${RETIRED_CHAT_CLI_DENYLIST_FILE}.`)
  || name.startsWith(`.${RETIRED_CHAT_CLI_DENYLIST_FILE}.tmp-`);

/** Best-effort: failures are logged, never thrown. Returns the removed file names. */
export async function removeSavedChatCliDenylist(userDataDir: string): Promise<string[]> {
  const removed: string[] = [];
  try {
    const names = (await fsp.readdir(userDataDir)).filter(isRetiredName);
    for (const name of names) {
      await fsp.rm(path.join(userDataDir, name), { force: true });
      removed.push(name);
    }
  } catch (err) {
    // telemetry-exempt: best-effort startup cleanup, logged to the app log
    appLog('core:chat', 'warn', 'Could not remove the saved chat CLI denylist', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return removed;
  }
  if (removed.length > 0) {
    appLog('core:chat', 'info', 'Removed the saved chat CLI denylist; the remote kill switch no longer exists', {
      meta: { removed },
    });
  }
  return removed;
}
