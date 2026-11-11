import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../base-dir', () => ({ getBaseDirPath: () => '/nonexistent-base-dir' }));

import { appendTimeline, isoWeekOf, linkTargets, rollUpTimeline } from './dispatcher-memory-timeline';

let root: string;
let timeline: string;
const read = (name: string) => fs.readFileSync(path.join(timeline, name), 'utf-8');
const names = () => fs.readdirSync(timeline).sort();

beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-timeline-')), 'memory');
  timeline = path.join(root, 'timeline');
});
afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

function day(key: string, lines: string[]): void {
  fs.mkdirSync(timeline, { recursive: true });
  fs.writeFileSync(path.join(timeline, `${key}.md`), `# ${key}\n\n${lines.join('\n')}\n`);
}

describe('ISO weeks', () => {
  it('numbers weeks the ISO way, including across a year boundary', () => {
    expect(isoWeekOf('2026-11-07').week).toBe('2026-W45');
    expect(isoWeekOf('2026-11-02').week).toBe('2026-W45');
    expect(isoWeekOf('2026-11-01').week).toBe('2026-W44');
    expect(isoWeekOf('2027-01-01').week).toBe('2026-W53');
    expect(isoWeekOf('2025-12-29').week).toBe('2026-W01');
  });
});

describe('appendTimeline', () => {
  it('keeps every entry when appends overlap', async () => {
    const at = new Date(2026, 10, 7, 9, 5);
    await Promise.all(Array.from({ length: 8 }, (_, i) => appendTimeline({ at, text: `Entry ${i}` }, root)));
    const text = read('2026-11-07.md');
    for (let i = 0; i < 8; i++) expect(text).toContain(`Entry ${i}\n`);
  });

  it('adds timestamped lines to the day file, with a transcript link', async () => {
    await appendTimeline({ at: new Date(2026, 10, 7, 9, 5), text: 'Checkout fixed\nin #412', transcript: 'transcripts/abc.jsonl' }, root);
    await appendTimeline({ at: new Date(2026, 10, 7, 14, 30), text: 'Release tagged' }, root);
    expect(read('2026-11-07.md')).toBe('# 2026-11-07\n\n- 09:05 Checkout fixed in #412 ([transcript](transcripts/abc.jsonl))\n- 14:30 Release tagged\n');
  });
});

describe('rollUpTimeline', () => {
  const now = new Date(2026, 10, 20, 12, 0);

  it('rolls old days into their week, keeps recent days, and is idempotent', async () => {
    day('2026-11-02', ['- 09:00 a ([transcript](t/1.jsonl))']);
    day('2026-11-03', ['- 10:00 b']);
    day('2026-11-19', ['- 11:00 recent']);
    const first = await rollUpTimeline(now, {}, root);
    expect(first).toEqual({ days: ['2026-11-02', '2026-11-03'], weeks: [] });
    expect(names()).toEqual(['2026-11-19.md', '2026-W45.md']);
    const week = read('2026-W45.md');
    expect(week).toBe('# Week 2026-W45\n\n## 2026-11-02\n\n- 09:00 a ([transcript](t/1.jsonl))\n\n## 2026-11-03\n\n- 10:00 b\n');
    const second = await rollUpTimeline(now, {}, root);
    expect(second).toEqual({ days: [], weeks: [] });
    expect(read('2026-W45.md')).toBe(week);
  });

  it('rolls old weeks into the month of their Thursday', async () => {
    day('2026-09-28', ['- a ([t](t/sep.jsonl))']);
    day('2026-10-01', ['- b']);
    const result = await rollUpTimeline(now, {}, root);
    expect(result).toEqual({ days: ['2026-09-28', '2026-10-01'], weeks: ['2026-W40'] });
    expect(names()).toEqual(['2026-10.md']);
    const month = read('2026-10.md');
    expect(month).toContain('## 2026-W40');
    expect(month).toContain('t/sep.jsonl');
    expect(month).toContain('- b');
  });

  it('keeps every link when a condense step drops them', async () => {
    day('2026-11-02', ['- a ([transcript](t/1.jsonl))', '- b ([transcript](t/2.jsonl))']);
    const condense = vi.fn(async () => 'Short summary, see [one](t/1.jsonl).');
    await rollUpTimeline(now, { condense }, root);
    expect(condense).toHaveBeenCalledWith(expect.objectContaining({ into: 'week', from: '2026-11-02' }));
    const week = read('2026-W45.md');
    expect(linkTargets(week)).toEqual(['t/1.jsonl', 't/2.jsonl']);
  });

  it('a run that stopped after writing the week but before removing the day writes nothing twice', async () => {
    day('2026-11-02', ['- a']);
    await rollUpTimeline(now, {}, root);
    const week = read('2026-W45.md');
    day('2026-11-02', ['- a']);
    await rollUpTimeline(now, {}, root);
    expect(read('2026-W45.md')).toBe(week);
    expect(names()).toEqual(['2026-W45.md']);
  });

  it('does nothing without a timeline folder', async () => {
    expect(await rollUpTimeline(now, {}, root)).toEqual({ days: [], weeks: [] });
  });
});
