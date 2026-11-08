/**
 * Reading the local record back (#2920): the newest events of one name from
 * `telemetry-*.jsonl`, newest first. Used where the record is the source of
 * truth, such as the Dispatcher's `list_orchestrator_controls`. Reads the
 * newest files first and stops once it has enough, so a long history costs
 * only what's asked for.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import type { EventName } from '../../shared/telemetry/attributes';
import { LOCAL_FILE_PREFIX } from './local-recorder';

export interface RecordedEvent {
  ts: string;
  name: EventName;
  attrs: Record<string, unknown>;
  detail?: Record<string, unknown>;
}

const FILE = new RegExp(`^${LOCAL_FILE_PREFIX}(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}(?:\\.\\d{1,3})?)(?:\\.(\\d+))?\\.jsonl$`);

/** The record's files, newest first: by recorder start, then by chunk. */
export async function recordFilesNewestFirst(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, m: FILE.exec(name) }))
    .filter((f): f is { name: string; m: RegExpExecArray } => f.m !== null)
    .sort((a, b) => (a.m[1] === b.m[1] ? Number(b.m[2] ?? 0) - Number(a.m[2] ?? 0) : a.m[1] < b.m[1] ? 1 : -1))
    .map((f) => path.join(dir, f.name));
}

/** Up to `limit` events named `name`, newest first. Unreadable files and torn lines are skipped. */
export async function readRecordedEvents(dir: string, name: EventName, limit: number): Promise<RecordedEvent[]> {
  const out: RecordedEvent[] = [];
  if (limit <= 0) return out;
  const needle = `"name":${JSON.stringify(name)}`;
  for (const file of await recordFilesNewestFirst(dir)) {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i];
      if (!line.includes(needle)) continue;
      try {
        const rec = JSON.parse(line) as { t?: unknown; ts?: unknown; name?: unknown; attrs?: unknown; detail?: unknown };
        if (rec.t !== 'event' || rec.name !== name || typeof rec.ts !== 'string') continue;
        out.push({
          ts: rec.ts, name,
          attrs: rec.attrs && typeof rec.attrs === 'object' ? rec.attrs as Record<string, unknown> : {},
          ...(rec.detail && typeof rec.detail === 'object' && { detail: rec.detail as Record<string, unknown> }),
        });
      } catch {
        // telemetry-exempt: a torn line (a crash mid-write) is skipped; the rest still read
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}
