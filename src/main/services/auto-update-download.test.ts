/**
 * LB-SP-001: downloadFile must reject when fewer bytes are received than
 * the Content-Length header indicates (partial/truncated downloads).
 *
 * Kept in a separate file because mocking the ESM `http` module requires
 * vi.mock() hoisting, which would interfere with the real-fs tests in
 * auto-update-service.test.ts (e.g. verifySHA256 writes real temp files).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// vi.mock is hoisted before imports so these replace the real modules for
// every import in this test file, including the one inside auto-update-service.ts.
vi.mock('http', () => ({ default: { get: vi.fn() }, get: vi.fn() }));
vi.mock('https', () => ({ default: { get: vi.fn() }, get: vi.fn() }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    createWriteStream: vi.fn(),
    unlink: vi.fn(),
  };
});

import * as http from 'http';
import * as fs from 'fs';
import { downloadFile } from './auto-update-service';

type FakeReq = EventEmitter & { destroy: ReturnType<typeof vi.fn> };
type FakeRes = EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  pipe: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
};
type FakeFile = EventEmitter & { close: ReturnType<typeof vi.fn> };

describe('LB-SP-001: downloadFile partial-download detection', () => {
  let fakeReq: FakeReq;
  let fakeRes: FakeRes;
  let fakeFile: FakeFile;

  beforeEach(() => {
    fakeReq = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as FakeReq;

    fakeRes = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'content-length': '100' } as Record<string, string>,
      pipe: vi.fn(),
      resume: vi.fn(),
    }) as FakeRes;

    fakeFile = Object.assign(new EventEmitter(), { close: vi.fn() }) as FakeFile;

    vi.mocked(http.get).mockImplementation((_url: any, _opts: any, callback: any) => {
      callback(fakeRes);
      return fakeReq as any;
    });

    vi.mocked(fs.createWriteStream).mockReturnValue(fakeFile as any);
    vi.mocked(fs.unlink).mockImplementation((_p: any, cb: any) => {
      if (typeof cb === 'function') cb(null);
      return undefined as any;
    });
  });

  it('rejects with "Partial download" when fewer bytes received than Content-Length', async () => {
    const promise = downloadFile('http://example.com/file', '/tmp/test.dmg', undefined, vi.fn());

    fakeRes.emit('data', Buffer.alloc(50));
    fakeFile.emit('finish');

    await expect(promise).rejects.toThrow('Partial download: expected 100 bytes, received 50');
  });

  it('deletes the partial file on rejection', async () => {
    const promise = downloadFile('http://example.com/file', '/tmp/test.dmg', undefined, vi.fn());

    fakeRes.emit('data', Buffer.alloc(30));
    fakeFile.emit('finish');

    await expect(promise).rejects.toThrow('Partial download');
    expect(fs.unlink).toHaveBeenCalledWith('/tmp/test.dmg', expect.any(Function));
  });

  it('resolves when all bytes received match Content-Length', async () => {
    const promise = downloadFile('http://example.com/file', '/tmp/test.dmg', undefined, vi.fn());

    fakeRes.emit('data', Buffer.alloc(100));
    fakeFile.emit('finish');

    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves when no Content-Length and no expectedSize', async () => {
    fakeRes.headers = {};
    const promise = downloadFile('http://example.com/file', '/tmp/test.dmg', undefined, vi.fn());

    fakeRes.emit('data', Buffer.alloc(42));
    fakeFile.emit('finish');

    await expect(promise).resolves.toBeUndefined();
  });

  it('uses expectedSize over Content-Length when both are provided', async () => {
    const promise = downloadFile('http://example.com/file', '/tmp/test.dmg', 200, vi.fn());

    fakeRes.emit('data', Buffer.alloc(50));
    fakeFile.emit('finish');

    await expect(promise).rejects.toThrow('Partial download: expected 200 bytes, received 50');
  });

  it('rejects when multiple chunks sum to less than Content-Length', async () => {
    const promise = downloadFile('http://example.com/file', '/tmp/test.dmg', undefined, vi.fn());

    fakeRes.emit('data', Buffer.alloc(30));
    fakeRes.emit('data', Buffer.alloc(40));
    fakeFile.emit('finish');

    await expect(promise).rejects.toThrow('Partial download: expected 100 bytes, received 70');
  });
});
