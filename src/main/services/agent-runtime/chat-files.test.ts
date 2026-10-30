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

import { agentFolders, clearAgentFoldersCache, importChatImage, readChatFilePreview, resolveChatFile, statChatPaths } from './chat-files';
import { agentMediaDir } from './chat-transcript';
import { CHAT_FILE_PREVIEW_PDF_MAX_BYTES, CHAT_FILE_PREVIEW_TEXT_MAX_BYTES } from '../../../shared/chat';
import { execFileSync } from 'child_process';

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
  clearAgentFoldersCache();
  live.agents.set('a1', { projectPath: project, cwd: worktree });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const PDF_TEXT = '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';
/** A PDF whose header comment has the binary marker bytes and a NUL, as many writers emit. */
const PDF_BINARY = Buffer.concat([Buffer.from('%PDF-1.4\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0x0a]), Buffer.from('1 0 obj\n')]);

describe('agentFolders', () => {
  it('uses the running agent, or a sleeping one from its durable config', async () => {
    expect((await agentFolders('a1')).slice(0, 2)).toEqual([worktree, project]);
    expect((await agentFolders('sleeping')).slice(0, 2)).toEqual([worktree, project]);
    expect(await agentFolders('unknown')).toEqual([]);
  });

  it('puts the working folder first wherever it is: relative paths resolve against it (#2478)', async () => {
    expect((await agentFolders('escaper'))[0]).toBe(outside);
    expect(await statChatPaths('escaper', ['secret.txt'])).toEqual([expect.objectContaining({ path: 'secret.txt', exists: true, kind: 'text' })]);
  });
});

describe('statChatPaths', () => {
  it('confirms files relative to the agent cwd, with line suffixes', async () => {
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

  it('confirms files outside the project, absolute, relative or file: URL (#2478)', async () => {
    const secret = path.join(outside, 'secret.txt');
    const out = await statChatPaths('a1', [secret, '../../../../outside/secret.txt', pathToFileURL(secret).href]);
    expect(out).toEqual([secret, '../../../../outside/secret.txt', pathToFileURL(secret).href].map((p) => ({ path: p, exists: true, kind: 'text', size: 4, name: 'secret.txt' })));
  });

  it('says why a path has no chip: missing, a folder, or empty', async () => {
    const out = await statChatPaths('a1', ['src/missing.ts', 'src', path.join(outside, 'nope.txt'), '']);
    expect(out).toEqual([
      { path: 'src/missing.ts', exists: false, reason: 'missing' },
      { path: 'src', exists: false, reason: 'folder' },
      { path: path.join(outside, 'nope.txt'), exists: false, reason: 'missing' },
      { path: '', exists: false, reason: 'missing' },
    ]);
  });

  it('never looks up network or device paths', async () => {
    expect(await statChatPaths('a1', ['//host/share/a.txt', '\\\\host\\share\\a.txt'])).toEqual([
      { path: '//host/share/a.txt', exists: false, reason: 'missing' },
      { path: '\\\\host\\share\\a.txt', exists: false, reason: 'missing' },
    ]);
  });

  it.skipIf(process.platform === 'win32')('calls a FIFO not a regular file, without blocking on it', async () => {
    const fifo = path.join(outside, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(await statChatPaths('a1', [fifo])).toEqual([{ path: fifo, exists: false, reason: 'not-a-file' }]);
    await expect(readChatFilePreview('a1', fifo)).rejects.toThrow('not available');
  });

  // Windows CI can't create symlinks without Developer Mode.
  it.skipIf(process.platform === 'win32')('follows a symlink and names the real file', async () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(worktree, 'link.txt'));
    expect(await statChatPaths('a1', ['link.txt'])).toEqual([{ path: 'link.txt', exists: true, kind: 'text', size: 4, name: 'secret.txt' }]);
  });

  it('confirms absolute paths for an agent it does not know, but has nothing to resolve relative ones against', async () => {
    expect(await statChatPaths('unknown', [path.join(project, 'README.md'), 'README.md'])).toEqual([
      expect.objectContaining({ path: path.join(project, 'README.md'), exists: true, kind: 'text' }),
      { path: 'README.md', exists: false, reason: 'missing' },
    ]);
  });

  it('detects a PDF by its header, NUL bytes or not, before the text check', async () => {
    fs.writeFileSync(path.join(outside, 'plain.pdf'), PDF_TEXT);
    fs.writeFileSync(path.join(outside, 'binary.pdf'), PDF_BINARY);
    // Named .pdf but not one, and a text file that only mentions the header.
    fs.writeFileSync(path.join(outside, 'fake.pdf'), 'not a pdf');
    fs.writeFileSync(path.join(outside, 'notes.md'), 'A header looks like %PDF-1.7\n');
    const out = await statChatPaths('a1', ['plain.pdf', 'binary.pdf', 'fake.pdf', 'notes.md'].map((n) => path.join(outside, n)));
    expect(out.map((f) => f.kind)).toEqual(['pdf', 'pdf', 'text', 'text']);
  });

  it('marks a file over its preview cap', async () => {
    const big = path.join(outside, 'big.pdf');
    fs.writeFileSync(big, PDF_TEXT);
    fs.truncateSync(big, CHAT_FILE_PREVIEW_PDF_MAX_BYTES + 1);
    expect(await statChatPaths('a1', [big, path.join(outside, 'secret.txt')])).toEqual([
      { path: big, exists: true, kind: 'pdf', size: CHAT_FILE_PREVIEW_PDF_MAX_BYTES + 1, name: 'big.pdf', tooLarge: true },
      expect.not.objectContaining({ tooLarge: true }),
    ]);
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

  it('returns PDF bytes, never PDF text, and not over the cap', async () => {
    fs.writeFileSync(path.join(outside, 'plain.pdf'), PDF_TEXT);
    fs.writeFileSync(path.join(outside, 'binary.pdf'), PDF_BINARY);
    const plain = await readChatFilePreview('a1', path.join(outside, 'plain.pdf'));
    expect(plain).toEqual({ kind: 'pdf', name: 'plain.pdf', size: PDF_TEXT.length, mimeType: 'application/pdf', data: new Uint8Array(Buffer.from(PDF_TEXT)) });
    expect(plain.text).toBeUndefined();
    expect(await readChatFilePreview('a1', path.join(outside, 'binary.pdf'))).toMatchObject({ kind: 'pdf', data: new Uint8Array(PDF_BINARY) });
    const big = path.join(outside, 'big.pdf');
    fs.writeFileSync(big, PDF_TEXT);
    fs.truncateSync(big, CHAT_FILE_PREVIEW_PDF_MAX_BYTES + 1);
    expect(await readChatFilePreview('a1', big)).toEqual({ kind: 'pdf', name: 'big.pdf', size: CHAT_FILE_PREVIEW_PDF_MAX_BYTES + 1, tooLarge: true });
  });

  it('reads files outside the project, and refuses missing ones', async () => {
    expect(await readChatFilePreview('a1', path.join(outside, 'secret.txt'))).toMatchObject({ kind: 'text', text: 'nope' });
    expect(await resolveChatFile('a1', path.join(outside, 'secret.txt'))).toBe(fs.realpathSync.native(path.join(outside, 'secret.txt')));
    await expect(readChatFilePreview('a1', path.join(outside, 'nope.txt'))).rejects.toThrow('not available');
    await expect(resolveChatFile('a1', path.join(outside, 'nope.txt'))).rejects.toThrow('not available');
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

  it('says missing for a nonexistent path, a folder, or a network path', async () => {
    expect(await importChatImage('a1', './assets/nope.png')).toEqual({ ok: false, reason: 'missing' });
    expect(await importChatImage('a1', './assets/no%20pe.png')).toEqual({ ok: false, reason: 'missing' });
    expect(await importChatImage('a1', path.join(outside, 'nope.png'))).toEqual({ ok: false, reason: 'missing' });
    expect(await importChatImage('a1', '//host/share/shot.png')).toEqual({ ok: false, reason: 'missing' });
    expect(await importChatImage('a1', './assets')).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('stores images outside the project too, through symlinks as well (#2478)', async () => {
    expect(await importChatImage('a1', path.join(outside, 'shot.png'))).toEqual(stored);
    expect(await importChatImage('a1', '../../../../outside/shot.png')).toEqual(stored);
    expect(await importChatImage('a1', pathToFileURL(path.join(outside, 'shot.png')).href)).toEqual(stored);
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(outside, 'shot.png'), path.join(worktree, 'assets', 'link.png'));
      expect(await importChatImage('a1', './assets/link.png')).toEqual(stored);
    }
  });

  it('says unsupported for files that are not images, and too-large for a huge canvas', async () => {
    expect(await importChatImage('a1', 'src/main.ts')).toEqual({ ok: false, reason: 'unsupported' });
    const huge = Buffer.from(PNG);
    huge.writeUInt32BE(100_000, 16);
    huge.writeUInt32BE(100_000, 20);
    fs.writeFileSync(path.join(worktree, 'assets', 'huge.png'), huge);
    expect(await importChatImage('a1', './assets/huge.png')).toEqual({ ok: false, reason: 'too-large' });
  });

  it("reads from any session's output folder, live or not", async () => {
    fs.mkdirSync(sessionOutput, { recursive: true });
    fs.writeFileSync(path.join(sessionOutput, 'screenshot.png'), PNG);
    fs.mkdirSync(path.join(path.dirname(sessionOutput), 'sess-2'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(sessionOutput), 'sess-2', 'other.png'), PNG);
    expect(await importChatImage('a1', path.join(sessionOutput, 'screenshot.png'))).toEqual(stored);
    live.outputDirs.set('a1', sessionOutput);
    clearAgentFoldersCache();
    expect(await importChatImage('a1', path.join(path.dirname(sessionOutput), 'sess-2', 'other.png'))).toEqual(stored);
  });

  it.skipIf(process.platform === 'win32')('lists the live session-output folder among the agent folders, unless it is a symlink', async () => {
    fs.mkdirSync(sessionOutput, { recursive: true });
    live.outputDirs.set('a1', sessionOutput);
    expect(await agentFolders('a1')).toContain(sessionOutput);
    fs.rmSync(sessionOutput, { recursive: true });
    fs.symlinkSync(outside, sessionOutput, 'dir');
    clearAgentFoldersCache();
    expect(await agentFolders('a1')).not.toContain(sessionOutput);
  });
});
