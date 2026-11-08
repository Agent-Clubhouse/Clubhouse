/**
 * Retention for rich chat media (#2828).
 *
 * Every agent's images live in `<agent transcript dir>/media`, named by the
 * hash of their bytes, so an agent's sessions share one copy. Nothing else
 * removes them, so two rules keep the folders bounded with no setting:
 *
 * - **A size cap across all agents.** When the media folders together pass
 *   `CHAT_MEDIA_TOTAL_CAP_BYTES`, the least recently used images are removed
 *   until they are under `CHAT_MEDIA_PRUNE_TARGET_BYTES`. An image counts as
 *   used when it is stored, stored again, or read for display, so previews
 *   people still look at stay. Images used in the last
 *   `CHAT_MEDIA_MIN_AGE_MS` are never removed, so a chat that is showing one
 *   now keeps it.
 * - **Deleting an agent removes its media.** Its chat can't be opened any
 *   more, so nothing can show those images.
 *
 * A removed image shows as unavailable, the same as one that could not be
 * read. Transcripts are not changed.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { isMediaRef } from '../../../shared/chat';
import { agentMediaDir, chatTranscriptRoot } from './chat-transcript';
import { appLog } from '../log-service';

export const CHAT_MEDIA_TOTAL_CAP_BYTES = 1024 * 1024 * 1024;
/** Pruning goes below the cap so it doesn't run again after every new image. */
export const CHAT_MEDIA_PRUNE_TARGET_BYTES = Math.floor(CHAT_MEDIA_TOTAL_CAP_BYTES * 0.8);
export const CHAT_MEDIA_MIN_AGE_MS = 10 * 60_000;
/** A write's temporary file older than this was left by a crash. */
const STALE_TEMP_MS = 60 * 60_000;
/** A new image schedules a check this long after it, so a burst shares one. */
const PRUNE_DELAY_MS = 60_000;

interface MediaFile { file: string; size: number; usedAt: number }

export interface PruneResult { scannedBytes: number; removedFiles: number; removedBytes: number }

async function listMediaFiles(now: number): Promise<MediaFile[]> {
  const files: MediaFile[] = [];
  let agents: string[];
  try {
    agents = (await fsp.readdir(chatTranscriptRoot(), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return files;
  }
  for (const agent of agents) {
    const dir = path.join(chatTranscriptRoot(), agent, 'media');
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const st = await fsp.lstat(file).catch((): null => null);
      if (!st?.isFile()) continue;
      const temp = name.endsWith('.tmp');
      if (isMediaRef(name)) files.push({ file, size: st.size, usedAt: st.mtimeMs });
      else if (temp && now - st.mtimeMs > STALE_TEMP_MS) await fsp.rm(file, { force: true }).catch((): void => undefined);
    }
  }
  return files;
}

/** Remove the least recently used media once all agents' media is over the cap. */
export async function pruneChatMedia(opts: { capBytes?: number; targetBytes?: number; minAgeMs?: number; now?: number } = {}): Promise<PruneResult> {
  const cap = opts.capBytes ?? CHAT_MEDIA_TOTAL_CAP_BYTES;
  const target = opts.targetBytes ?? Math.min(CHAT_MEDIA_PRUNE_TARGET_BYTES, cap);
  const minAge = opts.minAgeMs ?? CHAT_MEDIA_MIN_AGE_MS;
  const now = opts.now ?? Date.now();
  const files = await listMediaFiles(now);
  const scannedBytes = files.reduce((sum, f) => sum + f.size, 0);
  const result: PruneResult = { scannedBytes, removedFiles: 0, removedBytes: 0 };
  if (scannedBytes <= cap) return result;
  let total = scannedBytes;
  for (const f of files.sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= target || now - f.usedAt < minAge) break;
    try {
      // Stored again or shown since the scan: it's in use, so keep it.
      const st = await fsp.lstat(f.file).catch((): null => null);
      if (!st) { total -= f.size; continue; }
      if (st.mtimeMs !== f.usedAt) continue;
      await fsp.rm(f.file, { force: true });
      total -= f.size;
      result.removedFiles++;
      result.removedBytes += f.size;
    } catch {
      // Left for the next check.
    }
  }
  appLog('core:chat', 'info', 'Removed least recently used chat media over the size cap', {
    meta: { scannedBytes, removedFiles: result.removedFiles, removedBytes: result.removedBytes, capBytes: cap },
  });
  return result;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<unknown> | undefined;

/** Check the cap soon. Called after a new image is stored and once at startup. */
export function scheduleChatMediaPrune(delayMs = PRUNE_DELAY_MS): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    // A check during a long prune runs once that one ends, so it isn't lost.
    if (running) { void running.finally(() => scheduleChatMediaPrune(delayMs)); return; }
    running = pruneChatMedia()
      .catch((error: unknown) => {
        // telemetry-exempt: best-effort housekeeping; the next check retries.
        appLog('core:chat', 'warn', 'Chat media cleanup failed', { meta: { error: error instanceof Error ? error.message : String(error) } });
      })
      .finally(() => { running = undefined; });
  }, delayMs);
  timer.unref?.();
}

/** Mark a stored image as used, so the cap removes it last. False when it's gone. */
export async function touchChatMedia(file: string): Promise<boolean> {
  const now = new Date();
  try {
    await fsp.utimes(file, now, now);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Remove a deleted agent's media. Its transcripts are left as they are. */
export async function removeAgentChatMedia(agentId: string): Promise<void> {
  try {
    await fsp.rm(agentMediaDir(agentId), { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    // telemetry-exempt: best-effort cleanup; the size cap removes it later.
    appLog('core:chat', 'warn', 'Could not remove a deleted agent\'s chat media', { meta: { agentId, error: error instanceof Error ? error.message : String(error) } });
  }
}

export function resetChatMediaRetentionForTests(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  running = undefined;
}
