/**
 * Forget everything (#3046): Settings › Dispatcher's reset, behind a
 * confirmation. The Dispatcher's memory goes and starts over empty.
 *
 * What goes:
 * - `memory/` (index, agent pages, timeline, topics), made again with a fresh index;
 * - the old `notes/` folder, if it was never sorted into memory, and every
 *   `notes-archive` the sorting left (#3038): both are memory from before;
 * - news held for the next check-in (dispatcher-news), so a check-in can't
 *   bring back what was forgotten.
 *
 * What stays: the Dispatcher's agents and their ids, connections and links,
 * permissions, Actions and subscriptions, Behavior, and its conversation.
 * Clear chat (#3043) is the separate way to start the conversation over.
 *
 * Both instructions files are written again so the memory index they carry is
 * the empty one. An agent's card lived on its memory page, so the next
 * card sync asks it again (#3041).
 */
import * as fsp from 'fs/promises';
import { appLog } from '../log-service';
import { getDispatcherMemoryPath, getDispatcherNotesPath } from './dispatcher-paths';
import { ensureMemoryLayout } from './dispatcher-memory';
import { listNotesArchives } from './dispatcher-memory-migration';
import { clearHeldNews } from './dispatcher-news';
import { refreshDispatcherInstructions } from './dispatcher-service';
import type { ForgetEverythingResult } from '../../../shared/dispatcher-settings-page';

export interface ForgetDeps {
  memoryPath?: () => string;
  notesPath?: () => string;
  listArchives?: () => Promise<string[]>;
  ensureLayout?: (root: string) => Promise<unknown>;
  clearHeld?: () => number;
  refreshInstructions?: () => Promise<void>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    // telemetry-exempt: a missing folder is simply nothing to remove.
    return false;
  }
}

/** Remove the Dispatcher's memory and held news. Agents, connections and Actions are not touched. */
export async function forgetEverything(deps: ForgetDeps = {}): Promise<ForgetEverythingResult> {
  const memory = (deps.memoryPath ?? getDispatcherMemoryPath)();
  const targets = [memory, (deps.notesPath ?? getDispatcherNotesPath)(), ...(await (deps.listArchives ?? listNotesArchives)())];

  let removed = 0;
  for (const target of targets) {
    if (!(await exists(target))) continue;
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    removed++;
  }
  await (deps.ensureLayout ?? ensureMemoryLayout)(memory);
  const heldNews = (deps.clearHeld ?? clearHeldNews)();

  try {
    await (deps.refreshInstructions ?? refreshDispatcherInstructions)();
  } catch (err) {
    // telemetry-exempt: memory is already cleared; each start writes the instructions again anyway.
    appLog('core:dispatcher', 'warn', 'Instructions not rewritten after Forget everything', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  appLog('core:dispatcher', 'info', 'Dispatcher memory forgotten', { meta: { removed, heldNews } });
  return { removed, heldNews };
}
