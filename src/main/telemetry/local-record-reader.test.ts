import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readRecordedEvents, recordFilesNewestFirst } from './local-record-reader';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-reader-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const line = (name: string, ts: string, extra: object = {}) => JSON.stringify({ t: 'event', ts, name, severity: 'info', attrs: {}, ...extra });
const write = (file: string, lines: string[]) => fs.writeFileSync(path.join(dir, file), `${lines.join('\n')}\n`);

describe('local record reader (#2920)', () => {
  it('orders files by recorder start, then chunk, newest first, and ignores other files', async () => {
    write('telemetry-2026-11-07T10-00-00.000.jsonl', []);
    write('telemetry-2026-11-08T09-00-00.000.jsonl', []);
    write('telemetry-2026-11-08T09-00-00.000.2.jsonl', []);
    write('telemetry-2026-11-08T09-00-00.000.10.jsonl', []);
    write('session-old.jsonl', []);
    expect((await recordFilesNewestFirst(dir)).map((f) => path.basename(f))).toEqual([
      'telemetry-2026-11-08T09-00-00.000.10.jsonl',
      'telemetry-2026-11-08T09-00-00.000.2.jsonl',
      'telemetry-2026-11-08T09-00-00.000.jsonl',
      'telemetry-2026-11-07T10-00-00.000.jsonl',
    ]);
  });

  it('reads the newest events of one name across files, skipping torn lines and other records', async () => {
    write('telemetry-2026-11-07T10-00-00.000.jsonl', [line('clubhouse.audit.setting', 'old-1'), line('clubhouse.audit.setting', 'old-2')]);
    write('telemetry-2026-11-08T09-00-00.000.jsonl', [
      line('clubhouse.audit.setting', 'new-1', { detail: { key: 'theme' } }),
      '{"t":"event","name":"clubhouse.audit.setting","ts":"to',
      line('clubhouse.ui.feature_used', 'other'),
      JSON.stringify({ t: 'span', name: 'clubhouse.audit.setting', ts: 'span' }),
      line('clubhouse.audit.setting', 'new-2'),
    ]);
    const events = await readRecordedEvents(dir, 'clubhouse.audit.setting', 3);
    expect(events.map((e) => e.ts)).toEqual(['new-2', 'new-1', 'old-2']);
    expect(events[1].detail).toEqual({ key: 'theme' });
    expect(await readRecordedEvents(dir, 'clubhouse.audit.setting', 0)).toEqual([]);
    expect(await readRecordedEvents(path.join(dir, 'missing'), 'clubhouse.audit.setting', 5)).toEqual([]);
  });
});
