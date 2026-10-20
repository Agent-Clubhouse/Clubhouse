/**
 * Retention for the local log folder (spec §6.12, #2298): local telemetry
 * recordings (`telemetry-*.jsonl`) and the session logs earlier versions
 * wrote (`session-*.jsonl`, #2313) share the logging retention tier's age
 * and size limits. Runs when recording starts, hourly while recording, and
 * after the recorder rotates, so a run that lasts days is pruned while it
 * runs.
 *
 * No OpenTelemetry imports.
 */
import type { Dirent } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { LogRetentionConfig } from '../../shared/types';

export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/** File name prefixes retention manages. Nothing writes `session-` files since #2313; they are pruned so old ones age out. */
export const RETAINED_PREFIXES = ['telemetry-', 'session-'] as const;

export interface PruneOptions {
  /** Files being written right now; never deleted. */
  protect?: readonly string[];
  now?: number;
}

export interface PruneResult {
  deleted: string[];
}

function isRetained(name: string): boolean {
  return name.endsWith('.jsonl') && RETAINED_PREFIXES.some((p) => name.startsWith(p));
}

/** Prune `dir` to the tier: age first, then oldest-first down to the total size. Never throws. */
export async function pruneLogDir(dir: string, tier: LogRetentionConfig, opts: PruneOptions = {}): Promise<PruneResult> {
  const deleted: string[] = [];
  const protect = new Set((opts.protect ?? []).map((f) => path.resolve(f)));
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { deleted };
  }

  const files: { filePath: string; mtimeMs: number; size: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isRetained(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fsp.stat(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // Gone already, or unreadable: skip it.
    }
  }

  const remove = async (filePath: string): Promise<boolean> => {
    if (protect.has(path.resolve(filePath))) return false;
    try {
      await fsp.unlink(filePath);
      deleted.push(filePath);
      return true;
    } catch {
      return false;
    }
  };

  // Phase 1: age (0 days means unlimited).
  if (tier.retentionDays > 0) {
    const cutoff = (opts.now ?? Date.now()) - tier.retentionDays * 24 * 60 * 60 * 1000;
    for (let i = files.length - 1; i >= 0; i--) {
      if (files[i].mtimeMs < cutoff && (await remove(files[i].filePath))) files.splice(i, 1);
    }
  }

  // Phase 2: total size, oldest first (0 bytes means unlimited). Protected
  // files count toward the total but are skipped.
  if (tier.maxTotalBytes > 0) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of files) {
      if (total <= tier.maxTotalBytes) break;
      if (await remove(f.filePath)) total -= f.size;
    }
  }
  return { deleted };
}
