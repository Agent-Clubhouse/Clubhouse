/**
 * Our own desktop controller, `annex-client`, against the real Annex server. The
 * server runs in its own process through the harness, because each side has its own
 * identity. Real pairing, mTLS, WebSocket, retries and message handling; no Electron,
 * no renderer, and fixture stores on the server. Off the host: both sides use temp
 * folders. Slow, so it runs when asked: `npm run harness:annex-client`.
 */
import { type ChildProcess, spawn } from 'child_process';
import http from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const C = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs'); const nodeOs = require('os') as typeof import('os'); const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'annex-controller-'));
  return { dir, found: null as null | ((service: unknown) => void), events: [] as Array<{ channel: string; payload: any }> };
});

vi.mock('electron', () => ({
  app: { getPath: () => C.dir, isPackaged: false, getVersion: () => '0.0.0-harness', getName: () => 'annex-controller', on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: () => {}, on: () => {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  shell: {},
  dialog: {},
  Notification: class {},
}));
vi.mock('bonjour-service', () => ({
  default: class {
    find(_options: unknown, callback: (service: unknown) => void) {
      C.found = callback;
      return { stop() {}, on() {}, update() {} };
    }
    publish() { return { stop() {} }; }
    destroy() {}
  },
}));
vi.mock('../../src/main/services/log-service', () => ({ appLog: () => {} }));
vi.mock('../../src/main/util/ipc-broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { C.events.push({ channel, payload }); },
}));

import * as annexClient from '../../src/main/services/annex-client';

const describeWhenAsked = process.env.CLUBHOUSE_ANNEX_CLIENT_HARNESS === '1' ? describe : describe.skip;

describeWhenAsked('annex-client against the real Annex server', () => {
  let server: ChildProcess;
  let info: { port: number; pairingPort: number; pin: string; controlPort: number };
  let fingerprint = '';

  const control = (path: string, body: object = {}) => new Promise<any>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: info.controlPort, path, method: 'POST' }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

  const satelliteEvents = () => C.events.filter((e) => e.channel.includes('satellite-event') || e.payload?.satelliteId).map((e) => e.payload);
  const eventsSince = (mark: number) => satelliteEvents().slice(mark).map((e: any) => ({ type: e.type, payload: e.payload }));
  const sat = () => annexClient.getSatellite(fingerprint)!;
  const until = (check: () => boolean, timeout = 20_000) => vi.waitFor(() => { if (!check()) throw new Error('not yet'); }, { timeout, interval: 50 });
  const connected = () => until(() => sat()?.state === 'connected');
  const reconnectNow = async () => {
    annexClient.disconnect(fingerprint);
    await until(() => sat().state === 'disconnected');
    const mark = satelliteEvents().length;
    annexClient.connect(fingerprint);
    await connected();
    return mark;
  };

  beforeAll(async () => {
    server = spawn('npx', ['vitest', 'run', '--project', 'integration', 'test/annex-v2/annex-harness.test.ts', '-t', 'serves until told to stop', '--disableConsoleIntercept'], {
      env: { ...process.env, CLUBHOUSE_ANNEX_HARNESS: '1', CLUBHOUSE_ANNEX_CLIENT_HARNESS: '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    info = await new Promise((resolve, reject) => {
      let out = '';
      server.stdout!.on('data', (chunk) => {
        out += chunk;
        const match = out.match(/ANNEX_HARNESS (\{.*\})/);
        if (match) resolve(JSON.parse(match[1]));
      });
      server.on('exit', (code) => reject(new Error(`harness exited ${code}`)));
    });

    annexClient.startClient();
    await until(() => C.found !== null);
    C.found!({ host: '127.0.0.1', port: info.port, addresses: ['127.0.0.1'], referer: { address: '127.0.0.1' }, txt: { pairingPort: String(info.pairingPort) } });
    await until(() => annexClient.getDiscoveredServices().length > 0);
    fingerprint = annexClient.getDiscoveredServices()[0].fingerprint;
    const paired = await annexClient.pairWithService(fingerprint, info.pin);
    expect(paired).toMatchObject({ success: true });
    await connected();
  }, 120_000);

  afterAll(async () => {
    annexClient.stopClient();
    await control('/stop').catch(() => {});
    server?.kill();
  });

  it('first connection: a snapshot, taken as the satellite state', async () => {
    await until(() => !!sat().snapshot);
    expect(sat().snapshot!.projects).toHaveLength(2);
    expect(sat().state).toBe('connected');
  }, 30_000);

  it('events during a first build arrive after its snapshot, in order, with no-seq frames held too', async () => {
    await control('/fault', { fault: 'hang' });
    const mark = await reconnectNow();
    await control('/chat-event');
    await control('/theme');
    await control('/chat-event');
    await new Promise((r) => setTimeout(r, 300));
    expect(eventsSince(mark)).toEqual([]);
    expect(sat().state).toBe('connected');

    await control('/fault', { fault: 'none' });
    await until(() => eventsSince(mark).length >= 4);

    expect(eventsSince(mark).map((e) => e.type)).toEqual(['snapshot', 'chat:event', 'theme:changed', 'chat:event']);
  }, 60_000);

  it('a failed build: connected, the error reaches the renderer channel, old state kept, then recovery', async () => {
    const before = sat().snapshot;
    await control('/fault', { fault: 'fail' });
    const mark = await reconnectNow();
    await until(() => eventsSince(mark).length > 0);

    expect(eventsSince(mark)[0]).toEqual({ type: 'error', payload: { message: 'snapshot_failed' } });
    expect(sat().state).toBe('connected');
    expect(sat().snapshot).toEqual(before);

    await control('/fault', { fault: 'none' });
    await until(() => eventsSince(mark).some((e) => e.type === 'snapshot'), 70_000);
    expect(sat().lastError).toBeFalsy();
  }, 120_000);

  it('a snapshot too large to send: never sent, state kept, connected, and recovers on a change', async () => {
    await control('/fault', { fault: 'oversize' });
    await control('/refresh');
    await new Promise((r) => setTimeout(r, 1000));
    const before = sat().snapshot;
    const mark = await reconnectNow();
    await until(() => eventsSince(mark).length > 0, 30_000);

    expect(eventsSince(mark).map((e) => e.type)).toEqual(['error']);
    expect(sat().snapshot).toEqual(before);
    expect(sat().state).toBe('connected');

    await control('/fault', { fault: 'none' });
    await control('/refresh');
    await until(() => eventsSince(mark).some((e) => e.type === 'snapshot'), 45_000);
  }, 120_000);

  it('a cold start on a failed build: connected with no snapshot, then recovers', async () => {
    annexClient.forgetSatellite(fingerprint);
    await control('/fault', { fault: 'fail' });
    const mark = satelliteEvents().length;
    C.found!({ host: '127.0.0.1', port: info.port, addresses: ['127.0.0.1'], referer: { address: '127.0.0.1' }, txt: { pairingPort: String(info.pairingPort) } });
    await until(() => annexClient.getDiscoveredServices().length > 0);
    expect(await annexClient.pairWithService(fingerprint, info.pin)).toMatchObject({ success: true });
    await connected();
    await until(() => eventsSince(mark).length > 0);

    expect(eventsSince(mark)[0].type).toBe('error');
    expect(sat().snapshot).toBeNull();
    expect(sat().state).toBe('connected');

    await control('/fault', { fault: 'none' });
    await until(() => !!sat().snapshot, 70_000);
  }, 120_000);

  it('a reconnect: a new snapshot is taken, and its seq continues', async () => {
    await control('/chat-event');
    const seqBefore = sat().snapshot!.lastSeq;
    const mark = await reconnectNow();
    await until(() => eventsSince(mark).some((e) => e.type === 'snapshot'));
    expect(sat().snapshot!.lastSeq).toBeGreaterThanOrEqual(seqBefore);
  }, 60_000);

  it('a reconnect after the satellite restarts its seq takes the new snapshot', async () => {
    await control('/chat-event');
    await control('/fixture', { projects: 3 });
    await control('/reset-seq');
    const mark = await reconnectNow();
    await until(() => eventsSince(mark).length > 0);
    await new Promise((r) => setTimeout(r, 500));
    expect(sat().snapshot!.projects).toHaveLength(3);
  }, 60_000);
});
