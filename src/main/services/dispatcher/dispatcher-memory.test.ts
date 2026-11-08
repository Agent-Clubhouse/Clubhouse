import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../base-dir', () => ({ getBaseDirPath: () => '/nonexistent-base-dir' }));

import {
  MEMORY_INDEX_CAP_BYTES,
  INDEX_CUT_NOTE,
  DEFAULT_INDEX,
  AGENT_NOTES_HEADING,
  AGENT_CARD_PLACEHOLDER,
  agentPageExists,
  agentPagePath,
  ensureAgentPage,
  moveAgentPage,
  readAgentCard,
  capIndex,
  ensureMemoryLayout,
  loadIndex,
  memorySlug,
  parseAgentPage,
  readAgentPage,
  readIndex,
  readTopic,
  setIndexSection,
  writeAgentCard,
  writeAgentNotes,
  writeIndex,
  writeTopic,
} from './dispatcher-memory';

let root: string;
const bytes = (s: string) => Buffer.byteLength(s, 'utf-8');

beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-memory-')), 'memory');
});
afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('layout', () => {
  it('creates the folders and a starting index, and leaves an existing index alone', async () => {
    await ensureMemoryLayout(root);
    for (const dir of ['agents', 'timeline', 'topics']) expect(fs.statSync(path.join(root, dir)).isDirectory()).toBe(true);
    expect(await readIndex(root)).toBe(DEFAULT_INDEX);
    fs.writeFileSync(path.join(root, 'index.md'), 'mine');
    await ensureMemoryLayout(root);
    expect(await readIndex(root)).toBe('mine');
  });

  it('survives a restart: everything is read back from disk with no state in memory', async () => {
    await writeIndex('Checkout is the priority.\n', root);
    await writeAgentCard('webapp-lead', 'Owns the web app.', root);
    await writeTopic('checkout', { status: 'confirmed', source: 'webapp-lead, 2026-11-07', body: '# Checkout\n\nFixed in #412.\n' }, root);
    vi.resetModules();
    const fresh = await import('./dispatcher-memory');
    expect(await fresh.loadIndex(root)).toBe('Checkout is the priority.\n');
    expect((await fresh.readAgentPage('webapp-lead', root))?.card).toBe('Owns the web app.');
    expect(await fresh.readTopic('checkout', root)).toEqual({ status: 'confirmed', source: 'webapp-lead, 2026-11-07', body: '# Checkout\n\nFixed in #412.\n' });
  });

  it('slugs names so a page never leaves its folder', () => {
    expect(memorySlug('Webapp Lead')).toBe('webapp-lead');
    expect(memorySlug('../../etc/passwd')).toBe('etc-passwd');
    expect(memorySlug('...')).toBe('untitled');
    expect(memorySlug('CON')).toBe('con-page');
    expect(memorySlug('café notes')).toBe('café-notes');
    expect(memorySlug('x'.repeat(200))).toHaveLength(80);
  });
});

describe('index cap', () => {
  it('leaves an index under the cap unchanged', () => {
    expect(capIndex('short\n')).toBe('short\n');
  });

  it('cuts at a line boundary, adds the note, and stays under the cap', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `- line ${i} with some words in it`);
    const out = capIndex(lines.join('\n'));
    expect(bytes(out)).toBeLessThanOrEqual(MEMORY_INDEX_CAP_BYTES);
    expect(out.endsWith(INDEX_CUT_NOTE)).toBe(true);
    const kept = out.slice(0, -INDEX_CUT_NOTE.length).split('\n');
    expect(kept.every((l, i) => l === lines[i])).toBe(true);
  });

  it('stays under the cap with one huge line and with multi-byte text', () => {
    expect(bytes(capIndex('x'.repeat(50_000)))).toBeLessThanOrEqual(MEMORY_INDEX_CAP_BYTES);
    const emoji = capIndex('🙂'.repeat(10_000));
    expect(bytes(emoji)).toBeLessThanOrEqual(MEMORY_INDEX_CAP_BYTES);
    expect(emoji).not.toContain('�');
  });

  it('is enforced on write and again on load, since the agent edits the file directly', async () => {
    const written = await writeIndex('y\n'.repeat(20_000), root);
    expect(bytes(written)).toBeLessThanOrEqual(MEMORY_INDEX_CAP_BYTES);
    expect(bytes(fs.readFileSync(path.join(root, 'index.md'), 'utf-8'))).toBeLessThanOrEqual(MEMORY_INDEX_CAP_BYTES);
    fs.writeFileSync(path.join(root, 'index.md'), 'z\n'.repeat(20_000));
    expect(bytes(await loadIndex(root))).toBeLessThanOrEqual(MEMORY_INDEX_CAP_BYTES);
  });

  it('a long list section keeps what fits, counts the rest, and replaces itself on a second run', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `- [note-${i}](topics/note-${i}.md)`);
    const overflow = (left: number) => `- ${left} more in topics/`;
    const first = await setIndexSection('Moved', lines, overflow, root);
    expect(bytes(first)).toBeLessThanOrEqual(MEMORY_INDEX_CAP_BYTES);
    expect(first).toContain(DEFAULT_INDEX.trim());
    const listed = first.split('\n').filter((l) => l.startsWith('- [note-')).length;
    expect(listed).toBeGreaterThan(0);
    expect(first).toContain(`- ${1000 - listed} more in topics/`);
    expect(first).not.toContain(INDEX_CUT_NOTE.trim());
    const second = await setIndexSection('Moved', lines, overflow, root);
    expect(second).toBe(first);
  });
});

describe('agent pages', () => {
  it('keeps one writer per section: the card and the notes never overwrite each other', async () => {
    await writeAgentCard('webapp-lead', 'Owns the web app.', root);
    await writeAgentNotes('webapp-lead', 'Fast on checkout fixes.', root);
    await writeAgentCard('webapp-lead', 'Owns the web app and its tests.', root);
    expect(await readAgentPage('webapp-lead', root)).toEqual({ card: 'Owns the web app and its tests.', notes: 'Fast on checkout fixes.' });
    await writeAgentNotes('webapp-lead', 'Now also on release.', root);
    expect((await readAgentPage('webapp-lead', root))?.card).toBe('Owns the web app and its tests.');
  });

  it('a card that contains the notes heading cannot take over the notes section', async () => {
    await writeAgentNotes('a', 'mine', root);
    await writeAgentCard('a', `card\n${AGENT_NOTES_HEADING}\nsneaky`, root);
    expect((await readAgentPage('a', root))?.notes).toBe('mine');
  });

  it('keeps hand-written text that sits above the card heading', () => {
    expect(parseAgentPage('# a\n\nwritten by hand\n\n## Card\n\nthe card\n\n## Notes\n\nn')).toEqual({ card: 'written by hand\n\n\nthe card', notes: 'n' });
    expect(parseAgentPage('just text')).toEqual({ card: 'just text', notes: '' });
  });

  it('returns null for an agent with no page', async () => {
    expect(await readAgentPage('nobody', root)).toBeNull();
  });
});

describe('topic pages', () => {
  it('round-trips status, source and body exactly', async () => {
    const body = 'Status: not a header\n\nbody kept as is';
    await writeTopic('Release 1.0', { status: 'unconfirmed', source: 'chat\nwith a newline', body }, root);
    expect(fs.existsSync(path.join(root, 'topics', 'release-1.0.md'))).toBe(true);
    expect(await readTopic('Release 1.0', root)).toEqual({ status: 'unconfirmed', source: 'chat with a newline', body });
  });
});

describe('agent pages for cards (#3041)', () => {
  it('gives an agent a placeholder card once, and never overwrites a page', async () => {
    await ensureAgentPage('lead', root);
    expect(await readAgentPage('lead', root)).toEqual({ card: AGENT_CARD_PLACEHOLDER, notes: '' });
    expect(await readAgentCard('lead', root)).toBeNull();
    await writeAgentCard('lead', 'What it\'s for: Leads.', root);
    await ensureAgentPage('lead', root);
    expect(await readAgentCard('lead', root)).toBe('What it\'s for: Leads.');
    expect(await agentPageExists('nobody', root)).toBe(false);
  });

  it('moves a page to a new name, keeping both sections', async () => {
    await writeAgentCard('lead (webapp)', 'card', root);
    await writeAgentNotes('lead (webapp)', 'notes', root);
    await moveAgentPage('lead (webapp)', 'web-lead (webapp)', root);
    expect(await readAgentPage('lead (webapp)', root)).toBeNull();
    expect(await readAgentPage('web-lead (webapp)', root)).toEqual({ card: 'card', notes: 'notes' });
    expect(fs.readFileSync(agentPagePath('web-lead (webapp)', root), 'utf-8').startsWith('# web-lead (webapp)\n')).toBe(true);
  });

  it('merges into a page that already has the new name: the moved card, and both sets of notes', async () => {
    await writeAgentCard('old', 'new card', root);
    await writeAgentNotes('old', 'old notes', root);
    await writeAgentCard('new', 'stale card', root);
    await writeAgentNotes('new', 'earlier notes', root);
    await moveAgentPage('old', 'new', root);
    expect(await readAgentPage('new', root)).toEqual({ card: 'new card', notes: 'earlier notes\n\nold notes' });
  });

  it('keeps the card and notes when card and notes are written at once', async () => {
    await Promise.all([writeAgentCard('lead', 'card', root), writeAgentNotes('lead', 'notes', root)]);
    expect(await readAgentPage('lead', root)).toEqual({ card: 'card', notes: 'notes' });
  });
});
