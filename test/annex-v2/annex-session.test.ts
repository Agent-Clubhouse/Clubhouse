/**
 * One long Annex session, with a phone and our own desktop controller both connected,
 * going through what separate PRs tested alone: a snapshot over its limit, a project
 * change, a large terminal attach, a failed build, canvas edits and restarts. Steps run
 * in order and share their state on purpose. Real server, client, pairing, mTLS,
 * WebSockets, canvas storage and terminal mirror, with both sides in temp folders.
 * Slow, so it runs when asked: `npm run harness:annex-session`.
 * docs/annex-harness.md says what it leaves out.
 */
import { type ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import forge from 'node-forge';
import { WebSocket } from 'ws';

const C = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs'); const nodeOs = require('os') as typeof import('os'); const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'annex-session-controller-'));
  return { dir, found: null as null | ((service: unknown) => void), events: [] as Array<{ channel: string; payload: any }> };
});

vi.mock('electron', () => ({
  app: { getPath: () => C.dir, isPackaged: false, getVersion: () => '0.0.0-harness', getName: () => 'annex-session-controller', on: () => {} },
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
import { requestPtyBufferSnapshot } from '../../src/main/services/annex-client';

const FRAME_LIMIT = 8 * 1024 * 1024;
const AGENT = 'durable_proj_0';
const TERMINAL_COLS = 120;

const describeWhenAsked = process.env.CLUBHOUSE_ANNEX_SESSION_HARNESS === '1' ? describe : describe.skip;

function clientCertificate(commonName: string) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: commonName }]);
  cert.setIssuer(cert.subject.attributes);
  cert.sign(forge.pki.privateKeyFromPem(key), forge.md.sha256.create());
  return { key, cert: forge.pki.certificateToPem(cert) };
}

function phoneIdentity() {
  const der = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return { publicKey: der.toString('base64'), ...clientCertificate(hex.match(/.{2}/g)!.join(':')) };
}

describeWhenAsked('one Annex session, phone and desktop controller together', () => {
  const satelliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-session-satellite-'));
  const phone = phoneIdentity();
  let server: ChildProcess;
  let info: { port: number; pairingPort: number; pin: string; controlPort: number };
  let fingerprint = '';

  /** A frame and the bytes it came in. A phone's socket stays open across steps. */
  interface PhoneSocket { ws: WebSocket; frames: any[]; sizes: Map<any, number> }
  let live: PhoneSocket;

  const startSatellite = (fault?: 'fail') => new Promise<typeof info>((resolve, reject) => {
    server = spawn('npx', ['vitest', 'run', '--project', 'integration', 'test/annex-v2/annex-session-satellite.test.ts', '--disableConsoleIntercept'], {
      env: { ...process.env, CLUBHOUSE_ANNEX_SESSION_DIR: satelliteDir, CLUBHOUSE_ANNEX_SESSION_HARNESS: '', ...(fault && { CLUBHOUSE_ANNEX_SESSION_FAULT: fault }) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    server.stdout!.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/ANNEX_SESSION (\{.*\})/);
      if (match) resolve(JSON.parse(match[1]));
    });
    server.on('exit', (code) => reject(new Error(`satellite exited ${code}: ${out.slice(-500)}`)));
  });

  const stopSatellite = () => new Promise<void>((resolve) => {
    server.once('exit', () => resolve());
    void control('/stop').catch(() => server.kill());
  });

  const control = (route: string, body: object = {}) => new Promise<any>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: info.controlPort, path: route, method: 'POST' }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${route}: ${text}`))));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

  const phoneRequest = (method: string, route: string, body?: Buffer | string) => new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: info.port, path: route, method, key: phone.key, cert: phone.cert, rejectUnauthorized: false,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });

  const pairPhone = async () => {
    const body = JSON.stringify({ pin: info.pin, publicKey: phone.publicKey, alias: 'Session phone', icon: 'phone', color: 'indigo' });
    return new Promise<number>((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: info.port, path: '/pair', method: 'POST', key: phone.key, cert: phone.cert, rejectUnauthorized: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.end(body);
    });
  };

  const sockets: WebSocket[] = [];
  const connectPhone = async (): Promise<PhoneSocket> => {
    const ws = new WebSocket(`wss://127.0.0.1:${info.port}/ws`, { key: phone.key, cert: phone.cert, rejectUnauthorized: false, maxPayload: 16 * 1024 * 1024 });
    const frames: any[] = [];
    const sizes = new Map<any, number>();
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString());
      sizes.set(frame, data.length);
      frames.push(frame);
    });
    ws.on('error', () => {});
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return { ws, frames, sizes };
  };

  const until = (check: () => boolean, timeout = 30_000) => vi.waitFor(() => { if (!check()) throw new Error('not yet'); }, { timeout, interval: 50 });
  const sat = () => annexClient.getSatellite(fingerprint)!;
  const snapshotsOf = (frames: any[]) => frames.filter((f) => f.type === 'snapshot');
  const satelliteEvents = () => C.events.filter((e) => e.payload?.satelliteId).map((e) => e.payload);
  const canvasNames = (state: any) => state?.canvases?.map((c: any) => c.name);
  const projectIds = (snapshot: any) => snapshot.projects.map((p: any) => p.id);
  /** What a controller's renderer last heard. Its windows read this, not `sat()`. */
  const lastRendererSnapshot = () => satelliteEvents().filter((e) => e.type === 'snapshot').at(-1)!.payload;
  const viewIds = (canvases: any, canvasId: string) => canvases.canvases.find((c: any) => c.id === canvasId).views.map((v: any) => v.id);
  const withEdit = async (socket: PhoneSocket, projectId: string, canvasId: string, viewId: string) => {
    const seen = socket.frames.length;
    socket.ws.send(JSON.stringify({ type: 'canvas:mutation', payload: { projectId, canvasId, mutation: { type: 'addView', viewType: 'anchor', viewId, position: { x: 1, y: 1 } } } }));
    await until(() => socket.frames.slice(seen).some((f) => f.type === 'canvas:state'));
    return socket.frames.slice(seen).find((f) => f.type === 'canvas:state').payload.state.views.at(-1).id as string;
  };

  const reconnectController = async () => {
    annexClient.disconnect(fingerprint);
    await until(() => sat().state === 'disconnected');
    annexClient.connect(fingerprint);
  };

  beforeAll(async () => {
    info = await startSatellite();
    annexClient.startClient();
    await until(() => C.found !== null);
    C.found!({ host: '127.0.0.1', port: info.port, addresses: ['127.0.0.1'], referer: { address: '127.0.0.1' }, txt: { pairingPort: String(info.pairingPort) } });
    await until(() => annexClient.getDiscoveredServices().length > 0);
    fingerprint = annexClient.getDiscoveredServices()[0].fingerprint;
    expect(await annexClient.pairWithService(fingerprint, info.pin)).toMatchObject({ success: true });
    expect(await pairPhone()).toBe(200);
  }, 120_000);

  afterAll(async () => {
    annexClient.stopClient();
    for (const ws of sockets) ws.terminate();
    await stopSatellite().catch(() => {});
    server?.kill();
    fs.rmSync(satelliteDir, { recursive: true, force: true });
    fs.rmSync(C.dir, { recursive: true, force: true });
  }, 60_000);

  it('a snapshot over 8 MiB: under the limit with canvases left out, and both clients still get them', async () => {
    live = await connectPhone();
    await until(() => live.frames.length > 0);
    const [first] = live.frames;
    expect(first.type).toBe('snapshot');
    expect(live.sizes.get(first)).toBeLessThanOrEqual(FRAME_LIMIT);
    expect(first.payload.snapshotTruncated).toMatchObject({ version: 1, reason: 'frame_limit', omitted: ['canvasState', 'appCanvasState'] });
    expect(first.payload.snapshotTruncated.bytes).toBeGreaterThan(FRAME_LIMIT);
    expect(first.payload).not.toHaveProperty('canvasState');

    const route = await phoneRequest('GET', '/api/v1/mobile/canvas/proj_0');
    expect(route.status).toBe(200);
    expect(canvasNames(JSON.parse(route.text).state)).toEqual(['Main', 'Other']);

    await until(() => !!(sat().snapshot as any)?.canvasState?.proj_1);
    expect(canvasNames((sat().snapshot as any).canvasState.proj_0)).toEqual(['Main', 'Other']);
    expect(canvasNames((sat().snapshot as any).appCanvasState)).toEqual(['Main', 'Other']);
    await until(() => !!lastRendererSnapshot().canvasState?.proj_1);
    expect(sat().snapshotUnavailable).toBeFalsy();
  }, 60_000);

  it('a project change: a truncated snapshot naming it, with the controller keeping its canvases', async () => {
    const phoneBefore = snapshotsOf(live.frames).length;
    const canvasBefore = (sat().snapshot as any).canvasState.proj_0;
    await control('/add-project', { id: 'proj_2' });
    await control('/projects-changed');

    await until(() => snapshotsOf(live.frames).length > phoneBefore);
    const snapshot = snapshotsOf(live.frames).at(-1);
    expect(projectIds(snapshot.payload)).toEqual(['proj_0', 'proj_1', 'proj_2']);
    expect(snapshot.payload.snapshotTruncated.omitted).toEqual(['canvasState', 'appCanvasState']);
    expect(live.sizes.get(snapshot)).toBeLessThanOrEqual(FRAME_LIMIT);

    await until(() => projectIds(sat().snapshot).includes('proj_2'));
    expect((sat().snapshot as any).canvasState.proj_0).toEqual(canvasBefore);
    expect(lastRendererSnapshot().canvasState.proj_0).toEqual(canvasBefore);
  }, 60_000);

  it('a project that arrives with a canvas during a truncated connection: the controller gets that canvas too', async () => {
    await control('/add-project', { id: 'proj_3', kilobytes: 8 });
    await control('/projects-changed');
    await until(() => !!lastRendererSnapshot().canvasState?.proj_3);
    expect(canvasNames((sat().snapshot as any).canvasState.proj_3)).toEqual(['Main', 'Other']);
  }, 60_000);

  it('a large terminal attach, with a snapshot going out at the same moment: both fit, and the socket stays up', async () => {
    await control('/spawn-terminal', { agentId: AGENT, cols: TERMINAL_COLS });
    await control('/terminal-lines', { from: 0, count: 12_000, cols: TERMINAL_COLS });

    const seen = live.frames.length;
    const snapshotsBefore = snapshotsOf(live.frames).length;
    live.ws.send(JSON.stringify({ type: 'pty:attach', payload: { agentId: AGENT } }));
    await control('/projects-changed');

    await until(() => live.frames.slice(seen).some((f) => f.type === 'pty:attach:ack'), 60_000);
    await until(() => snapshotsOf(live.frames).length > snapshotsBefore);
    const ack = live.frames.slice(seen).find((f) => f.type === 'pty:attach:ack');

    expect(live.sizes.get(ack)).toBeLessThanOrEqual(FRAME_LIMIT);
    expect(ack.payload.agentId).toBe(AGENT);
    expect(ack.payload.scrollbackLines).toBeGreaterThan(0);
    expect(ack.payload.scrollbackLines).toBeLessThan(10_000);
    expect(ack.payload.cols).toBe(TERMINAL_COLS);
    // The newest output is what stays.
    expect(ack.payload.buffer).toContain('line-11999');
    expect(ack.payload.buffer).not.toContain('line-1 ');
    expect(live.ws.readyState).toBe(WebSocket.OPEN);

    // Live output follows on from the ack.
    const afterAck = live.frames.length;
    await control('/terminal-lines', { from: 12_000, count: 3, cols: TERMINAL_COLS });
    await until(() => live.frames.slice(afterAck).some((f) => f.type === 'pty:data'));
    const next = live.frames.slice(afterAck).find((f) => f.type === 'pty:data');
    expect(next.payload.outputSeq).toBeGreaterThan(ack.payload.outputSeq);

    // The controller reads the same terminal over its route, under the same bound.
    const buffer = await requestPtyBufferSnapshot(fingerprint, AGENT);
    expect(Buffer.byteLength(JSON.stringify(buffer.data))).toBeLessThanOrEqual(FRAME_LIMIT);
    expect(buffer.data).toContain('line-12002');
    expect(sat().state).toBe('connected');
  }, 180_000);

  it('a failed build: nothing lost on open sockets, a new socket waits, and all recover with canvases', async () => {
    const canvasBefore = (sat().snapshot as any).canvasState.proj_0;
    const liveSnapshots = snapshotsOf(live.frames).length;
    await control('/fault', { fault: 'fail' });
    await control('/projects-changed');
    await new Promise((r) => setTimeout(r, 500));

    const waiting = await connectPhone();
    await until(() => waiting.frames.length > 0);
    expect(waiting.frames[0]).toEqual({ type: 'error', payload: { message: 'snapshot_failed' } });
    // Events wait for its baseline, then come in order behind it.
    await control('/chat-event');
    await control('/chat-event');
    await new Promise((r) => setTimeout(r, 300));
    expect(waiting.frames.map((f) => f.type)).toEqual(['error']);

    await reconnectController();
    await until(() => sat().state === 'connected');
    await until(() => sat().snapshotUnavailable === true);
    expect((sat().snapshot as any).canvasState.proj_0).toEqual(canvasBefore);

    await control('/fault', { fault: 'none' });
    await until(() => waiting.frames.length >= 4, 75_000);
    expect(waiting.frames.map((f) => f.type).slice(0, 4)).toEqual(['error', 'snapshot', 'chat:event', 'chat:event']);
    expect(snapshotsOf(waiting.frames)[0].payload.snapshotTruncated.omitted).toEqual(['canvasState', 'appCanvasState']);
    await until(() => snapshotsOf(live.frames).length > liveSnapshots, 75_000);
    expect(live.ws.readyState).toBe(WebSocket.OPEN);

    await until(() => !sat().snapshotUnavailable, 75_000);
    expect(sat().state).toBe('connected');
    expect(annexClient.sendToSatellite(fingerprint, { type: 'session:probe' })).toEqual({ sent: true });
    await until(() => !!(sat().snapshot as any).canvasState?.proj_3);
    expect((sat().snapshot as any).canvasState.proj_0).toEqual(canvasBefore);
    expect(canvasNames(lastRendererSnapshot().canvasState.proj_3)).toEqual(['Main', 'Other']);
  }, 240_000);

  it('a canvas edit survives the next truncated snapshot on the controller', async () => {
    // Settle any refetch first, so this tests the snapshot and not a late fetch.
    const before = viewIds((sat().snapshot as any).canvasState.proj_0, 'proj_0_main');
    const viewId = await withEdit(live, 'proj_0', 'proj_0_main', 'edit_1');
    await until(() => viewIds((sat().snapshot as any).canvasState.proj_0, 'proj_0_main').includes(viewId));

    const snapshots = satelliteEvents().filter((e) => e.type === 'snapshot').length;
    await control('/projects-changed');
    await until(() => satelliteEvents().filter((e) => e.type === 'snapshot').length > snapshots);
    await new Promise((r) => setTimeout(r, 500));

    const after = (sat().snapshot as any).canvasState.proj_0;
    expect(sat().snapshot as any).toHaveProperty('snapshotTruncated');
    expect(viewIds(after, 'proj_0_main')).toEqual([...before, viewId]);
    expect(viewIds(lastRendererSnapshot().canvasState.proj_0, 'proj_0_main')).toContain(viewId);
    // Only the edited canvas changed, and the other project was left alone.
    expect(canvasNames(after)).toEqual(['Main', 'Other']);
    expect(canvasNames((sat().snapshot as any).canvasState.proj_1)).toEqual(['Main', 'Other']);
  }, 60_000);

  it('an edit made while a reconnecting controller fetches canvases is still there after', async () => {
    const snapshots = satelliteEvents().filter((e) => e.type === 'snapshot').length;
    await reconnectController();
    await until(() => satelliteEvents().filter((e) => e.type === 'snapshot').length > snapshots);
    const viewId = await withEdit(live, 'proj_1', 'proj_1_main', 'edit_2');

    await until(() => viewIds((sat().snapshot as any).canvasState.proj_1, 'proj_1_main').includes(viewId));
    await new Promise((r) => setTimeout(r, 3000));
    expect(viewIds((sat().snapshot as any).canvasState.proj_1, 'proj_1_main')).toContain(viewId);
    expect(viewIds(lastRendererSnapshot().canvasState.proj_1, 'proj_1_main')).toContain(viewId);
  }, 60_000);

  it('an oversized command is refused clearly, and leaves the session up', async () => {
    const answer = await phoneRequest('POST', '/api/v1/mobile/commands', Buffer.alloc(1024 * 1024 + 1, 0x20));
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.text)).toMatchObject({ status: 'rejected', error: { code: 'too_large' } });
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
    expect(sat().state).toBe('connected');
  }, 30_000);

  it('a disconnect and a connect in one go: the controller can still send', async () => {
    annexClient.disconnect(fingerprint);
    annexClient.connect(fingerprint);
    await until(() => sat().state === 'connected');
    await new Promise((r) => setTimeout(r, 500));
    expect(annexClient.sendToSatellite(fingerprint, { type: 'session:probe' })).toEqual({ sent: true });
  }, 60_000);

  it('Annex stopped during a hung build and started again: not stuck once the old watchdog passes', async () => {
    await control('/fault', { fault: 'hang' });
    await control('/projects-changed');
    await new Promise((r) => setTimeout(r, 500));
    const closed = new Promise<void>((resolve) => { live.ws.once('close', () => resolve()); });
    const restarted = await control('/restart-in-place');
    await closed;
    expect(restarted.fault).toBe('hang');
    // New reads go normally, and the one from before the stop stays hung past its 15-second watchdog.
    await control('/fault', { fault: 'none', keepHung: true });
    await new Promise((r) => setTimeout(r, 16_000));
    const state = await control('/state');
    info = { ...info, port: state.port };
    live = await connectPhone();
    await until(() => live.frames.length > 0);
    expect(live.frames[0].type).toBe('snapshot');

    await until(() => sat().state === 'connected', 60_000);
    await control('/release-hung');
  }, 120_000);

  it('a satellite process restart during a failure: the controller keeps its state, then takes the lower seq', async () => {
    await control('/chat-event');
    await until(() => sat().state === 'connected');
    await until(() => (sat().snapshot as any).lastSeq >= 0);
    const seqBefore = (await control('/state')).lastSeq;
    expect(seqBefore).toBeGreaterThan(0);
    const edited = viewIds((sat().snapshot as any).canvasState.proj_0, 'proj_0_main');
    const projectsBefore = projectIds(sat().snapshot);

    const phoneClosed = new Promise<void>((resolve) => { live.ws.once('close', () => resolve()); });
    await stopSatellite();
    await phoneClosed;
    await until(() => sat().state !== 'connected');

    info = { ...info, ...await startSatellite('fail') };
    const failing = await control('/state');
    expect(failing.fault).toBe('fail');
    info = { ...info, port: failing.port, pairingPort: failing.pairingPort };
    // Discovery hears the new process, wherever it landed.
    C.found!({ host: '127.0.0.1', port: info.port, addresses: ['127.0.0.1'], referer: { address: '127.0.0.1' }, txt: { pairingPort: String(info.pairingPort) } });

    await until(() => sat().state === 'connected' && sat().snapshotUnavailable === true, 60_000);
    expect(projectIds(sat().snapshot)).toEqual(projectsBefore);

    await control('/fault', { fault: 'none' });
    await until(() => !sat().snapshotUnavailable, 75_000);
    expect((sat().snapshot as any).lastSeq).toBeLessThan(seqBefore);
    expect(projectIds(sat().snapshot)).toEqual(projectsBefore);

    // What was on disk came back through the new process's own routes.
    await until(() => viewIds((sat().snapshot as any).canvasState.proj_0, 'proj_0_main').length === edited.length);
    expect(viewIds((sat().snapshot as any).canvasState.proj_0, 'proj_0_main')).toEqual(edited);

    // The phone's identity survived too, and its terminal did not: there's no process now.
    live = await connectPhone();
    await until(() => snapshotsOf(live.frames).length > 0, 30_000);
    live.ws.send(JSON.stringify({ type: 'pty:attach', payload: { agentId: AGENT } }));
    await until(() => live.frames.some((f) => f.type === 'error' && f.payload?.op === 'pty:attach'));
    expect(live.frames.find((f) => f.type === 'error' && f.payload?.op === 'pty:attach').payload.message).toBe('agent_not_running');
  }, 240_000);
});
