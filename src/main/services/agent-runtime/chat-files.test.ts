import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-files-'));
const project = path.join(tmpRoot, 'project');
const worktree = path.join(project, '.clubhouse', 'agents', 'a1');
const outside = path.join(tmpRoot, 'outside');

const live = vi.hoisted(() => ({ agents: new Map<string, { projectPath: string; cwd?: string }>() }));
vi.mock('electron', () => ({ app: { getPath: () => path.join(tmpRoot, 'userData') } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-registry', () => ({ agentRegistry: { get: (id: string) => live.agents.get(id) } }));
vi.mock('../project-store', () => ({ list: async () => [{ id: 'p1', path: project }] }));
vi.mock('../agent-config', () => ({
  getDurableConfig: async (_projectPath: string, agentId: string) => (
    agentId === 'sleeping' ? { id: 'sleeping', worktreePath: worktree }
      : agentId === 'escaper' ? { id: 'escaper', worktreePath: outside } : null),
}));

import { agentRoots, clearAgentRootsCache, readChatFilePreview, resolveChatFile, statChatPaths } from './chat-files';
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
  live.agents.clear();
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
