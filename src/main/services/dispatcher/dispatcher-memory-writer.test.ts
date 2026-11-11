import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_MEMORY_ACCESS_PAGES, MEMORY_HISTORY_VERSIONS, memoryAccessPath, memoryWrite, observeMemoryPage,
  parseTopicPage, pruneMemoryHistory, readMemoryAccess, recordMemoryRead, renderAgentPage, writeAgentCard,
} from './dispatcher-memory';
import { readDispatcherMemory } from './dispatcher-memory-reader';
import { writeDispatcherMemory } from './dispatcher-memory-writer';
import { listMemoryPages, runMemoryUpkeep } from './dispatcher-upkeep';
import { searchDispatcher } from './dispatcher-search';

const NOW = new Date('2026-11-10T12:00:00Z');
const DAY = 86_400_000;
let base: string;
let root: string;
const topic = (body: string) => `Source: lead\nOwner: pm\nStatus: confirmed\n\n${body}`;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-writer-'));
  root = path.join(base, 'memory');
  fs.mkdirSync(root);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(base, { recursive: true, force: true });
});

function versions(page: string): string[] {
  const dir = path.join(root, 'history', ...page.split('/'));
  return fs.readdirSync(dir).sort().map((name) => fs.readFileSync(path.join(dir, name), 'utf8'));
}

describe('write_memory and shared memory writes', () => {
  it.each(['tool', 'shared', 'mechanical'])('bounds dated conflicts through %s writes without splitting Unicode', async (writer) => {
    const body = [
      `Conflicting: 2026-11-09 newest ${'🙂'.repeat(600)}`,
      'An ordinary fact stays here.',
      ...[4, 8, 2, 7, 1, 6, 5].map((day) => `Conflicting: 2026-11-0${day} fact-${day} ${'🙂'.repeat(600)}`),
      `Conflicting: ordinary body label ${'x'.repeat(600)}`,
    ].join('\n');
    const text = writer === 'tool'
      ? (await writeDispatcherMemory('topics/conflicts.md', topic(body), root)).text
      : await memoryWrite('topics/conflicts.md', topic(body), 'conflict update', root, { preserveFreshness: writer === 'mechanical' });
    const notes = text.split('\n').filter((line) => /^Conflicting: \d{4}-\d{2}-\d{2}/.test(line));
    expect(notes).toHaveLength(5);
    expect(notes.map((line) => line.slice(13, 23)).sort()).toEqual(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
    expect(notes.every((line) => [...line].length === 500)).toBe(true);
    expect(Buffer.from(text).toString('utf8')).toBe(text);
    expect(text).toContain(`Conflicting: ordinary body label ${'x'.repeat(600)}`);
    expect(text).toContain('An ordinary fact stays here.');
  });

  it('keeps extension headers when a tool replacement supplies only the standard dated headers', async () => {
    await writeDispatcherMemory('topics/headers.md', topic('Old facts'), root);
    const replacement = 'Status: confirmed\nSource: transcript\nCreated: 2026-11-01T00:00:00Z\nUpdated: 2026-11-09T00:00:00Z\n\nNew facts';
    const written = await writeDispatcherMemory('topics/headers.md', replacement, root);
    expect(written.text).toContain('Owner: pm\n');
    expect(parseTopicPage(written.text)?.created).toBe(NOW.toISOString());
  });

  it('uses the reader path rules for new and existing pages, without writing outside memory', async () => {
    const secret = path.join(base, 'secret.md');
    fs.writeFileSync(secret, 'outside');
    for (const page of ['../secret.md', 'topics/../../secret.md', secret, 'C:\\secret.md', '\\\\host\\share\\secret.md', 'bad.txt', 'x:stream.md', 'x\0.md']) {
      await expect(writeDispatcherMemory(page, topic('bad'), root), page).rejects.toThrow();
    }
    expect(fs.readFileSync(secret, 'utf8')).toBe('outside');
    expect((await writeDispatcherMemory('topics\\release.md', topic('Ships.'), root)).page).toBe('topics/release.md');
    expect((await readDispatcherMemory('topics/release.md', root)).text).toContain('Ships.');
  });

  it('applies protections after normalizing paths and ignores protected-folder casing', async () => {
    await writeAgentCard('lead', 'Owns work', root);
    for (const folder of ['AGENTS', 'Agents']) {
      await expect(writeDispatcherMemory(`${folder}/lead.md`, renderAgentPage('lead', { card: 'Imposter', notes: '' }), root)).rejects.toThrow(/Card/);
    }
    expect(fs.readFileSync(path.join(root, 'agents', 'lead.md'), 'utf8')).toContain('Owns work');
    for (const page of ['HISTORY/old.md', 'History/old.md', 'ARCHIVE/topics/old.md', './archive/topics/old.md']) {
      await expect(writeDispatcherMemory(page, 'bad', root)).rejects.toThrow(/read only/);
    }
    await writeDispatcherMemory('topics/headers.md', topic('Keep these facts'), root);
    const before = fs.readFileSync(path.join(root, 'topics', 'headers.md'), 'utf8');
    for (const page of ['./topics/headers.md', 'topics//headers.md', 'TOPICS/headers.md']) {
      await expect(writeDispatcherMemory(page, 'No headers', root)).rejects.toThrow(/Status and Source/);
    }
    expect(fs.readFileSync(path.join(root, 'topics', 'headers.md'), 'utf8')).toBe(before);
  });

  it('rejects Windows device names and ambiguous path components on every platform', async () => {
    for (const page of ['CON.md', 'topics/AuX.md', 'COM1/page.md', 'LPT9.md', 'topics./page.md', 'topics /page.md', 'topics/a?.md', 'topics/a|b.md']) {
      await expect(writeDispatcherMemory(page, topic('bad'), root), page).rejects.toThrow();
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('keeps Card conflict lines untouched when bounding conflicts in Notes', async () => {
    fs.mkdirSync(path.join(root, 'agents'));
    const conflicts = Array.from({ length: 7 }, (_, i) => `Conflicting: 2026-11-0${i + 1} original fact`).join('\n');
    const text = renderAgentPage('lead', { card: conflicts, notes: 'Old notes' });
    fs.writeFileSync(path.join(root, 'agents', 'lead.md'), text);
    await writeDispatcherMemory('agents/lead.md', renderAgentPage('lead', { card: conflicts, notes: conflicts }), root);
    const written = fs.readFileSync(path.join(root, 'agents', 'lead.md'), 'utf8');
    expect(written.split('## Notes')[0]).toBe(text.split('## Notes')[0]);
    expect(written.split('## Notes')[1].match(/Conflicting:/g)).toHaveLength(5);
  });

  it.skipIf(process.platform === 'win32')('rejects file and ancestor symlinks, including dangling links and the index', async () => {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.md'), 'outside');
    fs.symlinkSync(outside, path.join(root, 'linked'));
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'index.md'));
    fs.symlinkSync(path.join(outside, 'missing.md'), path.join(root, 'dangling.md'));
    for (const page of ['linked/secret.md', 'linked/new.md', 'index.md', 'dangling.md']) {
      await expect(writeDispatcherMemory(page, 'bad', root)).rejects.toThrow(/links/);
    }
    await expect(readDispatcherMemory(undefined, root)).rejects.toThrow(/links/);
    expect(fs.readdirSync(outside)).toEqual(['secret.md']);
    fs.symlinkSync(outside, path.join(root, 'history'));
    await expect(writeDispatcherMemory('topics/new.md', topic('Do not escape through history'), root)).rejects.toThrow(/links/);
    expect(fs.readdirSync(outside)).toEqual(['secret.md']);
  });

  it('stamps topic dates, keeps Created and unknown headers, and records only bounded access metadata', async () => {
    await writeDispatcherMemory('topics/release.md', topic('Secret launch detail'), root);
    vi.setSystemTime(new Date(NOW.getTime() + DAY));
    const written = await writeDispatcherMemory('topics/release.md', topic('New launch detail'), root);
    const parsed = parseTopicPage(written.text)!;
    expect(parsed.created).toBe(NOW.toISOString());
    expect(parsed.updated).toBe(new Date(NOW.getTime() + DAY).toISOString());
    expect(parsed.headerLines).toContain('Owner: pm');
    await readDispatcherMemory('topics/release.md', root);
    const access = await readMemoryAccess(root);
    expect(access['topics/release.md']).toMatchObject({
      lastWriter: 'agent tool', reads: 1, writes: 2, lastRead: NOW.getTime() + DAY, lastWrite: NOW.getTime() + DAY,
    });
    expect(memoryAccessPath(root)).toBe(path.join(base, 'memory-access.json'));
    expect(fs.readFileSync(memoryAccessPath(root), 'utf8')).not.toMatch(/launch detail|Source:|Owner:/);
    expect(versions('topics/release.md').join('\n')).toContain('Secret launch detail');
  });

  it('cannot change a card, but can change Notes and caps the index', async () => {
    await writeAgentCard('lead', 'Owns work', root);
    await expect(writeDispatcherMemory('agents/lead.md', renderAgentPage('lead', { card: 'Imposter', notes: 'notes' }), root)).rejects.toThrow(/Card/);
    await writeDispatcherMemory('agents/lead.md', renderAgentPage('lead', { card: 'Owns work', notes: 'Useful notes' }), root);
    expect((await readDispatcherMemory('agents/lead.md', root)).text).toContain('Useful notes');
    const result = await writeDispatcherMemory('index.md', 'line\n'.repeat(10_000), root);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8 * 1024);
    await expect(writeDispatcherMemory('topics/bad.md', 'No headers', root)).rejects.toThrow(/Status and Source/);
  });

  it('keeps only five observed versions and expires them after 30 days, without searching or listing them', async () => {
    for (let i = 0; i < 8; i++) {
      vi.setSystemTime(new Date(NOW.getTime() + i * 1_000));
      await writeDispatcherMemory('topics/release.md', topic(`Version ${i}`), root);
    }
    expect(versions('topics/release.md')).toHaveLength(MEMORY_HISTORY_VERSIONS);
    expect(versions('topics/release.md')[0]).toContain('Version 3');
    expect(versions('topics/release.md')[4]).toContain('Version 7');
    expect((await readDispatcherMemory(undefined, root)).pages).toEqual(['topics/release.md']);
    expect((await listMemoryPages(root)).map((p) => p.page)).toEqual(['topics/release.md']);
    expect((await searchDispatcher('"Version 3"', { scope: 'memory', memoryRoot: root })).memory).toEqual([]);
    await expect(writeDispatcherMemory('history/topics/release.md/old.md', 'bad', root)).rejects.toThrow(/read only/);
    await pruneMemoryHistory(root, NOW.getTime() + 31 * DAY);
    expect(versions('topics/release.md')).toEqual([]);
  });

  it('attributes direct edits by timestamp and digest, saves the observed bytes and does not repeat attribution', async () => {
    await writeDispatcherMemory('topics/release.md', topic('Original'), root);
    const file = path.join(root, 'topics', 'release.md');
    const stat = fs.statSync(file);
    fs.writeFileSync(file, topic('Edited directly'));
    fs.utimesSync(file, stat.atime, stat.mtime);
    const report = await runMemoryUpkeep(NOW, { root });
    expect(report.directEdits).toEqual(['topics/release.md']);
    expect((await readMemoryAccess(root))['topics/release.md'].lastWriter).toBe('agent direct');
    expect(versions('topics/release.md').join('\n')).toContain('Original');
    expect(versions('topics/release.md').join('\n')).toContain('Edited directly');
    expect((await runMemoryUpkeep(NOW, { root })).directEdits).toEqual([]);
    await memoryWrite('topics/release.md', topic('Clubhouse update'), 'migration', root);
    expect((await runMemoryUpkeep(NOW, { root })).directEdits).toEqual([]);
  });

  it('bounds the access record and records reads without touching the memory page', async () => {
    const pages = Object.fromEntries(Array.from({ length: MAX_MEMORY_ACCESS_PAGES + 10 }, (_, i) =>
      [`topics/p${i}.md`, { reads: 0, writes: 1, lastWrite: i }]));
    fs.writeFileSync(memoryAccessPath(root), JSON.stringify({ version: 1, pages }));
    await recordMemoryRead('topics/new.md', root);
    const access = await readMemoryAccess(root);
    expect(Object.keys(access)).toHaveLength(MAX_MEMORY_ACCESS_PAGES);
    expect(access['topics/new.md'].reads).toBe(1);
    expect(access['topics/p0.md']).toBeUndefined();
    await writeDispatcherMemory('topics/read.md', topic('Read me'), root);
    const file = path.join(root, 'topics', 'read.md');
    const before = fs.statSync(file).mtimeMs;
    await readDispatcherMemory('topics/read.md', root);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    await searchDispatcher('"Read me"', { scope: 'memory', memoryRoot: root });
    expect((await readMemoryAccess(root))['topics/read.md'].reads).toBe(2);
  });

  it('reports old never-read pages, omits recent reads/writes, and keeps history with archived topics', async () => {
    fs.mkdirSync(path.join(root, 'topics'));
    for (const name of ['never-read', 'read-recently', 'written-recently', 'archive']) {
      const file = path.join(root, 'topics', `${name}.md`);
      fs.writeFileSync(file, `Status: ${name === 'archive' ? 'unconfirmed' : 'confirmed'}\nSource: lead\n\nOld facts`);
      const old = new Date(NOW.getTime() - 40 * DAY);
      fs.utimesSync(file, old, old);
    }
    await recordMemoryRead('topics/read-recently.md', root);
    await writeDispatcherMemory('topics/written-recently.md', topic('New facts'), root);
    const report = await runMemoryUpkeep(NOW, { root });
    expect(report.neglectedPages).toEqual(['topics/never-read.md']);
    expect(report.archived).toEqual(['topics/archive.md']);
    expect(versions('archive/topics/archive.md').join('\n')).toContain('Old facts');
    expect((await readMemoryAccess(root))['archive/topics/archive.md'].lastWriter).toBe('clubhouse:archive');
  });

  it('fails explicitly when access metadata cannot be read instead of silently losing attribution', async () => {
    fs.writeFileSync(memoryAccessPath(root), '{broken json');
    await expect(writeDispatcherMemory('topics/release.md', topic('Facts'), root)).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'topics', 'release.md'))).toBe(false);
    await expect(observeMemoryPage('index.md', root)).resolves.toBeUndefined();
  });
});
