import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-files-'));
const project = path.join(tmpRoot, 'project');
const worktree = path.join(project, '.clubhouse', 'agents', 'a1');
const outside = path.join(tmpRoot, 'outside');

const sessionOutput = path.join(tmpRoot, 'copilot', 'session-state', 'sess-1');

const live = vi.hoisted(() => ({ agents: new Map<string, { projectPath: string; cwd?: string }>(), outputDirs: new Map<string, string>() }));
vi.mock('electron', () => ({ app: { getPath: () => path.join(tmpRoot, 'userData') } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-registry', () => ({ agentRegistry: { get: (id: string) => live.agents.get(id) } }));
vi.mock('./index', () => ({ getAgentRuntime: (id: string) => (live.outputDirs.has(id) ? { getSessionOutputDir: () => live.outputDirs.get(id) } : undefined) }));
vi.mock('../project-store', () => ({ list: async () => [{ id: 'p1', path: project }] }));
vi.mock('../agent-config', () => ({
  getDurableConfig: async (_projectPath: string, agentId: string) => (
    agentId === 'sleeping' ? { id: 'sleeping', worktreePath: worktree }
      : agentId === 'escaper' ? { id: 'escaper', worktreePath: outside } : null),
}));

import { agentRoots, clearAgentRootsCache, importChatImage, readChatFilePreview, resolveChatFile, statChatPaths } from './chat-files';
import { agentMediaDir } from './chat-transcript';
import { copilotSessionStateDir } from '../../orchestrators/adapters/copilot-acp';
import { CHAT_FILE_PREVIEW_TEXT_MAX_BYTES } from '../../../shared/chat';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'main.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(worktree, 'shot.png'), PNG);
  fs.writeFileSync(path.join(worktree, 'clip.mp4'), Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
  fs.writeFileSync(path.join(worktree, 'blob.bin'), Buffer.from([1, 0, 2, 0]));
  fs.writeFileSync(path.join(project, 'README.md'), '# Project\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  fs.rmSync(path.join(tmpRoot, 'copilot'), { recursive: true, force: true });
  live.agents.clear();
  live.outputDirs.clear();
  clearAgentRootsCache();
  live.agents.set('a1', { projectPath: project, cwd: worktree });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('agentRoots', () => {
  it('uses the running agent, or a sleeping one from its durable config', async () => {
    expect((await agentRoots('a1')).slice(0, 2)).toEqual([worktree, project]);
    expect((await agentRoots('sleeping')).slice(0, 2)).toEqual([worktree, project]);
    expect(await agentRoots('unknown')).toEqual([]);
  });

  it("drops a working folder outside the agent's project (an edited agent config can't widen the allowlist)", async () => {
    const roots = await agentRoots('escaper');
    expect(roots[0]).toBe(project);
    expect(roots).not.toContain(outside);
    expect(await statChatPaths('escaper', [path.join(outside, 'secret.txt')])).toEqual([{ path: path.join(outside, 'secret.txt'), exists: false }]);
    live.agents.set('live-escaper', { projectPath: project, cwd: '/' });
    expect(await agentRoots('live-escaper')).not.toContain('/');
  });
});

describe('statChatPaths', () => {
  it('confirms files inside the agent folders, relative to its cwd, with line suffixes', async () => {
    const out = await statChatPaths('a1', ['src/main.ts:3', path.join(project, 'README.md'), 'shot.png', 'clip.mp4', 'blob.bin', pathToFileURL(path.join(worktree, 'src', 'main.ts')).href]);
    expect(out.map((f) => [f.exists, f.kind])).toEqual([
      [true, 'text'], [true, 'text'], [true, 'image'], [true, 'video'], [true, 'other'], [true, 'text'],
    ]);
    expect(out[0]).toMatchObject({ path: 'src/main.ts:3', name: 'main.ts', size: 20 });
  });

  it('confirms a whole path with spaces, and not its fragments (#2423)', async () => {
    const dir = path.join(worktree, 'CH media probe');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'tone sample.wav'), 'RIFF');
    const abs = path.join(dir, 'tone sample.wav');
    const url = pathToFileURL(abs).href;
    const out = await statChatPaths('a1', [abs, path.join('CH media probe', 'tone sample.wav:4:2'), url, decodeURI(url), path.join(worktree, 'CH'), path.join('probe', 'tone sample.wav')]);
    expect(out.map((f) => f.exists)).toEqual([true, true, true, true, false, false]);
    expect(out[0]).toMatchObject({ kind: 'audio', name: 'tone sample.wav' });
    expect(await resolveChatFile('a1', decodeURI(url))).toBe(fs.realpathSync.native(abs));
  });

  it('says nothing about missing files, folders, or files outside the agent folders', async () => {
    const out = await statChatPaths('a1', ['src/missing.ts', 'src', path.join(outside, 'secret.txt'), '../../../../outside/secret.txt', '']);
    expect(out).toEqual([
      { path: 'src/missing.ts', exists: false },
      { path: 'src', exists: false },
      { path: path.join(outside, 'secret.txt'), exists: false },
      { path: '../../../../outside/secret.txt', exists: false },
      { path: '', exists: false },
    ]);
  });

  // Windows CI can't create symlinks without Developer Mode.
  it.skipIf(process.platform === 'win32')('does not follow a symlink out of the agent folders', async () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(worktree, 'link.txt'));
    expect(await statChatPaths('a1', ['link.txt'])).toEqual([{ path: 'link.txt', exists: false }]);
  });

  it('confirms nothing for an agent it does not know', async () => {
    expect(await statChatPaths('unknown', [path.join(project, 'README.md')])).toEqual([{ path: path.join(project, 'README.md'), exists: false }]);
  });
});

describe('readChatFilePreview', () => {
  it('returns text, capped', async () => {
    expect(await readChatFilePreview('a1', 'src/main.ts')).toEqual({ kind: 'text', name: 'main.ts', size: 20, text: 'export const x = 1;\n', truncated: false });
    fs.writeFileSync(path.join(worktree, 'big.log'), 'a'.repeat(CHAT_FILE_PREVIEW_TEXT_MAX_BYTES + 10));
    const big = await readChatFilePreview('a1', 'big.log');
    expect(big.text).toHaveLength(CHAT_FILE_PREVIEW_TEXT_MAX_BYTES);
    expect(big.truncated).toBe(true);
  });

  it('returns sniffed image bytes and media bytes by extension', async () => {
    expect(await readChatFilePreview('a1', 'shot.png')).toMatchObject({ kind: 'image', mimeType: 'image/png', data: new Uint8Array(PNG) });
    expect(await readChatFilePreview('a1', 'clip.mp4')).toMatchObject({ kind: 'video', mimeType: 'video/mp4' });
    expect(await readChatFilePreview('a1', 'blob.bin')).toEqual({ kind: 'other', name: 'blob.bin', size: 4, tooLarge: false });
  });

  it('does not hand over an image whose header declares a huge canvas', async () => {
    const be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    fs.writeFileSync(path.join(worktree, 'bomb.png'), Buffer.from([...PNG.subarray(0, 16), ...be(50000), ...be(50000), 8, 6, 0, 0, 0]));
    expect(await readChatFilePreview('a1', 'bomb.png')).toEqual({ kind: 'image', name: 'bomb.png', size: 29, tooLarge: true });
  });

  it('refuses files outside the agent folders', async () => {
    await expect(readChatFilePreview('a1', path.join(outside, 'secret.txt'))).rejects.toThrow('not available');
    await expect(resolveChatFile('a1', path.join(outside, 'secret.txt'))).rejects.toThrow('not available');
    expect(await resolveChatFile('a1', 'src/main.ts')).toBe(fs.realpathSync.native(path.join(worktree, 'src', 'main.ts')));
  });
});

describe('importChatImage (local markdown images, #2422)', () => {
  beforeEach(() => {
    // storeMedia writes only next to an existing transcript folder.
    fs.mkdirSync(path.dirname(agentMediaDir('a1')), { recursive: true });
    fs.mkdirSync(path.join(worktree, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'assets', 'icon.png'), PNG);
    fs.writeFileSync(path.join(worktree, 'assets', 'my shot.png'), PNG);
    fs.writeFileSync(path.join(outside, 'shot.png'), PNG);
  });

  const stored = expect.objectContaining({ ok: true, mimeType: 'image/png', mediaRef: expect.stringMatching(/^[0-9a-f]{64}\.png$/) });

  it('stores absolute, cwd-relative and file: URL images as media', async () => {
    for (const src of [path.join(worktree, 'assets', 'icon.png'), './assets/icon.png', 'assets/icon.png', pathToFileURL(path.join(worktree, 'assets', 'icon.png')).href]) {
      expect(await importChatImage('a1', src)).toEqual(stored);
    }
    const result = await importChatImage('a1', './assets/icon.png');
    if (!result.ok) throw new Error('not stored');
    expect(fs.readFileSync(path.join(agentMediaDir('a1'), result.mediaRef))).toEqual(PNG);
    expect(result).toMatchObject({ width: 1, height: 1 });
  });

  it('answers every one of many images asked at once (they take turns)', async () => {
    const out = await Promise.all(Array.from({ length: 7 }, (_, i) => importChatImage('a1', i % 2 ? './assets/icon.png' : './assets/none.png')));
    expect(out.filter((r) => r.ok)).toHaveLength(3);
    expect(out.filter((r) => !r.ok)).toHaveLength(4);
  });

  it('decodes URL-encoded spaces, in paths and file: URLs', async () => {
    expect(await importChatImage('a1', './assets/my%20shot.png')).toEqual(stored);
    expect(await importChatImage('a1', './assets/my shot.png')).toEqual(stored);
    expect(await importChatImage('a1', pathToFileURL(path.join(worktree, 'assets', 'my shot.png')).href)).toEqual(stored);
  });

  it('says missing for a nonexistent path inside the roots', async () => {
    expect(await importChatImage('a1', './assets/nope.png')).toEqual({ ok: false, reason: 'missing' });
    expect(await importChatImage('a1', './assets/no%20pe.png')).toEqual({ ok: false, reason: 'missing' });
  });

  it('says outside for paths beyond the roots, existing or not, and through symlinks', async () => {
    expect(await importChatImage('a1', path.join(outside, 'shot.png'))).toEqual({ ok: false, reason: 'outside' });
    expect(await importChatImage('a1', path.join(outside, 'nope.png'))).toEqual({ ok: false, reason: 'outside' });
    expect(await importChatImage('a1', '../../../../outside/shot.png')).toEqual({ ok: false, reason: 'outside' });
    expect(await importChatImage('a1', pathToFileURL(path.join(outside, 'shot.png')).href)).toEqual({ ok: false, reason: 'outside' });
    expect(await importChatImage('a1', '~/shot.png')).toEqual({ ok: false, reason: 'outside' });
    fs.symlinkSync(path.join(outside, 'shot.png'), path.join(worktree, 'assets', 'link.png'));
    expect(await importChatImage('a1', './assets/link.png')).toEqual({ ok: false, reason: 'outside' });
    expect(await importChatImage('unknown', path.join(worktree, 'assets', 'icon.png'))).toEqual({ ok: false, reason: 'outside' });
  });

  it('says unsupported for files that are not images, and too-large for a huge canvas', async () => {
    expect(await importChatImage('a1', 'src/main.ts')).toEqual({ ok: false, reason: 'unsupported' });
    const huge = Buffer.from(PNG);
    huge.writeUInt32BE(100_000, 16);
    huge.writeUInt32BE(100_000, 20);
    fs.writeFileSync(path.join(worktree, 'assets', 'huge.png'), huge);
    expect(await importChatImage('a1', './assets/huge.png')).toEqual({ ok: false, reason: 'too-large' });
  });

  it("reads from the live session's own output folder, and only that session's", async () => {
    fs.mkdirSync(sessionOutput, { recursive: true });
    fs.writeFileSync(path.join(sessionOutput, 'screenshot.png'), PNG);
    fs.mkdirSync(path.join(path.dirname(sessionOutput), 'sess-2'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(sessionOutput), 'sess-2', 'other.png'), PNG);
    expect(await importChatImage('a1', path.join(sessionOutput, 'screenshot.png'))).toEqual({ ok: false, reason: 'outside' });
    live.outputDirs.set('a1', sessionOutput);
    clearAgentRootsCache();
    expect(await importChatImage('a1', path.join(sessionOutput, 'screenshot.png'))).toEqual(stored);
    // Another session's folder is never allowed (it reads as an ended session).
    expect(await importChatImage('a1', path.join(path.dirname(sessionOutput), 'sess-2', 'other.png'))).toEqual({ ok: false, reason: 'session-ended' });
  });

  it("says the session ended for an image in a session folder that isn't live, without allowing it", async () => {
    fs.mkdirSync(sessionOutput, { recursive: true });
    fs.writeFileSync(path.join(sessionOutput, 'screenshot.png'), PNG);
    const other = path.join(path.dirname(sessionOutput), 'sess-2');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'old.png'), PNG);
    live.outputDirs.set('a1', sessionOutput);
    // An earlier session of the same CLI: denied, with the right reason.
    expect(await importChatImage('a1', path.join(other, 'old.png'))).toEqual({ ok: false, reason: 'session-ended' });
    expect(await importChatImage('a1', pathToFileURL(path.join(other, 'old.png')).href)).toEqual({ ok: false, reason: 'session-ended' });
    // Copilot's default session-state, for an agent with no live session.
    const defaultState = copilotSessionStateDir(process.env);
    expect(await importChatImage('a1', path.join(defaultState, 'abc-123', 'shot.png'))).toEqual({ ok: false, reason: 'session-ended' });
    // The folder list itself and non-token ids aren't a session's file.
    expect(await importChatImage('a1', path.join(defaultState, 'shot.png'))).toEqual({ ok: false, reason: 'outside' });
    expect(await importChatImage('a1', path.join(outside, 'shot.png'))).toEqual({ ok: false, reason: 'outside' });
  });

  it('ignores a session-output folder that is a symlink', async () => {
    fs.mkdirSync(path.dirname(sessionOutput), { recursive: true });
    fs.symlinkSync(outside, sessionOutput, 'dir');
    live.outputDirs.set('a1', sessionOutput);
    expect(await agentRoots('a1')).not.toContain(sessionOutput);
    expect(await importChatImage('a1', path.join(sessionOutput, 'shot.png'))).toMatchObject({ ok: false });
  });
});
