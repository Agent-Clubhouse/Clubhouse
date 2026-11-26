import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../experimental-settings', () => ({ getSettings: () => ({}), savedSettingsUnreadable: () => false }));

import type { OrchestratorProvider } from '../../orchestrators/types';
import type { DispatcherRole } from '../../../shared/dispatcher-behavior';
import type { InspectorRoleSession } from '../../../shared/dispatcher-inspector';
import { MANAGED_SKILLS_MANIFEST } from '../../../shared/skills-folder';
import {
  _setBeforeOpenHookForTesting, inspectInstructions, inspectMemoryAccess, inspectMemoryIndex, inspectMemoryPage,
  inspectSkill, inspectSkills, InspectorError, MAX_ACCESS_ENTRIES, MAX_INSTRUCTIONS_BYTES, MAX_MEMORY_PAGE_BYTES,
  MAX_SKILLS_LISTED, type InspectorContext,
} from './dispatcher-inspector';
import { MAX_MEMORY_PAGE_CHARS, readDispatcherMemory } from './dispatcher-memory-reader';
import { readMemoryAccess } from './dispatcher-memory';

/** File symlinks need Developer Mode or admin on Windows; those cases are skipped there. */
const fileLinkIt = process.platform === 'win32' ? it.skip : it;
/** chmod doesn't deny reads on Windows, and root ignores it. */
const permsIt = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;

/** A folder link: a junction on Windows (no admin needed), a symlink elsewhere. */
function linkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, 'junction');
}

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
let roles: Record<DispatcherRole, InspectorRoleSession>;

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

const workFile = (result: Awaited<ReturnType<typeof inspectInstructions>>, id: string) =>
  result.files.find((f) => f.role === 'work' && f.provider === id)!;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-inspector-')));
  outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  write(path.join(outside, 'secret.md'), 'outside secret');
  roles = {
    work: { saved: 'claude-code', running: null, startedAt: null },
    chat: { saved: 'codex-cli', running: null, startedAt: null },
  };
  ctx = {
    folders: { work: path.join(base, 'dispatcher'), chat: path.join(base, 'dispatcher-chat') },
    memoryRoot: path.join(base, 'dispatcher', 'memory'),
    providers: PROVIDERS,
    session: (role) => roles[role],
  };
  fs.mkdirSync(ctx.folders.work);
  fs.mkdirSync(ctx.folders.chat);
});

afterEach(() => {
  _setBeforeOpenHookForTesting(null);
  fs.rmSync(base, { recursive: true, force: true });
});

describe('instructions', () => {
  it('lists every CLI for each role, with the saved one active while nothing runs and the rest inactive', async () => {
    write(path.join(ctx.folders.work, 'CLAUDE.md'), 'work on claude');
    write(path.join(ctx.folders.work, 'AGENTS.md'), 'old codex copy');
    write(path.join(ctx.folders.chat, 'AGENTS.md'), 'chat on codex');

    const result = await inspectInstructions(ctx);
    expect(result.sessions).toEqual(roles);
    expect(result.files).toHaveLength(6);
    expect(workFile(result, 'claude-code')).toMatchObject({ active: true, saved: true, running: false, exists: true, content: 'work on claude', size: 14 });
    expect(workFile(result, 'claude-code').mtimeMs).toEqual(expect.any(Number));
    expect(workFile(result, 'codex-cli')).toMatchObject({ active: false, saved: false, running: false, exists: true, content: 'old codex copy' });
    const chat = result.files.filter((f) => f.role === 'chat');
    expect(chat.find((f) => f.provider === 'codex-cli')).toMatchObject({ active: true, content: 'chat on codex' });
    expect(chat.find((f) => f.provider === 'claude-code')).toMatchObject({ active: false });
  });

  it('marks the running CLI active during a pending switch, and the saved one as saved', async () => {
    roles.work = { saved: 'claude-code', running: 'codex-cli', startedAt: 1234 };
    const result = await inspectInstructions(ctx);
    expect(result.sessions.work).toEqual({ saved: 'claude-code', running: 'codex-cli', startedAt: 1234 });
    expect(workFile(result, 'codex-cli')).toMatchObject({ active: true, running: true, saved: false });
    expect(workFile(result, 'claude-code')).toMatchObject({ active: false, running: false, saved: true });
  });

  it('reports a missing file as not there, without content or error', async () => {
    expect(workFile(await inspectInstructions(ctx), 'copilot-cli')).toEqual({
      path: path.join(ctx.folders.work, '.github', 'copilot-instructions.md'), exists: false,
      role: 'work', provider: 'copilot-cli', active: false, saved: false, running: false,
    });
  });

  it('marks every file inactive for a role whose agent does not exist yet', async () => {
    roles.chat = { saved: null, running: null, startedAt: null };
    const result = await inspectInstructions(ctx);
    expect(result.files.filter((f) => f.role === 'chat').every((f) => !f.active && !f.saved && !f.running)).toBe(true);
  });

  it('shows a CLI whose path is outside the folder as unavailable, and still loads the rest', async () => {
    write(path.join(ctx.folders.work, 'CLAUDE.md'), 'work on claude');
    const stray = { ...PROVIDERS[1], id: 'stray', instructionsPathOf: () => path.join(outside, 'secret.md') } as unknown as OrchestratorProvider;
    const throwing = { ...PROVIDERS[1], id: 'throwing', instructionsPathOf: () => { throw new Error('no'); } } as unknown as OrchestratorProvider;
    const result = await inspectInstructions({ ...ctx, providers: [...PROVIDERS, stray, throwing] });
    expect(workFile(result, 'stray')).toMatchObject({ exists: false, error: 'outside' });
    expect(workFile(result, 'stray')).not.toHaveProperty('content');
    expect(workFile(result, 'throwing')).toMatchObject({ exists: false, error: 'unreadable' });
    expect(workFile(result, 'claude-code')).toMatchObject({ content: 'work on claude' });
  });

  it('cuts content at the cap and keeps the full size', async () => {
    write(path.join(ctx.folders.work, 'CLAUDE.md'), 'x'.repeat(MAX_INSTRUCTIONS_BYTES + 10));
    const file = workFile(await inspectInstructions(ctx), 'claude-code');
    expect(file.truncated).toBe(true);
    expect(file.content).toHaveLength(MAX_INSTRUCTIONS_BYTES);
    expect(file.size).toBe(MAX_INSTRUCTIONS_BYTES + 10);
  });

  it('never cuts inside a character', async () => {
    write(path.join(ctx.folders.work, 'CLAUDE.md'), `${'x'.repeat(MAX_INSTRUCTIONS_BYTES - 1)}é`);
    expect(workFile(await inspectInstructions(ctx), 'claude-code').content).toBe('x'.repeat(MAX_INSTRUCTIONS_BYTES - 1));
  });

  it('refuses a file replaced by another between the check and the open (changed)', async () => {
    const file = path.join(ctx.folders.work, 'CLAUDE.md');
    write(file, 'checked');
    _setBeforeOpenHookForTesting((real) => {
      write(`${real}.new`, 'swapped in');
      fs.renameSync(`${real}.new`, real);
    });
    const result = workFile(await inspectInstructions(ctx), 'claude-code');
    expect(result).toMatchObject({ exists: true, error: 'changed' });
    expect(result).not.toHaveProperty('content');
  });

  it('never reads past the cap when the file grows after the check', async () => {
    const file = path.join(ctx.folders.work, 'CLAUDE.md');
    write(file, 'small');
    _setBeforeOpenHookForTesting((real) => { fs.appendFileSync(real, 'g'.repeat(MAX_INSTRUCTIONS_BYTES * 2)); });
    const result = workFile(await inspectInstructions(ctx), 'claude-code');
    expect(result.truncated).toBe(true);
    expect(result.content).toHaveLength(MAX_INSTRUCTIONS_BYTES);
  });

  fileLinkIt('refuses a symlink swapped in after the check', async () => {
    write(path.join(ctx.folders.work, 'CLAUDE.md'), 'checked');
    _setBeforeOpenHookForTesting((real) => {
      fs.rmSync(real);
      fs.symlinkSync(path.join(outside, 'secret.md'), real);
    });
    const result = workFile(await inspectInstructions(ctx), 'claude-code');
    expect(result.error).toBe('link');
    expect(JSON.stringify(result)).not.toContain('outside secret');
  });

  it('refuses a hard link to a file outside', async () => {
    fs.linkSync(path.join(outside, 'secret.md'), path.join(ctx.folders.work, 'CLAUDE.md'));
    const result = workFile(await inspectInstructions(ctx), 'claude-code');
    expect(result).toMatchObject({ exists: true, error: 'hard_link' });
    expect(JSON.stringify(result)).not.toContain('outside secret');
  });

  fileLinkIt('refuses a symlinked file', async () => {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(ctx.folders.work, 'CLAUDE.md'));
    const result = workFile(await inspectInstructions(ctx), 'claude-code');
    expect(result).toMatchObject({ exists: true, error: 'link' });
    expect(JSON.stringify(result)).not.toContain('outside secret');
  });

  it('refuses a linked folder on the way (junction on Windows)', async () => {
    write(path.join(outside, 'copilot-instructions.md'), 'outside secret');
    linkDir(outside, path.join(ctx.folders.work, '.github'));
    const result = workFile(await inspectInstructions(ctx), 'copilot-cli');
    expect(result).toMatchObject({ exists: true, error: 'link' });
    expect(JSON.stringify(result)).not.toContain('outside secret');
  });

  it('refuses a folder in place of the file', async () => {
    fs.mkdirSync(path.join(ctx.folders.work, 'CLAUDE.md'));
    const file = workFile(await inspectInstructions(ctx), 'claude-code');
    expect(file).toMatchObject({ exists: true, error: 'not_file' });
    expect(file.content).toBeUndefined();
  });
});

describe('skills', () => {
  const workSkills = () => path.join(ctx.folders.work, '.claude', 'skills');

  it('lists the active CLI skills of each role without content, marking the managed ones', async () => {
    write(path.join(workSkills(), 'check-ins', 'SKILL.md'), 'check-ins text');
    write(path.join(workSkills(), 'mine', 'SKILL.md'), 'mine');
    write(path.join(workSkills(), MANAGED_SKILLS_MANIFEST), JSON.stringify({ skills: ['check-ins'] }));
    write(path.join(ctx.folders.work, '.agents', 'skills', 'inactive-cli', 'SKILL.md'), 'not listed');
    write(path.join(ctx.folders.chat, '.agents', 'skills', 'catching-up', 'SKILL.md'), 'chat skill');

    const result = await inspectSkills(ctx);
    expect(result).not.toHaveProperty('truncated');
    expect(result).not.toHaveProperty('errors');
    expect(result.skills.map((s) => `${s.role}/${s.name}:${s.managed}`)).toEqual(['work/check-ins:true', 'work/mine:false', 'chat/catching-up:false']);
    expect(result.skills[0]).toMatchObject({ path: path.join(workSkills(), 'check-ins', 'SKILL.md'), size: 14 });
    expect(JSON.stringify(result)).not.toContain('check-ins text');
  });

  it('uses the running CLI skills folder during a pending switch', async () => {
    write(path.join(ctx.folders.work, '.agents', 'skills', 'running-cli', 'SKILL.md'), 'x');
    write(path.join(workSkills(), 'saved-cli', 'SKILL.md'), 'x');
    roles.work = { saved: 'claude-code', running: 'codex-cli', startedAt: 1 };
    expect((await inspectSkills(ctx)).skills.map((s) => s.name)).toEqual(['running-cli']);
  });

  it(`lists at most ${MAX_SKILLS_LISTED} folders and says so`, async () => {
    for (let i = 0; i <= MAX_SKILLS_LISTED; i++) write(path.join(workSkills(), `s${String(i).padStart(3, '0')}`, 'SKILL.md'), 'x');
    const result = await inspectSkills(ctx);
    expect(result.skills).toHaveLength(MAX_SKILLS_LISTED);
    expect(result.truncated).toBe(true);
  });

  it('treats an invalid manifest as naming no skills', async () => {
    write(path.join(workSkills(), 'check-ins', 'SKILL.md'), 'x');
    write(path.join(workSkills(), MANAGED_SKILLS_MANIFEST), '{ not json');
    expect((await inspectSkills(ctx)).skills).toEqual([expect.objectContaining({ name: 'check-ins', managed: false })]);
  });

  permsIt('lists the other role when one skills folder cannot be read', async () => {
    write(path.join(workSkills(), 'check-ins', 'SKILL.md'), 'x');
    write(path.join(ctx.folders.chat, '.agents', 'skills', 'catching-up', 'SKILL.md'), 'x');
    fs.chmodSync(workSkills(), 0o000);
    try {
      const result = await inspectSkills(ctx);
      expect(result.errors).toEqual({ work: 'unreadable' });
      expect(result.skills.map((s) => `${s.role}/${s.name}`)).toEqual(['chat/catching-up']);
    } finally {
      fs.chmodSync(workSkills(), 0o755);
    }
  });

  it('reads one skill on demand and refuses names that leave the folder', async () => {
    write(path.join(workSkills(), 'check-ins', 'SKILL.md'), 'check-ins text');
    await expect(inspectSkill(ctx, 'work', 'check-ins')).resolves.toMatchObject({ content: 'check-ins text', exists: true });
    expect(await code(inspectSkill(ctx, 'work', '../../memory'))).toBe('invalid_request');
    expect(await code(inspectSkill(ctx, 'work', '..'))).toBe('invalid_request');
    expect(await code(inspectSkill(ctx, 'nobody' as DispatcherRole, 'check-ins'))).toBe('invalid_request');
    expect(await code(inspectSkill(ctx, 'work', 'absent'))).toBe('missing');
    roles.chat = { saved: null, running: null, startedAt: null };
    expect(await code(inspectSkill(ctx, 'chat', 'check-ins'))).toBe('no_agent');
  });

  it('drops linked skill folders from the list and refuses reading through one (junction on Windows)', async () => {
    fs.mkdirSync(workSkills(), { recursive: true });
    write(path.join(outside, 'evil', 'SKILL.md'), 'outside secret');
    linkDir(path.join(outside, 'evil'), path.join(workSkills(), 'linked-folder'));
    write(path.join(workSkills(), 'real', 'SKILL.md'), 'x');
    expect((await inspectSkills(ctx)).skills.map((s) => s.name)).toEqual(['real']);
    const viaFolder = await inspectSkill(ctx, 'work', 'linked-folder');
    expect(viaFolder.error).toBe('link');
    expect(viaFolder).not.toHaveProperty('content');
  });

  fileLinkIt('drops a linked SKILL.md from the list and refuses reading it', async () => {
    write(path.join(workSkills(), 'linked-file', '.keep'), '');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(workSkills(), 'linked-file', 'SKILL.md'));
    expect((await inspectSkills(ctx)).skills).toEqual([]);
    const linked = await inspectSkill(ctx, 'work', 'linked-file');
    expect(linked.error).toBe('link');
    expect(linked).not.toHaveProperty('content');
  });

  it('refuses a hard-linked SKILL.md', async () => {
    fs.mkdirSync(path.join(workSkills(), 'hard'), { recursive: true });
    fs.linkSync(path.join(outside, 'secret.md'), path.join(workSkills(), 'hard', 'SKILL.md'));
    expect((await inspectSkills(ctx)).skills).toEqual([expect.objectContaining({ name: 'hard', error: 'hard_link' })]);
    const read = await inspectSkill(ctx, 'work', 'hard');
    expect(read.error).toBe('hard_link');
    expect(read).not.toHaveProperty('content');
  });

  it('lists nothing for a role whose skills folder itself is a link (junction on Windows)', async () => {
    fs.mkdirSync(path.join(ctx.folders.work, '.claude'));
    write(path.join(outside, 'evil', 'SKILL.md'), 'outside secret');
    linkDir(outside, workSkills());
    write(path.join(ctx.folders.chat, '.agents', 'skills', 'catching-up', 'SKILL.md'), 'x');
    const result = await inspectSkills(ctx);
    expect(result.errors).toEqual({ work: 'link' });
    expect(result.skills.map((s) => s.role)).toEqual(['chat']);
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
    expect(index).toMatchObject({ exists: true, indexExists: true, text: '# Index\n\nSee topics.' });
    expect(index.pages.map((p) => p.page)).toEqual(['agents/webapp.md', 'index.md', 'topics/release.md']);
    expect(index.pages[0]).toMatchObject({ size: 10, mtimeMs: expect.any(Number) });
    const page = await inspectMemoryPage(ctx, 'topics/release.md');
    expect(page).toMatchObject({ page: 'topics/release.md', text: topic, created: '2026-11-01T10:00:00Z', updated: '2026-11-20T09:30:00Z' });
    await inspectMemoryPage(ctx, 'agents/webapp.md');
    expect(snapshot(base)).toEqual(before);
    expect(fs.existsSync(path.join(ctx.folders.work, 'memory-access.json'))).toBe(false);
  });

  it("leaves the Dispatcher's own reads recording access, index and pages alike", async () => {
    await readDispatcherMemory(undefined, ctx.memoryRoot);
    await readDispatcherMemory('topics/release.md', ctx.memoryRoot);
    const access = await readMemoryAccess(ctx.memoryRoot);
    expect(access['index.md']).toMatchObject({ reads: 1, lastRead: expect.any(Number) });
    expect(access['topics/release.md']).toMatchObject({ reads: 1 });
  });

  it('has no Created/Updated outside topics and reports a missing page, index and memory', async () => {
    expect((await inspectMemoryPage(ctx, 'agents/webapp.md')).created).toBeUndefined();
    expect(await code(inspectMemoryPage(ctx, 'topics/none.md'))).toBe('missing');
    fs.rmSync(path.join(ctx.memoryRoot, 'index.md'));
    await expect(inspectMemoryIndex(ctx)).resolves.toMatchObject({ exists: true, indexExists: false, text: '' });
    fs.rmSync(ctx.memoryRoot, { recursive: true });
    await expect(inspectMemoryIndex(ctx)).resolves.toEqual({ exists: false, indexExists: false, text: '', pages: [] });
    expect(await code(inspectMemoryPage(ctx, 'index.md'))).toBe('missing');
  });

  it('keeps the reader caps: 64,000 chars a page and the 8 KB index cap, reading no more than the byte cap', async () => {
    write(path.join(ctx.memoryRoot, 'topics', 'long.md'), 'y'.repeat(MAX_MEMORY_PAGE_BYTES * 3));
    const page = await inspectMemoryPage(ctx, 'topics/long.md');
    expect(page.truncated).toBe(true);
    expect(page.text).toHaveLength(MAX_MEMORY_PAGE_CHARS);
    expect(page.size).toBe(MAX_MEMORY_PAGE_BYTES * 3);
    write(path.join(ctx.memoryRoot, 'index.md'), `${'line\n'.repeat(5000)}`);
    const index = await inspectMemoryIndex(ctx);
    expect(Buffer.byteLength(index.text)).toBeLessThan(9 * 1024);
    expect(index.text).toContain('The index was cut at its size limit');
  });

  it('cuts a page that grows after the check at the cap', async () => {
    _setBeforeOpenHookForTesting((real) => { if (real.endsWith('release.md')) fs.appendFileSync(real, 'z'.repeat(MAX_MEMORY_PAGE_BYTES * 2)); });
    const page = await inspectMemoryPage(ctx, 'topics/release.md');
    expect(page.truncated).toBe(true);
    expect(page.text).toHaveLength(MAX_MEMORY_PAGE_CHARS);
  });

  it('refuses a page replaced between the check and the open (changed)', async () => {
    _setBeforeOpenHookForTesting((real) => {
      write(`${real}.new`, 'swapped in');
      fs.renameSync(`${real}.new`, real);
    });
    expect(await code(inspectMemoryPage(ctx, 'topics/release.md'))).toBe('changed');
    expect(await code(inspectMemoryIndex(ctx))).toBe('changed');
  });

  fileLinkIt('refuses a symlink swapped in after the check', async () => {
    _setBeforeOpenHookForTesting((real) => {
      fs.rmSync(real);
      fs.symlinkSync(path.join(outside, 'secret.md'), real);
    });
    expect(await code(inspectMemoryPage(ctx, 'topics/release.md'))).toBe('link');
  });

  it('refuses a hard-linked page', async () => {
    fs.linkSync(path.join(outside, 'secret.md'), path.join(ctx.memoryRoot, 'topics', 'hard.md'));
    expect(await code(inspectMemoryPage(ctx, 'topics/hard.md'))).toBe('hard_link');
  });

  it('refuses paths out of memory', async () => {
    expect(await code(inspectMemoryPage(ctx, '../CLAUDE.md'))).toBe('invalid_request');
    expect(await code(inspectMemoryPage(ctx, path.join(outside, 'secret.md')))).toBe('invalid_request');
    expect(await code(inspectMemoryPage(ctx, 'topics/release.txt'))).toBe('invalid_request');
    expect(await code(inspectMemoryPage(ctx, ''))).toBe('invalid_request');
    expect(await code(inspectMemoryPage(ctx, 42 as unknown as string))).toBe('invalid_request');
  });

  it('refuses a linked page folder and a linked memory folder (junctions on Windows)', async () => {
    linkDir(outside, path.join(ctx.memoryRoot, 'outside'));
    expect(await code(inspectMemoryPage(ctx, 'outside/secret.md'))).toBe('link');
    expect((await inspectMemoryIndex(ctx)).pages.map((p) => p.page)).not.toContain('outside/secret.md');
    fs.rmSync(ctx.memoryRoot, { recursive: true });
    linkDir(outside, ctx.memoryRoot);
    expect(await code(inspectMemoryIndex(ctx))).toBe('link');
    expect(await code(inspectMemoryPage(ctx, 'secret.md'))).toBe('link');
  });

  fileLinkIt('refuses linked pages and a linked index', async () => {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(ctx.memoryRoot, 'topics', 'leak.md'));
    expect(await code(inspectMemoryPage(ctx, 'topics/leak.md'))).toBe('link');
    expect((await inspectMemoryIndex(ctx)).pages.map((p) => p.page)).not.toContain('topics/leak.md');
    fs.rmSync(path.join(ctx.memoryRoot, 'index.md'));
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(ctx.memoryRoot, 'index.md'));
    expect(await code(inspectMemoryIndex(ctx))).toBe('link');
  });
});

describe('memory access record', () => {
  const recordFile = () => path.join(ctx.folders.work, 'memory-access.json');

  it('returns entries most recent first with each role session, without file stamps, and none when there is no record', async () => {
    roles.work = { saved: 'claude-code', running: 'claude-code', startedAt: 75 };
    await expect(inspectMemoryAccess(ctx)).resolves.toEqual({ sessions: roles, entries: [], total: 0 });
    write(recordFile(), JSON.stringify({ version: 1, pages: {
      'index.md': { reads: 3, writes: 0, lastRead: 100 },
      'topics/a.md': { reads: 1, writes: 2, lastRead: 50, lastWrite: 300, lastWriter: 'agent direct',
        observed: { mtimeMs: 1, hash: 'a'.repeat(64) } },
      'agents/b.md': { reads: 0, writes: 0 },
    } }));
    const access = await inspectMemoryAccess(ctx);
    expect(access.sessions.work.startedAt).toBe(75);
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
    await expect(inspectMemoryAccess(ctx)).resolves.toMatchObject({ entries: [], total: 0, error: 'invalid' });
  });

  it('refuses a hard-linked record', async () => {
    write(path.join(outside, 'access.json'), JSON.stringify({ version: 1, pages: { 'x.md': { reads: 1, writes: 0 } } }));
    fs.linkSync(path.join(outside, 'access.json'), recordFile());
    await expect(inspectMemoryAccess(ctx)).resolves.toMatchObject({ entries: [], total: 0, error: 'hard_link' });
  });

  fileLinkIt('refuses a linked record', async () => {
    write(path.join(outside, 'access.json'), JSON.stringify({ version: 1, pages: { 'x.md': { reads: 1, writes: 0 } } }));
    fs.symlinkSync(path.join(outside, 'access.json'), recordFile());
    await expect(inspectMemoryAccess(ctx)).resolves.toMatchObject({ entries: [], total: 0, error: 'link' });
  });
});
