import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../experimental-settings', () => ({ getSettings: () => ({}), savedSettingsUnreadable: () => false }));

import type { OrchestratorProvider } from '../../orchestrators/types';
import type { DispatcherRole } from '../../../shared/dispatcher-behavior';
import { MANAGED_SKILLS_MANIFEST } from '../../../shared/skills-folder';
import {
  inspectInstructions, inspectMemoryAccess, inspectMemoryIndex, inspectMemoryPage, inspectSkill, inspectSkills,
  InspectorError, MAX_ACCESS_ENTRIES, MAX_INSTRUCTIONS_BYTES, MAX_MEMORY_PAGE_BYTES, type InspectorContext,
} from './dispatcher-inspector';
import { MAX_MEMORY_PAGE_CHARS } from './dispatcher-memory-reader';

/** Symlinks need Developer Mode or admin on Windows; skip those cases there. */
const canLink = process.platform !== 'win32';
const linkIt = canLink ? it : it.skip;

function provider(id: string, file: string, skillsRoot: string): OrchestratorProvider {
  return {
    id,
    instructionsPathOf: (dir: string) => path.join(dir, ...file.split('/')),
    conventions: { configDir: `.${id}`, skillsDir: 'skills', skillsRoot },
  } as unknown as OrchestratorProvider;
}

const PROVIDERS = [
  provider('claude-code', 'CLAUDE.md', '.claude/skills'),
  provider('codex-cli', 'AGENTS.md', '.agents/skills'),
  provider('copilot-cli', '.github/copilot-instructions.md', '.github/skills'),
];

let base: string;
let outside: string;
let ctx: InspectorContext;
let active: Record<DispatcherRole, string | null>;

function write(file: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const stat = fs.lstatSync(full);
      out.push(`${path.relative(dir, full)}:${stat.size}:${stat.mtimeMs}`);
      if (e.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) { return err instanceof InspectorError ? err.code : `other:${String(err)}`; }
  return 'resolved';
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-inspector-')));
  outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  write(path.join(outside, 'secret.md'), 'outside secret');
  active = { work: 'claude-code', chat: 'codex-cli' };
  ctx = {
    folders: { work: path.join(base, 'dispatcher'), chat: path.join(base, 'dispatcher-chat') },
    memoryRoot: path.join(base, 'dispatcher', 'memory'),
    providers: PROVIDERS,
    activeProvider: (role) => active[role],
  };
  fs.mkdirSync(ctx.folders.work);
  fs.mkdirSync(ctx.folders.chat);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('instructions', () => {
  it('lists every CLI for each role, with the active one marked and the rest inactive', async () => {
    write(path.join(ctx.folders.work, 'CLAUDE.md'), 'work on claude');
    write(path.join(ctx.folders.work, 'AGENTS.md'), 'old codex copy');
    write(path.join(ctx.folders.chat, 'AGENTS.md'), 'chat on codex');

    const result = await inspectInstructions(ctx);
    expect(result.active).toEqual({ work: 'claude-code', chat: 'codex-cli' });
    expect(result.files).toHaveLength(6);
    const work = result.files.filter((f) => f.role === 'work');
    expect(work.find((f) => f.provider === 'claude-code')).toMatchObject({ active: true, exists: true, content: 'work on claude', size: 14 });
    expect(work.find((f) => f.provider === 'codex-cli')).toMatchObject({ active: false, exists: true, content: 'old codex copy' });
    expect(work.find((f) => f.provider === 'claude-code')?.mtimeMs).toEqual(expect.any(Number));
    const chat = result.files.filter((f) => f.role === 'chat');
    expect(chat.find((f) => f.provider === 'codex-cli')).toMatchObject({ active: true, content: 'chat on codex' });
    expect(chat.find((f) => f.provider === 'claude-code')).toMatchObject({ active: false });
  });

  it('reports a missing file as not there, without content or error', async () => {
    const result = await inspectInstructions(ctx);
    const copilot = result.files.find((f) => f.role === 'work' && f.provider === 'copilot-cli');
    expect(copilot).toEqual({
      path: path.join(ctx.folders.work, '.github', 'copilot-instructions.md'), exists: false,
      role: 'work', provider: 'copilot-cli', active: false,
    });
  });

  it('marks every file inactive for a role whose agent does not exist yet', async () => {
    active.chat = null;
    const result = await inspectInstructions(ctx);
    expect(result.active.chat).toBeNull();
    expect(result.files.filter((f) => f.role === 'chat').every((f) => !f.active)).toBe(true);
  });

  it('cuts content at the cap and keeps the full size', async () => {
    write(path.join(ctx.folders.work, 'CLAUDE.md'), 'x'.repeat(MAX_INSTRUCTIONS_BYTES + 10));
    const file = (await inspectInstructions(ctx)).files.find((f) => f.role === 'work' && f.provider === 'claude-code')!;
    expect(file.truncated).toBe(true);
    expect(file.content).toHaveLength(MAX_INSTRUCTIONS_BYTES);
    expect(file.size).toBe(MAX_INSTRUCTIONS_BYTES + 10);
  });

  it('never cuts inside a character', async () => {
    write(path.join(ctx.folders.work, 'CLAUDE.md'), `${'x'.repeat(MAX_INSTRUCTIONS_BYTES - 1)}é`);
    const file = (await inspectInstructions(ctx)).files.find((f) => f.role === 'work' && f.provider === 'claude-code')!;
    expect(file.content).toBe('x'.repeat(MAX_INSTRUCTIONS_BYTES - 1));
  });

  linkIt('refuses a symlinked file and a symlinked folder on the way, without reading outside', async () => {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(ctx.folders.work, 'CLAUDE.md'));
    fs.symlinkSync(outside, path.join(ctx.folders.work, '.github'));
    const files = (await inspectInstructions(ctx)).files.filter((f) => f.role === 'work');
    expect(files.find((f) => f.provider === 'claude-code')).toMatchObject({ exists: true, error: 'link' });
    expect(files.find((f) => f.provider === 'copilot-cli')).toMatchObject({ exists: true, error: 'link' });
    expect(JSON.stringify(files)).not.toContain('outside secret');
  });

  it('refuses a folder in place of the file', async () => {
    fs.mkdirSync(path.join(ctx.folders.work, 'CLAUDE.md'));
    const file = (await inspectInstructions(ctx)).files.find((f) => f.role === 'work' && f.provider === 'claude-code')!;
    expect(file).toMatchObject({ exists: true, error: 'not_file' });
    expect(file.content).toBeUndefined();
  });
});

describe('skills', () => {
  it('lists the active CLI skills of each role without content, marking the managed ones', async () => {
    const workSkills = path.join(ctx.folders.work, '.claude', 'skills');
    write(path.join(workSkills, 'check-ins', 'SKILL.md'), 'check-ins text');
    write(path.join(workSkills, 'mine', 'SKILL.md'), 'mine');
    write(path.join(workSkills, MANAGED_SKILLS_MANIFEST), JSON.stringify({ skills: ['check-ins'] }));
    write(path.join(ctx.folders.work, '.agents', 'skills', 'inactive-cli', 'SKILL.md'), 'not listed');
    write(path.join(ctx.folders.chat, '.agents', 'skills', 'catching-up', 'SKILL.md'), 'chat skill');

    const { skills, truncated } = await inspectSkills(ctx);
    expect(truncated).toBeUndefined();
    expect(skills.map((s) => `${s.role}/${s.name}:${s.managed}`)).toEqual(['work/check-ins:true', 'work/mine:false', 'chat/catching-up:false']);
    expect(skills[0]).toMatchObject({ path: path.join(workSkills, 'check-ins', 'SKILL.md'), size: 14 });
    expect(JSON.stringify(skills)).not.toContain('check-ins text');
  });

  it('reads one skill on demand and refuses names that leave the folder', async () => {
    write(path.join(ctx.folders.work, '.claude', 'skills', 'check-ins', 'SKILL.md'), 'check-ins text');
    await expect(inspectSkill(ctx, 'work', 'check-ins')).resolves.toMatchObject({ content: 'check-ins text', exists: true });
    expect(await code(inspectSkill(ctx, 'work', '../../memory'))).toBe('invalid_request');
    expect(await code(inspectSkill(ctx, 'work', '..'))).toBe('invalid_request');
    expect(await code(inspectSkill(ctx, 'nobody' as DispatcherRole, 'check-ins'))).toBe('invalid_request');
    expect(await code(inspectSkill(ctx, 'work', 'absent'))).toBe('missing');
    active.chat = null;
    expect(await code(inspectSkill(ctx, 'chat', 'check-ins'))).toBe('no_agent');
  });

  linkIt('skips linked skill folders and refuses a linked SKILL.md', async () => {
    const root = path.join(ctx.folders.work, '.claude', 'skills');
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'linked-folder'));
    fs.mkdirSync(path.join(root, 'linked-file'));
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'linked-file', 'SKILL.md'));
    const { skills } = await inspectSkills(ctx);
    expect(skills.map((s) => s.name)).toEqual(['linked-file']);
    expect(skills[0].error).toBe('link');
    const linked = await inspectSkill(ctx, 'work', 'linked-file');
    expect(linked.error).toBe('link');
    expect(linked).not.toHaveProperty('content');
    const viaFolder = await inspectSkill(ctx, 'work', 'linked-folder');
    expect(viaFolder.error).toBe('link');
    expect(viaFolder).not.toHaveProperty('content');
  });

  linkIt('lists nothing when the skills folder itself is a link', async () => {
    fs.mkdirSync(path.join(ctx.folders.work, '.claude'));
    write(path.join(outside, 'evil', 'SKILL.md'), 'outside secret');
    fs.symlinkSync(outside, path.join(ctx.folders.work, '.claude', 'skills'));
    expect((await inspectSkills(ctx)).skills.filter((s) => s.role === 'work')).toEqual([]);
  });
});

describe('memory', () => {
  const topic = 'Status: confirmed\nSource: user\nCreated: 2026-11-01T10:00:00Z\nUpdated: 2026-11-20T09:30:00Z\n\nThe body.';

  beforeEach(() => {
    write(path.join(ctx.memoryRoot, 'index.md'), '# Index\n\nSee topics.');
    write(path.join(ctx.memoryRoot, 'topics', 'release.md'), topic);
    write(path.join(ctx.memoryRoot, 'agents', 'webapp.md'), 'agent page');
  });

  it('reads the index and pages with sizes, and writes nothing, not even an access record', async () => {
    const before = snapshot(base);
    const index = await inspectMemoryIndex(ctx);
    expect(index).toMatchObject({ exists: true, text: '# Index\n\nSee topics.' });
    expect(index.pages.map((p) => p.page)).toEqual(['agents/webapp.md', 'index.md', 'topics/release.md']);
    expect(index.pages[0]).toMatchObject({ size: 10, mtimeMs: expect.any(Number) });
    const page = await inspectMemoryPage(ctx, 'topics/release.md');
    expect(page).toMatchObject({ page: 'topics/release.md', text: topic, created: '2026-11-01T10:00:00Z', updated: '2026-11-20T09:30:00Z' });
    await inspectMemoryPage(ctx, 'agents/webapp.md');
    expect(snapshot(base)).toEqual(before);
    expect(fs.existsSync(path.join(ctx.folders.work, 'memory-access.json'))).toBe(false);
  });

  it('has no Created/Updated outside topics and reports a missing page and no memory', async () => {
    const page = await inspectMemoryPage(ctx, 'agents/webapp.md');
    expect(page.created).toBeUndefined();
    expect(await code(inspectMemoryPage(ctx, 'topics/none.md'))).toBe('missing');
    fs.rmSync(ctx.memoryRoot, { recursive: true });
    await expect(inspectMemoryIndex(ctx)).resolves.toEqual({ exists: false, text: '', pages: [] });
    expect(await code(inspectMemoryPage(ctx, 'index.md'))).toBe('missing');
  });

  it('keeps the reader caps: 64,000 chars a page and refuses huge pages before reading them', async () => {
    write(path.join(ctx.memoryRoot, 'topics', 'long.md'), 'y'.repeat(MAX_MEMORY_PAGE_CHARS + 50));
    const page = await inspectMemoryPage(ctx, 'topics/long.md');
    expect(page.truncated).toBe(true);
    expect(page.text).toHaveLength(MAX_MEMORY_PAGE_CHARS);
    write(path.join(ctx.memoryRoot, 'topics', 'huge.md'), Buffer.alloc(MAX_MEMORY_PAGE_BYTES + 1, 'z'));
    expect(await code(inspectMemoryPage(ctx, 'topics/huge.md'))).toBe('too_large');
  });

  it('refuses paths out of memory', async () => {
    expect(await code(inspectMemoryPage(ctx, '../CLAUDE.md'))).toBe('invalid_request');
    expect(await code(inspectMemoryPage(ctx, path.join(outside, 'secret.md')))).toBe('invalid_request');
    expect(await code(inspectMemoryPage(ctx, 'topics/release.txt'))).toBe('invalid_request');
    expect(await code(inspectMemoryPage(ctx, ''))).toBe('invalid_request');
    expect(await code(inspectMemoryPage(ctx, 42 as unknown as string))).toBe('invalid_request');
  });

  linkIt('refuses linked pages, a linked page folder, a linked index and a linked memory folder', async () => {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(ctx.memoryRoot, 'topics', 'leak.md'));
    expect(await code(inspectMemoryPage(ctx, 'topics/leak.md'))).toBe('link');
    fs.symlinkSync(outside, path.join(ctx.memoryRoot, 'outside'));
    expect(await code(inspectMemoryPage(ctx, 'outside/secret.md'))).toBe('link');
    expect((await inspectMemoryIndex(ctx)).pages.map((p) => p.page)).not.toContain('topics/leak.md');

    fs.rmSync(path.join(ctx.memoryRoot, 'index.md'));
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(ctx.memoryRoot, 'index.md'));
    expect(await code(inspectMemoryIndex(ctx))).toBe('link');

    fs.rmSync(ctx.memoryRoot, { recursive: true });
    fs.symlinkSync(outside, ctx.memoryRoot);
    expect(await code(inspectMemoryIndex(ctx))).toBe('link');
    expect(await code(inspectMemoryPage(ctx, 'secret.md'))).toBe('link');
  });
});

describe('memory access record', () => {
  const recordFile = () => path.join(ctx.folders.work, 'memory-access.json');

  it('returns entries most recent first, without file stamps, and none when there is no record', async () => {
    await expect(inspectMemoryAccess(ctx)).resolves.toEqual({ entries: [], total: 0 });
    write(recordFile(), JSON.stringify({ version: 1, pages: {
      'index.md': { reads: 3, writes: 0, lastRead: 100 },
      'topics/a.md': { reads: 1, writes: 2, lastRead: 50, lastWrite: 300, lastWriter: 'agent direct',
        observed: { mtimeMs: 1, hash: 'a'.repeat(64) } },
      'agents/b.md': { reads: 0, writes: 0 },
    } }));
    const access = await inspectMemoryAccess(ctx);
    expect(access.total).toBe(3);
    expect(access.entries.map((e) => e.page)).toEqual(['topics/a.md', 'index.md', 'agents/b.md']);
    expect(access.entries[0]).toEqual({ page: 'topics/a.md', reads: 1, writes: 2, lastRead: 50, lastWrite: 300, lastWriter: 'agent direct' });
  });

  it('bounds the entries returned', async () => {
    const pages = Object.fromEntries(Array.from({ length: MAX_ACCESS_ENTRIES + 5 }, (_, i) => [`topics/p${i}.md`, { reads: 1, writes: 0, lastRead: i }]));
    write(recordFile(), JSON.stringify({ version: 1, pages }));
    const access = await inspectMemoryAccess(ctx);
    expect(access.entries).toHaveLength(MAX_ACCESS_ENTRIES);
    expect(access).toMatchObject({ total: MAX_ACCESS_ENTRIES + 5, truncated: true });
    expect(access.entries[0].page).toBe(`topics/p${MAX_ACCESS_ENTRIES + 4}.md`);
  });

  it('reports an invalid record by code', async () => {
    write(recordFile(), '{ nope');
    await expect(inspectMemoryAccess(ctx)).resolves.toEqual({ entries: [], total: 0, error: 'invalid' });
  });

  linkIt('refuses a linked record', async () => {
    write(path.join(outside, 'access.json'), JSON.stringify({ version: 1, pages: { 'x.md': { reads: 1, writes: 0 } } }));
    fs.symlinkSync(path.join(outside, 'access.json'), recordFile());
    await expect(inspectMemoryAccess(ctx)).resolves.toEqual({ entries: [], total: 0, error: 'link' });
  });
});
