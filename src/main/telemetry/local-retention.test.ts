import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_RETENTION_TIERS } from '../../shared/types';
import { pruneLogDir } from './local-retention';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-retention-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A file of `size` bytes last modified `ageMs` ago. */
function file(name: string, size: number, ageMs: number, now = Date.now()): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x'.repeat(size));
  const t = (now - ageMs) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

const left = () => fs.readdirSync(dir).sort();

describe('log folder retention', () => {
  it('ages out telemetry recordings and legacy session logs past the tier', async () => {
    const now = Date.now();
    file('telemetry-old.jsonl', 10, 8 * DAY, now);
    file('session-old.jsonl', 10, 8 * DAY, now);
    file('telemetry-new.jsonl', 10, DAY, now);
    file('notes.txt', 10, 30 * DAY, now);
    await pruneLogDir(dir, LOG_RETENTION_TIERS.medium, { now });
    expect(left()).toEqual(['notes.txt', 'telemetry-new.jsonl']);
  });

  it('deletes oldest first until the folder is within the total size', async () => {
    const tier = { retentionDays: 0, maxTotalBytes: 250 };
    file('telemetry-a.jsonl', 100, 3_000);
    file('session-b.jsonl', 100, 2_000);
    file('telemetry-c.jsonl', 100, 1_000);
    const { deleted } = await pruneLogDir(dir, tier);
    expect(deleted.map((d) => path.basename(d))).toEqual(['telemetry-a.jsonl']);
    expect(left()).toEqual(['session-b.jsonl', 'telemetry-c.jsonl']);
  });

  it('never deletes a file being written, but still counts it', async () => {
    const tier = { retentionDays: 1, maxTotalBytes: 150 };
    const current = file('telemetry-current.jsonl', 100, 5 * DAY);
    file('telemetry-other.jsonl', 100, 1_000);
    await pruneLogDir(dir, tier, { protect: [current] });
    expect(left()).toEqual(['telemetry-current.jsonl']);
  });

  it('keeps everything with unlimited retention', async () => {
    file('telemetry-a.jsonl', 10_000, 365 * DAY);
    await pruneLogDir(dir, LOG_RETENTION_TIERS.unlimited);
    expect(left()).toEqual(['telemetry-a.jsonl']);
  });

  it('never throws for a missing folder', async () => {
    await expect(pruneLogDir(path.join(dir, 'missing'), LOG_RETENTION_TIERS.low)).resolves.toEqual({ deleted: [] });
  });
});
