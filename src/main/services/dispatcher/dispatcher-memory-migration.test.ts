import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../base-dir', () => ({ getBaseDirPath: () => '/nonexistent-base-dir' }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { MEMORY_INDEX_CAP_BYTES, parseTopicPage } from './dispatcher-memory';
import { MEMORY_INSTRUCTIONS_HEADING, listNotesArchives, migrateNotesToMemory, withMemoryIndex } from './dispatcher-memory-migration';

let base: string;
let notesDir: string;
let memoryRoot: string;
let archive: string;
const opts = () => ({ notesDir, memoryRoot });

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-migration-'));
  notesDir = path.join(base, 'notes');
  memoryRoot = path.join(base, 'memory');
  archive = path.join(base, 'notes-archive');
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): void {
  const file = path.join(notesDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Every file under `dir` with its bytes, keyed by relative path. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), rel);
      else out[rel] = fs.readFileSync(path.join(d, entry.name)).toString('base64');
    }
  };
  walk(dir, '');
  return out;
}

function seedNotes(): void {
  write('checkout.md', '# Checkout\n\nwebapp-lead owns it.\n');
  write('Release Plan.md', 'Tag 1.0 after checkout.\n');
  write('2026-11-07.md', '- 09:00 checkout fixed\n');
  write('audit-20261106.json', '{"ok":true}');
  write('design/00-proposal.md', '# Proposal\n');
  write('design/scripts/run.sh', 'echo hi\n');
  write('bundles/big.bundle', Buffer.from([0, 1, 2, 255]));
  write('.hidden/x', 'x');
  write('empty.md', '');
}

describe('migrateNotesToMemory', () => {
  it('sorts notes into topics and the timeline, and keeps every file byte for byte', async () => {
    seedNotes();
    const before = snapshot(notesDir);
    const result = await migrateNotesToMemory(opts());

    expect(result.migrated).toBe(true);
    expect(result.archive).toBe(archive);
    expect(fs.existsSync(notesDir)).toBe(false);
    // Lossless: the archive is the old folder exactly, and it sits outside memory.
    expect(snapshot(archive)).toEqual(before);
    expect(fs.existsSync(path.join(memoryRoot, 'archive'))).toBe(false);

    const checkout = parseTopicPage(fs.readFileSync(path.join(memoryRoot, 'topics', 'checkout.md'), 'utf-8'));
    expect(checkout).toMatchObject({ status: 'unconfirmed', body: '# Checkout\n\nwebapp-lead owns it.\n' });
    expect(checkout?.source).toContain('notes/checkout.md');
    expect(parseTopicPage(fs.readFileSync(path.join(memoryRoot, 'topics', 'release-plan.md'), 'utf-8'))?.body).toBe('Tag 1.0 after checkout.\n');
    expect(parseTopicPage(fs.readFileSync(path.join(memoryRoot, 'topics', 'empty.md'), 'utf-8'))?.body).toBe('');
    expect(fs.readFileSync(path.join(memoryRoot, 'timeline', '2026-11-07.md'), 'utf-8')).toBe('- 09:00 checkout fixed\n');

    const design = fs.readFileSync(path.join(memoryRoot, 'topics', 'design.md'), 'utf-8');
    expect(design).toContain('](../../notes-archive/design/00-proposal.md)');
    expect(design).toContain('](../../notes-archive/design/scripts/run.sh)');
    // The links resolve from the page to the archived files.
    expect(fs.existsSync(path.resolve(memoryRoot, 'topics', '../../notes-archive/design/scripts/run.sh'))).toBe(true);
    expect(fs.existsSync(path.join(memoryRoot, 'topics', 'hidden.md'))).toBe(false);

    const index = fs.readFileSync(path.join(memoryRoot, 'index.md'), 'utf-8');
    for (const page of result.pages) expect(index).toContain(`(${encodeURI(page.page)})`);
    expect(index).toContain('](../notes-archive/)');
  });

  it('is idempotent: a second run changes nothing', async () => {
    seedNotes();
    await migrateNotesToMemory(opts());
    const after = snapshot(memoryRoot);
    const again = await migrateNotesToMemory(opts());
    expect(again).toEqual({ migrated: false, pages: [], archive: null });
    expect(snapshot(memoryRoot)).toEqual(after);
  });

  it('a run that stopped before the move writes no page twice when it runs again', async () => {
    seedNotes();
    // The first run's pages, then a stop before the folder moved: copy the notes back.
    const before = snapshot(notesDir);
    await migrateNotesToMemory(opts());
    fs.renameSync(archive, notesDir);
    const pagesBefore = snapshot(path.join(memoryRoot, 'topics'));
    const timelineBefore = snapshot(path.join(memoryRoot, 'timeline'));
    const indexBefore = fs.readFileSync(path.join(memoryRoot, 'index.md'), 'utf-8');

    await migrateNotesToMemory(opts());
    expect(snapshot(path.join(memoryRoot, 'topics'))).toEqual(pagesBefore);
    expect(snapshot(path.join(memoryRoot, 'timeline'))).toEqual(timelineBefore);
    expect(fs.readFileSync(path.join(memoryRoot, 'index.md'), 'utf-8')).toBe(indexBefore);
    expect(snapshot(archive)).toEqual(before);
  });

  it('never overwrites a page already in memory: a clash gets the next free name', async () => {
    fs.mkdirSync(path.join(memoryRoot, 'topics'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'topics', 'checkout.md'), 'written by the agent');
    fs.mkdirSync(path.join(memoryRoot, 'timeline'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'timeline', '2026-11-07.md'), '# 2026-11-07\n\n- 08:00 earlier\n');
    write('checkout.md', 'from notes');
    write('2026-11-07.md', '- 09:00 from notes\n');
    await migrateNotesToMemory(opts());
    expect(fs.readFileSync(path.join(memoryRoot, 'topics', 'checkout.md'), 'utf-8')).toBe('written by the agent');
    expect(parseTopicPage(fs.readFileSync(path.join(memoryRoot, 'topics', 'checkout-2.md'), 'utf-8'))?.body).toBe('from notes');
    const day = fs.readFileSync(path.join(memoryRoot, 'timeline', '2026-11-07.md'), 'utf-8');
    expect(day).toContain('- 08:00 earlier');
    expect(day).toContain('- 09:00 from notes');
  });

  it('a notes folder that appears again later goes to a fresh archive folder', async () => {
    write('a.md', 'first');
    await migrateNotesToMemory(opts());
    write('a.md', 'first');
    write('b.md', 'second');
    const result = await migrateNotesToMemory(opts());
    expect(result.archive).toBe(`${archive}-2`);
    expect(fs.readFileSync(path.join(archive, 'a.md'), 'utf-8')).toBe('first');
    expect(fs.readFileSync(path.join(`${archive}-2`, 'b.md'), 'utf-8')).toBe('second');
    expect(await listNotesArchives(archive)).toEqual([archive, `${archive}-2`]);
    // The unchanged note isn't duplicated.
    expect(fs.existsSync(path.join(memoryRoot, 'topics', 'a-2.md'))).toBe(false);
    expect(fs.existsSync(path.join(memoryRoot, 'topics', 'b.md'))).toBe(true);
  });

  it('removes an empty notes folder without archiving it', async () => {
    fs.mkdirSync(notesDir, { recursive: true });
    expect(await migrateNotesToMemory(opts())).toEqual({ migrated: true, pages: [], archive: null });
    expect(fs.existsSync(notesDir)).toBe(false);
    expect(fs.existsSync(archive)).toBe(false);
    expect(await listNotesArchives(archive)).toEqual([]);
  });

  it('keeps the index under its cap with many notes, and still points to all of them', async () => {
    // Long names, so a few dozen pages overflow the index without a slow test.
    for (let i = 0; i < 60; i++) write(`note-${i}-${'x'.repeat(70)}.md`, `note ${i}`);
    const result = await migrateNotesToMemory(opts());
    expect(result.pages).toHaveLength(60);
    const index = fs.readFileSync(path.join(memoryRoot, 'index.md'), 'utf-8');
    expect(Buffer.byteLength(index, 'utf-8')).toBeLessThanOrEqual(MEMORY_INDEX_CAP_BYTES);
    expect(index).toMatch(/- \d+ more pages in `topics\/`/);
    expect(fs.readdirSync(path.join(memoryRoot, 'topics'))).toHaveLength(60);
  }, 30_000);
});

describe('withMemoryIndex', () => {
  it('migrates, then adds the capped index after the instructions', async () => {
    write('checkout.md', 'x');
    const out = await withMemoryIndex('# Instructions\n', opts());
    expect(out.startsWith('# Instructions\n\n')).toBe(true);
    // CRLF instructions, as a Windows checkout has them, are kept exactly.
    expect((await withMemoryIndex('# A\r\nb\r\n', opts())).startsWith('# A\r\nb\r\n\n## ')).toBe(true);
    expect(out).toContain(MEMORY_INSTRUCTIONS_HEADING);
    expect(out).toContain('(topics/checkout.md)');
    expect(fs.existsSync(notesDir)).toBe(false);
  });

  it('memory that survives a provider switch: the same files give the same index', async () => {
    const a = await withMemoryIndex('claude instructions', opts());
    const b = await withMemoryIndex('codex instructions', opts());
    expect(a.slice(a.indexOf(MEMORY_INSTRUCTIONS_HEADING))).toBe(b.slice(b.indexOf(MEMORY_INSTRUCTIONS_HEADING)));
  });

  it('falls back to the plain instructions when memory cannot be read', async () => {
    fs.writeFileSync(memoryRoot, 'a file where the folder should be');
    expect(await withMemoryIndex('plain', opts())).toBe('plain');
  });
});
