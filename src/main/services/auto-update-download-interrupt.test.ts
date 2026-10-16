/**
 * downloadFile against a real local HTTP server: an interrupted body
 * (server closes the connection mid-download) must reject instead of
 * leaving the promise pending, and must remove the partial file.
 *
 * Kept separate from auto-update-download.test.ts, which mocks `http`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { downloadFile } from './auto-update-service';

const TIMEOUT_MS = 10_000;

async function waitForRemoval(filePath: string, timeoutMs = 2_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(filePath)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !fs.existsSync(filePath);
}

describe('downloadFile — interrupted downloads (real server)', () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpDir: string;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-download-test-'));
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects and removes the partial file when the server closes mid-body (Content-Length set)', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': '100000' });
      res.write(Buffer.alloc(1000, 1), () => {
        setTimeout(() => res.socket?.destroy(), 20);
      });
    };
    const dest = path.join(tmpDir, 'update.zip');

    await expect(downloadFile(`${baseUrl}/update.zip`, dest, undefined, () => {})).rejects.toThrow();
    expect(await waitForRemoval(dest)).toBe(true);
  }, TIMEOUT_MS);

  it('rejects and removes the partial file when a chunked response is cut off', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(1000, 1), () => {
        setTimeout(() => res.socket?.destroy(), 20);
      });
    };
    const dest = path.join(tmpDir, 'update.zip');

    await expect(downloadFile(`${baseUrl}/update.zip`, dest, undefined, () => {})).rejects.toThrow();
    expect(await waitForRemoval(dest)).toBe(true);
  }, TIMEOUT_MS);

  it('still resolves and keeps the file for a complete download', async () => {
    const body = Buffer.alloc(5000, 7);
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
    };
    const dest = path.join(tmpDir, 'update.zip');
    const progress: number[] = [];

    await downloadFile(`${baseUrl}/update.zip`, dest, undefined, (p) => progress.push(p));
    expect((await fsp.readFile(dest)).equals(body)).toBe(true);
    expect(progress[progress.length - 1]).toBe(100);
  }, TIMEOUT_MS);
});
