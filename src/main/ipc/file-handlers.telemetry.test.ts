import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() } }));
vi.mock('../services/file-service', () => ({
  readTree: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readBinary: vi.fn(),
  mkdir: vi.fn(),
  deleteFile: vi.fn(),
  rename: vi.fn(),
  copy: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('../services/search-service', () => ({ searchFiles: vi.fn() }));
vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../services/file-watch-service', () => ({ startWatch: vi.fn(), stopWatch: vi.fn() }));
vi.mock('../services/path-sandbox', () => ({ assertAllowedPath: vi.fn() }));
vi.mock('./settings-handlers', () => ({ editorSettings: { getSettings: () => ({ editorCommand: 'code' }) } }));

const rec = vi.hoisted(() => ({
  counts: [] as Array<{ name: string; attrs: Array<{ key: string; value: unknown }> }>,
  flows: [] as Array<{ name: string; attrs: Array<{ key: string; value: unknown }>; classification?: unknown }>,
}));
vi.mock('../telemetry/facade', () => ({
  tel: {
    count: (name: string, _v: number, attrs: Array<{ key: string; value: unknown }> = []) => rec.counts.push({ name, attrs }),
    flow: async (name: string, opts: { attrs?: Array<{ key: string; value: unknown }> }, fn: (s: { set: (...a: Array<{ key: string; value: unknown }>) => void }) => unknown, extras?: { classify?: (r: unknown) => unknown }) => {
      const f = { name, attrs: [...(opts.attrs ?? [])], classification: undefined as unknown };
      rec.flows.push(f);
      const r = await fn({ set: (...a) => f.attrs.push(...a) });
      f.classification = extras?.classify ? extras.classify(r) : 'ok';
      return r;
    },
  },
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as fileService from '../services/file-service';
import { assertAllowedPath } from '../services/path-sandbox';
import { registerFileHandlers } from './file-handlers';

let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
const errno = (code: string) => Object.assign(new Error(`${code}: /Users/x/secret`), { code });
const values = (c: { attrs: Array<{ key: string; value: unknown }> }) => Object.fromEntries(c.attrs.map((a) => [a.key, a.value]));

beforeEach(() => {
  rec.counts = [];
  rec.flows = [];
  handlers = new Map();
  vi.mocked(ipcMain.handle).mockImplementation(((channel: string, fn: (...a: unknown[]) => Promise<unknown>) => {
    handlers.set(channel, fn);
  }) as never);
  registerFileHandlers();
});

describe('file handler telemetry', () => {
  it.each([
    [IPC.FILE.READ, 'read', 'readFile', ['/p/a.ts'], 'ENOENT'],
    [IPC.FILE.WRITE, 'write', 'writeFile', ['/p/a.ts', 'x'], 'EACCES'],
    [IPC.FILE.READ_BINARY, 'read_binary', 'readBinary', ['/p/a.png'], 'EISDIR'],
    [IPC.FILE.MKDIR, 'mkdir', 'mkdir', ['/p/d'], 'EEXIST'],
    [IPC.FILE.DELETE, 'delete', 'deleteFile', ['/p/a.ts'], 'EPERM'],
    [IPC.FILE.RENAME, 'rename', 'rename', ['/p/a', '/p/b'], 'ENOTDIR'],
    [IPC.FILE.COPY, 'copy', 'copy', ['/p/a', '/p/b'], 'ENOSPC'],
    [IPC.FILE.STAT, 'stat', 'stat', ['/p/a'], 'ENOENT'],
  ] as const)('%s counts errors by errno code and keeps the message unchanged', async (channel, op, fn, args, code) => {
    vi.mocked(fileService[fn] as (...a: unknown[]) => Promise<unknown>).mockRejectedValueOnce(errno(code));
    const err = await handlers.get(channel)!({}, ...args).catch((e: Error) => e) as Error;
    expect(err.message).toMatch(new RegExp(`^Failed to .*: ${code} - `));
    const count = rec.counts.find((c) => c.name === 'clubhouse.file.ops')!;
    expect(values(count)).toEqual({ 'clubhouse.file.op': op, 'clubhouse.file.result': 'error', 'error.type': code });
    expect(JSON.stringify(rec.counts)).not.toContain('secret');
  });

  it('counts successes and sandbox denials', async () => {
    vi.mocked(fileService.readFile).mockResolvedValueOnce('content');
    await handlers.get(IPC.FILE.READ)!({}, '/p/a.ts');
    expect(values(rec.counts[0])).toEqual({ 'clubhouse.file.op': 'read', 'clubhouse.file.result': 'ok' });

    vi.mocked(assertAllowedPath).mockRejectedValueOnce(new Error('Access denied: path "/etc/passwd" is outside allowed project directories'));
    await expect(handlers.get(IPC.FILE.READ)!({}, '/etc/passwd')).rejects.toThrow('Access denied');
    expect(values(rec.counts[1])['error.type']).toBe('path_denied');
  });

  it('records tree size on the tree-read span', async () => {
    vi.mocked(fileService.readTree).mockImplementationOnce(async (_d, opts) => {
      opts!.stats!.nodeCount = 10_000;
      opts!.stats!.hitCap = true;
      return [];
    });
    const sender = { once: vi.fn(), off: vi.fn() };
    await handlers.get(IPC.FILE.READ_TREE)!({ sender }, '/p');
    const flow = rec.flows.find((f) => f.name === 'clubhouse.file.tree.read')!;
    expect(values(flow)).toMatchObject({ 'clubhouse.tree.node_count_bucket': '>=10000', 'clubhouse.tree.hit_cap': true });
  });
});
