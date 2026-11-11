import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../base-dir', () => ({ getBaseDirPath: () => '/nonexistent-base-dir' }));

import { renderAgentPage, renderTopicPage } from './dispatcher-memory';
import { listMemoryPages, measureMemoryHealth, runMemoryUpkeep } from './dispatcher-upkeep';

const DAY = 24 * 60 * 60 * 1000;
/** Monday 2026-11-09, noon local. */
const NOW = new Date(2026, 10, 9, 12, 0);

let tmp: string;
let root: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-upkeep-'));
  root = path.join(tmp, 'memory');
  for (const dir of ['agents', 'timeline', 'topics']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.md'), '# Index\n\nShort.\n');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, text: string, ageDays = 0): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const t = new Date(NOW.getTime() - ageDays * DAY);
  fs.utimesSync(file, t, t);
}

const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

/** Every file under memory with its content, for before/after comparisons. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(root);
  return out;
}

const topic = (status: 'confirmed' | 'unconfirmed', body: string, source = 'pm said so') => renderTopicPage({ status, source, body });

describe('runMemoryUpkeep: pruning keeps every page it shouldn’t prune', () => {
  beforeEach(() => {
    write('index.md', '# Index\n\n- Current work: [checkout](topics/checkout.md)\n', 90);
    write('topics/checkout.md', topic('unconfirmed', 'Linked from the index.\n'), 90);
    write('topics/old-confirmed.md', topic('confirmed', 'Old but confirmed.\n'), 90);
    write('topics/recent-guess.md', topic('unconfirmed', 'Unconfirmed but recent.\n'), 3);
    write('topics/hand-written.md', 'No Status header, so upkeep can’t judge it.\n', 90);
    write('topics/named.md', topic('unconfirmed', 'Named in an agent’s notes without a link.\n'), 90);
    write('topics/in-timeline.md', topic('unconfirmed', 'Linked from the timeline.\n'), 90);
    write('topics/by-title.md', topic('unconfirmed', 'Linked by its title.\n'), 90);
    write('agents/pm.md', renderAgentPage('pm', { card: 'Plans the work.', notes: 'Owns topics/named for now. See [the plan](../topics/By%20Title.md).' }), 90);
    write('timeline/2026-11-08.md', '# 2026-11-08\n\n- 10:00 Started [it](../topics/in-timeline.md)\n', 1);
    write('topics/stale.md', topic('unconfirmed', 'Nobody links here; points at [another](leaf.md).\n'), 90);
    write('topics/leaf.md', topic('unconfirmed', 'Only the stale page links here.\n'), 90);
  });

  it('archives only stale, unconfirmed topics nothing kept refers to, and deletes nothing', async () => {
    const before = Object.keys(snapshot()).length;
    const report = await runMemoryUpkeep(NOW, { root, fileExists: async () => true });
    expect(report.archived.sort()).toEqual(['topics/leaf.md', 'topics/stale.md']);
    for (const kept of ['checkout', 'old-confirmed', 'recent-guess', 'hand-written', 'named', 'in-timeline', 'by-title']) {
      expect(exists(`topics/${kept}.md`), kept).toBe(true);
    }
    expect(exists('agents/pm.md')).toBe(true);
    expect(exists('timeline/2026-11-08.md')).toBe(true);
    expect(read('archive/topics/stale.md')).toContain('Nobody links here');
    expect(read('archive/topics/leaf.md')).toContain('Only the stale page');
    expect(Object.keys(snapshot()).length).toBe(before);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await runMemoryUpkeep(NOW, { root, fileExists: async () => true });
    const after = snapshot();
    const second = await runMemoryUpkeep(NOW, { root, fileExists: async () => true });
    expect(second.changed).toBe(false);
    expect(second.archived).toEqual([]);
    expect(second.linksFixed).toEqual([]);
    expect(second.rolledUp).toEqual({ days: [], weeks: [] });
    expect(snapshot()).toEqual(after);
  });

  it('a name clash in the archive gets a new name instead of overwriting', async () => {
    write('archive/topics/stale.md', 'pruned earlier\n');
    await runMemoryUpkeep(NOW, { root, fileExists: async () => true });
    expect(read('archive/topics/stale.md')).toBe('pruned earlier\n');
    expect(read('archive/topics/stale-2.md')).toContain('Nobody links here');
  });
});

describe('runMemoryUpkeep: timeline and links', () => {
  it.each(['topics/notes.md', 'agents/web.md', 'index.md'])('preserves the modification time when repairing links in %s (part of #3218)', async (page) => {
    write('topics/checkout-fix.md', topic('confirmed', 'x\n'), 1);
    const body = 'See [fix](topics/Checkout%20Fix.md).\n';
    const text = page.startsWith('agents/') ? renderAgentPage('web', { card: 'Web work.', notes: body })
      : page.startsWith('topics/') ? topic('unconfirmed', body) : body;
    write(page, text, 29);
    const file = path.join(root, page);
    const before = fs.statSync(file).mtimeMs;
    const report = await runMemoryUpkeep(NOW, { root });
    expect(report.linksFixed).toHaveLength(1);
    const target = page === 'index.md' ? 'topics/checkout-fix.md' : page.startsWith('agents/') ? '../topics/checkout-fix.md' : 'checkout-fix.md';
    expect(read(page)).toContain(`](${target})`);
    expect(Math.abs(fs.statSync(file).mtimeMs - before)).toBeLessThan(1);
    expect(report.archived).toEqual([]);
  });

  it('still archives an unreferenced stale topic whose link was just repaired (part of #3218)', async () => {
    write('topics/checkout-fix.md', topic('confirmed', 'x\n'), 1);
    write('topics/stale.md', topic('unconfirmed', 'See [fix](Checkout%20Fix.md).\n'), 31);
    const before = fs.statSync(path.join(root, 'topics', 'stale.md')).mtimeMs;
    const report = await runMemoryUpkeep(NOW, { root });
    expect(report.linksFixed).toHaveLength(1);
    expect(report.archived).toEqual(['topics/stale.md']);
    expect(read('archive/topics/stale.md')).toContain('](checkout-fix.md)');
    expect(Math.abs(fs.statSync(path.join(root, 'archive', 'topics', 'stale.md')).mtimeMs - before)).toBeLessThan(1);
  });

  it('keeps a referenced stale topic stale in memory health after repairing its link (part of #3218)', async () => {
    write('topics/checkout-fix.md', topic('confirmed', 'x\n'), 1);
    write('topics/stale.md', topic('unconfirmed', 'See [fix](Checkout%20Fix.md).\n'), 31);
    write('index.md', '[Kept](topics/stale.md)\n');
    const report = await runMemoryUpkeep(NOW, { root });
    expect(report.linksFixed).toHaveLength(1);
    expect(report.archived).toEqual([]);
    expect(await measureMemoryHealth(NOW, report, { root })).toMatchObject({ staleTopics: 1, unconfirmedTopics: 1 });
  });

  it('rolls old days into their week and points links at the rolled section', async () => {
    write('timeline/2026-10-28.md', '# 2026-10-28\n\n- 09:00 Shipped ([transcript](/t/a.jsonl#L3))\n', 12);
    write('topics/release.md', topic('confirmed', 'See [the day](../timeline/2026-10-28.md).\n'), 1);
    const report = await runMemoryUpkeep(NOW, { root, fileExists: async () => true });
    expect(report.rolledUp.days).toEqual(['2026-10-28']);
    expect(exists('timeline/2026-W44.md')).toBe(true);
    expect(read('topics/release.md')).toContain('](../timeline/2026-W44.md#2026-10-28)');
    expect(report.linksFixed).toEqual([{ page: 'topics/release.md', from: '../timeline/2026-10-28.md', to: '../timeline/2026-W44.md#2026-10-28' }]);
    expect(report.brokenLinks).toEqual([]);
  });

  it('fixes a link by title to the page’s file name, and a link to an archived page', async () => {
    write('topics/checkout-fix.md', topic('confirmed', 'x\n'), 1);
    write('archive/topics/gone.md', topic('unconfirmed', 'y\n'), 1);
    write('topics/notes.md', topic('confirmed', 'See [fix](Checkout%20Fix.md) and [gone](gone.md).\n'), 1);
    await runMemoryUpkeep(NOW, { root, fileExists: async () => true });
    expect(read('topics/notes.md')).toBe(topic('confirmed', 'See [fix](checkout-fix.md) and [gone](../archive/topics/gone.md).\n'));
  });

  it('reports a link it can’t fix and leaves it as written', async () => {
    write('topics/a.md', topic('confirmed', 'See [missing](nowhere.md).\n'), 1);
    const report = await runMemoryUpkeep(NOW, { root, fileExists: async () => true });
    expect(report.brokenLinks).toEqual([{ page: 'topics/a.md', target: 'nowhere.md' }]);
    expect(read('topics/a.md')).toContain('[missing](nowhere.md)');
  });

  it('never edits an agent’s card, only the Dispatcher’s notes', async () => {
    write('topics/checkout-fix.md', topic('confirmed', 'x\n'), 1);
    write('agents/web.md', renderAgentPage('web', { card: 'Owns [checkout](../topics/Checkout%20Fix.md).', notes: 'Asked about [it](../topics/Checkout%20Fix.md).' }), 1);
    const report = await runMemoryUpkeep(NOW, { root, fileExists: async () => true });
    const text = read('agents/web.md');
    expect(text).toContain('Owns [checkout](../topics/Checkout%20Fix.md).');
    expect(text).toContain('Asked about [it](../topics/checkout-fix.md).');
    expect(report.linksFixed).toHaveLength(1);
  });

  it('leaves web links and search-hit links alone', async () => {
    write('topics/a.md', topic('confirmed', 'See [docs](https://example.com/x) and [hit](memory/topics/a.md#L2).\n'), 1);
    const report = await runMemoryUpkeep(NOW, { root, fileExists: async () => true });
    expect(report.brokenLinks).toEqual([]);
    expect(report.changed).toBe(false);
  });
});

describe('runMemoryUpkeep: cited sources', () => {
  it('reports a topic Source or a transcript link whose file is gone', async () => {
    const live = path.join(tmp, 'live.jsonl');
    const gone = path.join(tmp, 'gone.jsonl');
    fs.writeFileSync(live, '{}\n');
    write('topics/a.md', topic('unconfirmed', 'Body.\n', `${gone}#L4`), 1);
    write('topics/b.md', topic('unconfirmed', 'Body.\n', `${live}#L1`), 1);
    write('timeline/2026-11-09.md', `# 2026-11-09\n\n- 09:00 Did it ([transcript](${gone}#L9))\n`, 0);
    const report = await runMemoryUpkeep(NOW, { root });
    expect(report.missingSources).toEqual(expect.arrayContaining([
      { page: 'topics/a.md', source: `${gone}#L4` },
      { page: 'timeline/2026-11-09.md', source: `${gone}#L9` },
    ]));
    expect(report.missingSources.some((m) => m.page === 'topics/b.md')).toBe(false);
  });
});

describe('listMemoryPages', () => {
  it('lists pages with topic status, not the archive', async () => {
    write('topics/a.md', topic('unconfirmed', 'x\n'), 1);
    write('archive/topics/b.md', topic('unconfirmed', 'x\n'), 1);
    const pages = await listMemoryPages(root);
    expect(pages.map((p) => p.page)).toEqual(['index.md', 'topics/a.md']);
    expect(pages[1].status).toBe('unconfirmed');
  });

  it('does nothing for a memory folder that doesn’t exist', async () => {
    const report = await runMemoryUpkeep(NOW, { root: path.join(tmp, 'nope') });
    expect(report.changed).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'nope'))).toBe(false);
  });
});
