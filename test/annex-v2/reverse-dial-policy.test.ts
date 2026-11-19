import * as net from 'net';
import * as https from 'https';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { createInterface } from 'readline';
import { promisify } from 'util';
import { X509Certificate } from 'crypto';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateTestIdentity } from '../../e2e/annex-v2/tls-test-utils';
import { assertAcceptAudit, assertDialAudit, captureOwnedReverseAudit, closeServer, installAcceptAudit, installDialPolicy, installMainGuard, listen, readMainDialAudit, sentinel, transparentForward, type MainDialAudit } from './reverse-parity-fixture';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Reverse dial-policy cleanup failed');
});

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
    const audit = installAcceptAudit();
    cleanup.push(() => audit.restore());
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
    assertAcceptAudit(audit.accepts, port, forward.targetSourcePorts);
    expect(() => assertAcceptAudit([], port, forward.targetSourcePorts)).toThrow('missing from the target listener audit');
  });

  it('detects a child-process direct dial at the target even when the process-local guard and sentinel see nothing', async () => {
    const audit = installAcceptAudit();
    cleanup.push(() => audit.restore());
    const target = await sentinel();
    const guard = await sentinel();
    cleanup.push(target.close, guard.close);
    const policy = installDialPolicy(() => false);
    cleanup.push(() => policy.restore());
    await promisify(execFile)(process.execPath, ['-e', `
      const socket = require('net').connect(Number(process.argv[1]), '127.0.0.1');
      socket.once('connect', () => socket.end());
      socket.once('error', () => process.exit(1));
    `, String(target.port)]);
    expect(target.accepts()).toBe(1);
    expect(policy.attempts).toEqual([]);
    assertDialAudit(policy.attempts, null, [], guard.accepts());
    expect(() => assertAcceptAudit(audit.accepts, target.port, [])).toThrow('outside the forward');
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

  it('captures a real forward dial arriving between the two desktop snapshots without losing either target effect', async () => {
    const audit = installAcceptAudit();
    cleanup.push(() => audit.restore());
    const effects: string[] = [];
    const server = net.createServer((socket) => socket.once('data', (data) => {
      effects.push(data.toString());
      socket.end(data);
    }));
    const port = await listen(server);
    cleanup.push(() => closeServer(server));
    const forward = await transparentForward(port);
    cleanup.push(forward.close);
    const policy = installDialPolicy((host, port) => host === '127.0.0.1' && port === forward.port);
    cleanup.push(() => policy.restore());
    const request = (text: string) => new Promise<string>((resolve, reject) => {
      const socket = net.connect(forward.port, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => socket.write(text));
      socket.once('data', (data) => { socket.end(); resolve(data.toString()); });
    });
    expect(await request('before capture')).toBe('before capture');
    let late: Promise<string> | undefined;
    const concurrentDial = () => late ??= request('during capture');
    let quiesced = false;
    const closed = [false, false];
    const read = (index: number): MainDialAudit => ({
      phase: closed[index] ? 'exit' : 'live', installed: true, sealed: quiesced, pending: 0,
      attempts: index === 0 ? policy.attempts.map((attempt) => ({ ...attempt })) : [],
      accepts: index === 1 ? audit.accepts.map((accepted) => ({ ...accepted })) : [],
    });
    const captured = await captureOwnedReverseAudit(forward, [
      {
        quiesce: async () => { await concurrentDial(); quiesced = true; return read(0); },
        close: async () => { closed[0] = true; },
        readFinal: async () => read(0),
      },
      {
        quiesce: async () => read(1),
        close: async () => { closed[1] = true; },
        readFinal: async () => { await concurrentDial(); return read(1); },
      },
    ]);
    if (captured.status !== 'complete') throw new AggregateError(captured.errors, 'Capture failed');
    assertDialAudit(captured.audits[0].attempts, { host: '127.0.0.1', port: forward.port }, captured.forward.sourcePorts, 0);
    assertAcceptAudit(captured.audits[1].accepts, port, captured.forward.targetSourcePorts);
    expect(effects).toEqual(['before capture', 'during capture']);
    expect(captured.forward.sourcePorts).toHaveLength(2);
    expect(captured.forward.targetSourcePorts).toHaveLength(2);
    expect(captured.forward).toMatchObject({ sealed: true, closed: true, pending: 0, sockets: 0, lateSourcePorts: [] });
  });

  it('waits for the actual outgoing connect callback before sealing or draining the forward', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    const port = await listen(server);
    cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await closeServer(server); });
    const forward = await transparentForward(port);
    cleanup.push(forward.close);
    const originalEmit = net.Socket.prototype.emit;
    let release!: () => void;
    let observed!: () => void;
    const held = new Promise<void>((resolve) => { observed = resolve; });
    const emit = vi.spyOn(net.Socket.prototype, 'emit').mockImplementation(function (this: net.Socket, event, ...args) {
      if (event === 'connect' && this.remotePort === port) {
        release = () => { Reflect.apply(originalEmit, this, [event, ...args]); };
        observed();
        return true;
      }
      return Reflect.apply(originalEmit, this, [event, ...args]);
    });
    cleanup.push(() => { emit.mockRestore(); });
    const caller = net.connect(forward.port, '127.0.0.1');
    cleanup.push(() => { caller.destroy(); });
    await new Promise<void>((resolve, reject) => { caller.once('connect', resolve); caller.once('error', reject); });
    await held;
    const sourcePort = caller.localPort;
    if (!sourcePort) throw new Error('Missing connected caller port');
    let finished = false;
    const drained = forward.sealAndDrain([sourcePort]).then(() => { finished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(forward.snapshot()).toMatchObject({ sealed: false, pending: 1 });
    release();
    await drained;
    expect(forward.snapshot()).toMatchObject({ sealed: true, pending: 0, sockets: 0, targetPorts: [port] });
  });

  it('retains a child dial accepted after sealing and rejects capture instead of hiding the late port', async () => {
    const target = await sentinel();
    cleanup.push(target.close);
    const forward = await transparentForward(target.port);
    cleanup.push(forward.close);
    const final: MainDialAudit = { phase: 'exit', installed: true, sealed: true, pending: 0, attempts: [], accepts: [] };
    const captured = await captureOwnedReverseAudit(forward, [
      {
        quiesce: async () => ({ ...final, phase: 'live' }),
        close: async () => {
          const result = await promisify(execFile)(process.execPath, ['-e', `
            const socket = require('net').connect(Number(process.argv[1]), '127.0.0.1');
            socket.once('connect', () => process.stdout.write('connected'));
            socket.once('error', error => { if (error.code !== 'ECONNRESET') throw error; });
          `, String(forward.port)]);
          expect(result.stdout).toBe('connected');
        },
        readFinal: async () => final,
      },
      { quiesce: async () => ({ ...final, phase: 'live' }), close: async () => {}, readFinal: async () => final },
    ]);
    expect(captured.status).toBe('failed');
    if (captured.status !== 'failed') throw new Error('Late child traffic was hidden');
    expect(captured.errors.map(String)).toContain('Error: Reverse forward accepted traffic after sealing');
    expect(captured.forward.sourcePorts).toHaveLength(1);
    expect(captured.forward.lateSourcePorts).toEqual(captured.forward.sourcePorts);
    expect(captured.forward).toMatchObject({ closed: true, pending: 0, sockets: 0, targetSourcePorts: [] });
    expect(target.accepts()).toBe(0);
    expect(() => assertDialAudit([], { host: '127.0.0.1', port: forward.port }, captured.forward.sourcePorts, 0)).toThrow('unaudited app dial');
  });

  it('attempts every owned close and returns partial evidence when quiesce, close and final read fail', async () => {
    const target = await sentinel();
    cleanup.push(target.close);
    const forward = await transparentForward(target.port);
    cleanup.push(forward.close);
    const quiesceError = new Error('quiesce fault');
    const closeError = new Error('close fault');
    const readError = new Error('missing exit receipt');
    const closed = [0, 0];
    const final: MainDialAudit = { phase: 'exit', installed: true, sealed: true, pending: 0, attempts: [], accepts: [] };
    const captured = await captureOwnedReverseAudit(forward, [
      {
        quiesce: () => { throw quiesceError; },
        close: async () => { closed[0]++; throw closeError; },
        readFinal: async () => { throw readError; },
      },
      {
        quiesce: async () => ({ ...final, phase: 'live' }),
        close: async () => { closed[1]++; },
        readFinal: async () => final,
      },
    ]);
    if (captured.status !== 'failed') throw new Error('Capture faults were hidden');
    expect(captured.errors).toEqual([quiesceError, closeError, readError]);
    expect(closed).toEqual([1, 1]);
    expect(captured.audits).toEqual([null, final]);
    expect(captured.forward).toMatchObject({ closed: true, pending: 0, sockets: 0 });
  });

  it('serializes the exact main guard and retains post-seal accepts and the final exit-listener dial in its exit receipt', async () => {
    const cache = path.resolve('node_modules/.cache');
    fs.mkdirSync(cache, { recursive: true });
    const profile = fs.mkdtempSync(path.join(cache, 'reverse-main-guard-'));
    cleanup.push(() => fs.rmSync(profile, { recursive: true, force: true }));
    const auditPath = path.join(profile, 'exit.json');
    const guard = await sentinel();
    cleanup.push(guard.close);
    let complete!: (result: { error: Error | null; stdout: string; stderr: string }) => void;
    const completion = new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) => { complete = resolve; });
    const child = execFile(process.execPath, ['-e', `
      const net = require('net');
      const { createInterface } = require('readline');
      const install = (${installMainGuard.toString()});
      const input = JSON.parse(process.argv[1]);
      const effects = [];
      const echo = (port, text) => new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('error', reject);
        socket.once('connect', () => socket.write(text));
        socket.once('data', data => { socket.end(); resolve(data.toString()); });
      });
      const refusal = port => new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve('escaped'); });
        socket.once('error', error => resolve(error.code));
      });
      (async () => {
        const calibration = await install({ app: { getPath: () => input.profile } }, input);
        const server = net.createServer(socket => socket.once('data', data => {
          effects.push(data.toString()); socket.end(data);
        }));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const lines = createInterface({ input: process.stdin });
        const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
        send({ port, calibration });
        for await (const line of lines) {
          const command = JSON.parse(line);
          if (command.method === 'exercise') {
            globalThis.__reverseP8.setForward(command.port);
            send({ echoed: await echo(command.port, 'guard bytes'), audit: globalThis.__reverseP8.read() });
          } else if (command.method === 'seal') {
            await globalThis.__reverseP8.seal({ port, sourcePorts: command.sourcePorts });
            send({ refusals: [await refusal(command.port), await refusal(port)], audit: globalThis.__reverseP8.read() });
            process.on('exit', () => net.connect(command.port, '127.0.0.1').once('error', () => {}));
          } else if (command.method === 'exit') {
            await new Promise(resolve => server.close(resolve));
            send({ effects });
            lines.close(); process.stdin.destroy(); break;
          } else throw new Error('Unexpected guard command');
        }
      })().catch(error => { console.error(error); process.exit(1); });
    `, JSON.stringify({ profile, sentinelPort: guard.port, auditPath })], { timeout: 15_000 }, (error, stdout, stderr) => complete({ error, stdout, stderr }));
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const result = await completion;
      if (result.error) throw new Error(`Guard child failed: ${result.stderr}`, { cause: result.error });
    });
    if (!child.stdin || !child.stdout) throw new Error('Missing guard child pipes');
    const output = createInterface({ input: child.stdout });
    cleanup.push(() => output.close());
    const lines = output[Symbol.asyncIterator]();
    const read = async () => {
      const next = await lines.next();
      if (next.done) throw new Error(`Guard child exited before its receipt: ${(await completion).stderr}`);
      return JSON.parse(next.value);
    };
    const ready = await read();
    expect(ready.calibration).toBe('ERR_REVERSE_DIAL_BLOCKED');
    const forward = await transparentForward(ready.port);
    cleanup.push(forward.close);
    child.stdin.write(`${JSON.stringify({ method: 'exercise', port: forward.port })}\n`);
    const exercised = await read();
    expect(exercised.echoed).toBe('guard bytes');
    child.stdin.write(`${JSON.stringify({ method: 'seal', port: forward.port, sourcePorts: forward.targetSourcePorts })}\n`);
    const sealed = await read();
    expect(sealed.refusals).toEqual(['ERR_REVERSE_TRANSPORT_SEALED', 'ERR_REVERSE_DIAL_BLOCKED']);
    expect(sealed.audit.attempts).toHaveLength(4);
    await forward.sealAndDrain(forward.sourcePorts);
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(ready.port, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => socket.write('late native bytes'));
      socket.once('data', (data) => { socket.end(); resolve(data.toString()); });
    });
    expect(echoed).toBe('late native bytes');
    child.stdin.write('{"method":"exit"}\n');
    expect((await read()).effects).toEqual(['guard bytes', 'late native bytes']);
    const result = await completion;
    if (result.error) throw new Error(`Guard child failed: ${result.stderr}`, { cause: result.error });
    const final = readMainDialAudit(auditPath);
    expect(final).toMatchObject({ phase: 'exit', installed: true, sealed: true, pending: 0 });
    expect(final.attempts).toHaveLength(5);
    expect(final.attempts.filter((attempt) => attempt.afterSeal).map((attempt) => attempt.error))
      .toEqual(['ERR_REVERSE_TRANSPORT_SEALED', 'ERR_REVERSE_DIAL_BLOCKED', 'ERR_REVERSE_TRANSPORT_SEALED']);
    assertDialAudit(final.attempts, { host: '127.0.0.1', port: forward.port }, forward.sourcePorts, guard.accepts());
    expect(final.accepts.filter((accepted) => accepted.port === ready.port)).toHaveLength(2);
    expect(() => assertAcceptAudit(final.accepts, ready.port, forward.targetSourcePorts)).toThrow('outside the forward');
  }, 20_000);
});
