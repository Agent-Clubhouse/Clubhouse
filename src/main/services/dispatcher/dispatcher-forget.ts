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
import * as path from 'path';
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

/** Bumped by every Forget everything, from any surface, so a confirmation read before it goes stale (#3206). */
let forgetGeneration = 0;

/** How many times memory was forgotten in this run. A phone's Forget everything confirmation is bound to it. */
export function getForgetGeneration(): number {
  return forgetGeneration;
}

/**
 * What the memory folder holds now: its file count, total size and newest
 * change. A phone's Forget everything confirmation is bound to it, so one read
 * before the memory grew no longer confirms forgetting it. Never throws: a
 * missing folder is empty.
 */
export async function memoryFingerprint(root: string = getDispatcherMemoryPath()): Promise<{ files: number; bytes: number; newestMs: number }> {
  const out = { files: 0, bytes: 0, newestMs: 0 };
  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // telemetry-exempt: a missing or unreadable folder counts as empty.
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      try {
        const stat = await fsp.stat(full);
        out.files++;
        out.bytes += stat.size;
        out.newestMs = Math.max(out.newestMs, stat.mtimeMs);
      } catch {
        // telemetry-exempt: a file removed while it was read no longer counts.
      }
    }
  };
  await walk(root);
  return out;
}

/** Remove the Dispatcher's memory and held news. Agents, connections and Actions are not touched. */
export async function forgetEverything(deps: ForgetDeps = {}): Promise<ForgetEverythingResult> {
  // Before anything goes, so a second request confirmed for the same memory can't run it again.
  forgetGeneration++;
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
