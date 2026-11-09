import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-links-'));
const project = path.join(tmpRoot, 'project');
const worktree = path.join(project, '.clubhouse', 'agents', 'a1');
const outside = path.join(tmpRoot, 'outside');

const live = vi.hoisted(() => ({ agents: new Map<string, { projectPath: string; cwd?: string }>() }));
vi.mock('electron', () => ({ app: { getPath: () => path.join(tmpRoot, 'userData') } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: (id: string) => live.agents.get(id) } }));
vi.mock('./agent-runtime/index', () => ({ getAgentRuntime: () => undefined }));
vi.mock('./project-store', () => ({ list: async () => [] }));
vi.mock('./agent-config', () => ({ getDurableConfig: async () => null }));
vi.mock('./dispatcher/dispatcher-paths', () => ({ getDispatcherFolders: () => [] }));

import { clearAgentFoldersCache, inspectChatLink } from './agent-runtime/chat-files';
import { listFolder, MOBILE_LINK_MAX_ENTRIES, MobileLinkQueryError, readMobileChatLink } from './annex-chat-links';

const real = (...parts: string[]) => fs.realpathSync.native(path.join(...parts));
const on = () => true;
const link = (href: string, agentId = 'a1') => readMobileChatLink(new URLSearchParams({ href }), agentId, on);

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.mkdirSync(path.join(worktree, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(worktree, 'Some Folder'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'main.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(worktree, 'Some Folder', '00_Summary.md'), '# Summary\n');
  fs.writeFileSync(path.join(worktree, 'blob.bin'), Buffer.from([1, 0, 2, 0]));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  live.agents.clear();
  clearAgentFoldersCache();
  live.agents.set('a1', { projectPath: project, cwd: worktree });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('readMobileChatLink (#3208)', () => {
  it('answers a file with its kind and size', async () => {
    expect(await link('src/main.ts')).toEqual({ version: 1, type: 'file', path: real(worktree, 'src', 'main.ts'), name: 'main.ts', kind: 'text', size: 20 });
    expect(await link('blob.bin')).toMatchObject({ type: 'file', kind: 'other', size: 4 });
  });

  it('answers a folder, with or without its trailing slash, with a sorted listing', async () => {
    const expected = {
      version: 1, type: 'directory', path: real(worktree, 'src'), name: 'src', truncated: false,
      entries: [{ name: 'main.ts', kind: 'file', size: 20 }, { name: 'nested', kind: 'directory' }],
    };
    expect(await link('src/')).toEqual(expected);
    expect(await link('src')).toEqual(expected);
  });

  it('tells a missing path from one it refuses', async () => {
    expect(await link('Some/Missing/')).toEqual({ version: 1, type: 'missing' });
    expect(await link('src/main.ts', 'nobody')).toEqual({ version: 1, type: 'missing' });
    expect(await link('   ')).toEqual({ version: 1, type: 'missing' });
    // A network share is never looked up.
    expect(await link('//fileserver/share/notes.md')).toEqual({ version: 1, type: 'not_allowed' });
    expect(await link('file://fileserver/share/notes.md')).toEqual({ version: 1, type: 'not_allowed' });
    expect(await link(`src/${'x'.repeat(1100)}`)).toEqual({ version: 1, type: 'not_allowed' });
  });

  it.skipIf(process.platform === 'win32')('refuses something that is there but is not a file or folder', async () => {
    const { execFileSync } = await import('child_process');
    execFileSync('mkfifo', [path.join(worktree, 'pipe')]);
    expect(await link('pipe')).toEqual({ version: 1, type: 'not_allowed' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a path it is not allowed to look up', async () => {
    const locked = path.join(worktree, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'inside.txt'), 'x');
    fs.chmodSync(locked, 0o000);
    try {
      expect(await link('locked/inside.txt')).toEqual({ version: 1, type: 'not_allowed' });
      // The folder itself is there; its listing can't be read.
      expect(await link('locked/')).toEqual({ version: 1, type: 'not_allowed' });
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('decodes a percent-encoded href and drops a #heading', async () => {
    expect(await link('Some%20Folder/00_Summary.md#next-steps')).toMatchObject({ type: 'file', path: real(worktree, 'Some Folder', '00_Summary.md') });
    expect(await link('Some%20Folder/')).toMatchObject({ type: 'directory', name: 'Some Folder', entries: [{ name: '00_Summary.md', kind: 'file', size: 10 }] });
  });

  it('keeps a + in a name as it is: it is not a space', async () => {
    fs.writeFileSync(path.join(worktree, 'C++ notes.md'), '# C++\n');
    expect(await link('C++ notes.md')).toMatchObject({ type: 'file', name: 'C++ notes.md' });
    expect(await link('C++%20notes.md')).toMatchObject({ type: 'file', name: 'C++ notes.md' });
    // Sent as the query string itself, %2B is the +.
    expect(await readMobileChatLink(new URLSearchParams('href=C%2B%2B%20notes.md'), 'a1', on)).toMatchObject({ type: 'file', name: 'C++ notes.md' });
  });

  it('takes the platform separator, so a Windows agent\'s backslashes resolve there', async () => {
    expect(await link(path.join('Some Folder', '00_Summary.md'))).toMatchObject({ type: 'file', path: real(worktree, 'Some Folder', '00_Summary.md') });
    expect(await link(path.join('src', 'nested') + path.sep)).toMatchObject({ type: 'directory', path: real(worktree, 'src', 'nested'), entries: [] });
  });

  it('keeps an absolute path as it is, outside the project too', async () => {
    expect(await link(path.join(outside, 'secret.txt'))).toMatchObject({ type: 'file', path: real(outside, 'secret.txt') });
    expect(await link(pathToFileURL(outside).href)).toMatchObject({ type: 'directory', path: real(outside) });
  });

  it('caps a listing and says so', async () => {
    const big = path.join(worktree, 'big');
    fs.mkdirSync(big);
    for (let i = 0; i < MOBILE_LINK_MAX_ENTRIES + 5; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(4, '0')}`), '');
    const result = await link('big');
    expect(result).toMatchObject({ type: 'directory', truncated: true });
    expect((result as { entries: unknown[] }).entries).toHaveLength(MOBILE_LINK_MAX_ENTRIES);
    expect(await listFolder(big, 3)).toEqual({ truncated: true, entries: expect.arrayContaining([expect.objectContaining({ kind: 'file', size: 0 })]) });
    expect((await listFolder(big, 3))!.entries).toHaveLength(3);
  });

  it.skipIf(process.platform === 'win32')('lists a symlink as itself, without following it', async () => {
    fs.symlinkSync(outside, path.join(worktree, 'src', 'elsewhere'));
    expect(await link('src')).toMatchObject({ entries: [{ name: 'elsewhere', kind: 'symlink' }, { name: 'main.ts', kind: 'file' }, { name: 'nested', kind: 'directory' }] });
  });

  it.each([[''], ['href=a&href=b'], ['href=a&path=b'], ['path=a'], ['href=']])('rejects the request %j', async (input) => {
    await expect(readMobileChatLink(new URLSearchParams(input), 'a1', on)).rejects.toBeInstanceOf(MobileLinkQueryError);
  });

  it('reads nothing while rich content is off, and rechecks after the read', async () => {
    await expect(readMobileChatLink(new URLSearchParams({ href: 'src' }), 'a1', () => false)).rejects.toThrow('disabled');
    let calls = 0;
    await expect(readMobileChatLink(new URLSearchParams({ href: 'src' }), 'a1', () => ++calls === 1)).rejects.toThrow('disabled');
  });
});

describe('inspectChatLink', () => {
  it('backs desktop resolveChatLink with the same answers', async () => {
    expect(await inspectChatLink('a1', 'src/')).toEqual({ type: 'directory', path: real(worktree, 'src') });
    expect(await inspectChatLink('a1', 'src/main.ts')).toEqual({ type: 'file', path: real(worktree, 'src', 'main.ts'), kind: 'text', size: 20 });
    expect(await inspectChatLink('a1', 'nope.md')).toEqual({ type: 'missing' });
    expect(await inspectChatLink('a1', 'nope.md\0x')).toEqual({ type: 'not_allowed' });
  });
});
