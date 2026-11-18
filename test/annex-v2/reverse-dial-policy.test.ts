import * as net from 'net';
import * as https from 'https';
import * as tls from 'tls';
import { X509Certificate } from 'crypto';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateTestIdentity } from '../../e2e/annex-v2/tls-test-utils';
import { assertDialAudit, closeServer, installDialPolicy, listen, sentinel, transparentForward } from './reverse-parity-fixture';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

function dial(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.once('error', reject);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
}

describe('reverse direct-dial policy calibration', () => {
  it('denies the actual listener, sentinel, aliases, alternate ports and both IP families before connect', async () => {
    const target = await sentinel();
    const guard = await sentinel();
    cleanup.push(target.close, guard.close);
    const policy = installDialPolicy(() => false);
    cleanup.push(() => policy.restore());
    const endpoints = [
      ['127.0.0.1', target.port], ['localhost', target.port], ['::1', target.port],
      ['127.0.0.2', target.port], ['::ffff:127.0.0.1', target.port],
      ['127.0.0.1', guard.port], ['127.0.0.1', 1], ['127.0.0.1', 65535],
    ] as const;
    for (const [host, port] of endpoints) await expect(dial(host, port)).rejects.toMatchObject({ code: 'ERR_REVERSE_DIAL_BLOCKED' });
    expect(policy.attempts).toHaveLength(endpoints.length);
    expect(policy.attempts.every((attempt) => attempt.outcome === 'denied')).toBe(true);
    expect(target.accepts()).toBe(0);
    assertDialAudit(policy.attempts, null, [], guard.accepts());
  });

  it('covers Socket.connect overloads, Node-normalized arguments, TLS, HTTPS and WebSocket', async () => {
    const target = await sentinel();
    cleanup.push(target.close);
    const policy = installDialPolicy(() => false);
    cleanup.push(() => policy.restore());
    const socketError = (start: () => net.Socket) => new Promise<Error>((resolve) => start().once('error', resolve));
    const forms = [
      () => new net.Socket().connect(target.port, '127.0.0.1'),
      () => new net.Socket().connect({ port: target.port, host: 'localhost' }),
      () => tls.connect({ port: target.port, host: '::1', rejectUnauthorized: false }),
    ];
    for (const form of forms) expect(await socketError(form)).toMatchObject({ code: 'ERR_REVERSE_DIAL_BLOCKED' });
    await expect(new Promise((resolve, reject) => {
      const request = https.get(`https://127.0.0.1:${target.port}/api/v1/status`, resolve);
      request.once('error', reject);
    })).rejects.toMatchObject({ code: 'ERR_REVERSE_DIAL_BLOCKED' });
    await expect(new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${target.port}/control`);
      ws.once('open', resolve);
      ws.once('error', reject);
    })).rejects.toMatchObject({ code: 'ERR_REVERSE_DIAL_BLOCKED' });
    expect(policy.attempts).toHaveLength(5);
    expect(target.accepts()).toBe(0);
  });

  it('carries real pinned mTLS and WebSocket bytes through one transparent forward and audits its ports', async () => {
    const identity = generateTestIdentity();
    const caller = generateTestIdentity();
    let seenCertificate = '';
    const server = https.createServer({ cert: identity.certPem, key: identity.keyPem, requestCert: true, rejectUnauthorized: false });
    const wss = new WebSocketServer({ server });
    const serverSockets = new Set<Duplex>();
    server.on('connection', (socket) => { serverSockets.add(socket); socket.once('close', () => serverSockets.delete(socket)); });
    wss.on('connection', (ws, request) => {
      seenCertificate = (request.socket as tls.TLSSocket).getPeerCertificate().fingerprint256;
      ws.on('message', (data) => ws.send(data));
    });
    const port = await listen(server);
    cleanup.push(async () => {
      for (const ws of wss.clients) ws.terminate();
      for (const socket of serverSockets) socket.destroy();
      wss.close();
      await closeServer(server);
    });
    // The forward is trusted fixture traffic, not a second application route.
    const forward = await transparentForward(port);
    cleanup.push(forward.close);
    const policy = installDialPolicy((host, candidate) => host === '127.0.0.1' && candidate === forward.port);
    cleanup.push(() => policy.restore());
    const pinned: tls.ConnectionOptions = {
      cert: caller.certPem, key: caller.keyPem, ca: identity.certPem,
      checkServerIdentity: (_host, cert) => cert.fingerprint256 === new X509Certificate(identity.certPem).fingerprint256 ? undefined : new Error('pin mismatch'),
    };
    const ws = new WebSocket(`wss://127.0.0.1:${forward.port}/control`, { ...pinned });
    cleanup.push(() => ws.terminate());
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const received = new Promise<Buffer>((resolve) => ws.once('message', (data) => resolve(Buffer.from(data.toString()))));
    ws.send('opaque payload \u0000');
    expect((await received).toString()).toBe('opaque payload \u0000');
    expect(seenCertificate).toBe(new X509Certificate(caller.certPem).fingerprint256);
    assertDialAudit(policy.attempts, { host: '127.0.0.1', port: forward.port }, forward.sourcePorts, 0);
    expect(forward.targetPorts).toEqual([port]);
  });

  it('the no-block mutation fails even when a different remembered-route sentinel stays quiet', async () => {
    const target = await sentinel();
    const guard = await sentinel();
    cleanup.push(target.close, guard.close);
    const noBlock = installDialPolicy(() => true);
    cleanup.push(() => noBlock.restore());
    await dial('127.0.0.1', target.port);
    await vi.waitFor(() => expect(target.accepts()).toBe(1));
    expect(guard.accepts()).toBe(0);
    expect(() => assertDialAudit(noBlock.attempts, null, [], guard.accepts())).toThrow('unapproved endpoint');
  });

  it('detects an unaudited forward connection independently of the sentinel', () => {
    expect(() => assertDialAudit([], { host: '127.0.0.1', port: 1234 }, [4567], 0)).toThrow('unaudited app dial');
  });

  it('keeps the successful-connect audit when a caller aborts that socket later', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    const port = await listen(server);
    cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await closeServer(server); });
    const forward = await transparentForward(port);
    cleanup.push(forward.close);
    const policy = installDialPolicy((host, port) => host === '127.0.0.1' && port === forward.port);
    cleanup.push(() => policy.restore());
    const socket = net.connect(forward.port, '127.0.0.1');
    const error = new Promise((resolve) => socket.once('error', resolve));
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    await vi.waitFor(() => expect(forward.sourcePorts).toContain(socket.localPort));
    socket.destroy(Object.assign(new Error('The caller aborted'), { code: 'ABORT_ERR' }));
    await error;
    expect(policy.attempts[0]).toMatchObject({ allowed: true, outcome: 'error', error: 'ABORT_ERR', localPort: forward.sourcePorts[0] });
    assertDialAudit(policy.attempts, { host: '127.0.0.1', port: forward.port }, forward.sourcePorts, 0);
    expect(() => assertDialAudit(policy.attempts, { host: '127.0.0.1', port: forward.port }, [...forward.sourcePorts, 1], 0)).toThrow('unaudited app dial');
  });
});
