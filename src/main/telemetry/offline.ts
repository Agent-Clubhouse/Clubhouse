/**
 * Offline queue directory (spec §6.7). The Azure exporter persists failed
 * batches here and retries them. Its own limits are hardcoded in beta.46
 * (50 MB, 48 h retention, not configurable), so we prune to our tighter
 * budget: 20 MB and 48 h. The queue holds post-redaction data only.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';

export const OFFLINE_MAX_BYTES = 20 * 1024 * 1024;
export const OFFLINE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const OFFLINE_PRUNE_INTERVAL_MS = 15 * 60 * 1000;

export function getTelemetryDir(): string {
  return path.join(app.getPath('home'), '.clubhouse', 'telemetry');
}

export function getOfflineDir(): string {
  return path.join(getTelemetryDir(), 'offline');
}

interface FileEntry {
  file: string;
  size: number;
  mtimeMs: number;
}

async function walk(dir: string, out: FileEntry[]): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile()) {
      try {
        const st = await fsp.stat(full);
        out.push({ file: full, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Raced with the exporter deleting a sent batch.
      }
    }
  }
}

export interface PruneResult {
  deletedFiles: number;
  remainingBytes: number;
  remainingFiles: number;
}

/** Delete expired files, then the oldest ones until the directory fits the budget. */
export async function pruneOfflineDir(
  dir: string,
  { maxBytes = OFFLINE_MAX_BYTES, maxAgeMs = OFFLINE_MAX_AGE_MS, now = Date.now() } = {},
): Promise<PruneResult> {
  const files: FileEntry[] = [];
  await walk(dir, files);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let total = files.reduce((sum, f) => sum + f.size, 0);
  let deleted = 0;
  const keep: FileEntry[] = [];
  for (const f of files) {
    const expired = now - f.mtimeMs > maxAgeMs;
    if (expired || total > maxBytes) {
      try {
        await fsp.unlink(f.file);
        total -= f.size;
        deleted++;
        continue;
      } catch {
        // Fall through and count it as remaining.
      }
    }
    keep.push(f);
  }
  return { deletedFiles: deleted, remainingBytes: total, remainingFiles: keep.length };
}

export async function countOfflineItems(dir: string): Promise<number> {
  const files: FileEntry[] = [];
  await walk(dir, files);
  return files.length;
}

export async function deleteOfflineData(dir = getOfflineDir()): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}
