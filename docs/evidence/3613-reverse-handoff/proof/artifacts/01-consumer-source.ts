/**
 * Transport/consumer proof, not app or native-PTY acceptance. Two isolated
 * desktop module contexts use real identities, pinned TLS and control. A has
 * only an outgoing route to B; A has no listener for B's direct requests.
 * Target route/subscription stores are fixtures; the P1 authorizer is real.
 */
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as https from 'https';
import * as net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Duplex } from 'stream';
import { TLSSocket } from 'tls';
import { expect, it, vi } from 'vitest';
import { HANDOFF_TRANSFER_ROUTE } from '../../src/shared/handoff-transfer';
import type { DispatchContext, SubscriptionSink } from '../../src/main/services/annex-control';
import type { IconSnapshot } from '../../src/main/services/remote-icon-fetch';
import { authority, close, desktop, listen, pairedPeer, type Desktop } from './reverse-desktop-fixture';

it('preserves binary bytes through one forward and retires the whole owned consumer stream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'annex-reverse-consumer-'));
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  let a: Desktop | undefined;
  let b: Desktop | undefined;
  let server: https.Server | undefined;
  let forward: net.Server | undefined;
  let barrier: net.Server | undefined;
  const forwardSockets = new Set<net.Socket>();
  const serverSockets = new Set<Duplex>();
  let reportTeardown: (() => void) | undefined;
  try {
    const aDir = join(root, 'a'), bDir = join(root, 'b');
    mkdirSync(aDir); mkdirSync(bDir);
    a = await desktop(aDir);
    b = await desktop(bDir);
    const target = a, requester = b;
    const peerA = pairedPeer(target), peerB = pairedPeer(requester);
    // An actual closed port, not a mock transport refusal or an absent hint.
    barrier = net.createServer((socket) => socket.destroy());
    const blockedPort = await listen(barrier);
    requester.peers.addPeer({
      ...peerA, typedHost: `127.0.0.1:${blockedPort}`, typedHostCert: peerA.tlsCertificateFingerprint,
    });
    target.peers.addPeer(peerB);
    const targetDeps = authority(target), requesterDeps = authority(requester);
    const bytes = Buffer.from(Array.from({ length: 80 * 1024 + 17 }, (_, index) => index & 255));
    const file = join(aDir, 'fixture.bin');
    writeFileSync(file, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const icon = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
    const serving = new Set<{ sink: SubscriptionSink; closed: boolean }>();
    const inFlight = new Set<DispatchContext>();
    let originalStream: { sink: SubscriptionSink; closed: boolean } | undefined;
    let pendingRead: AbortSignal | undefined;
    let handoffRequests = 0;
    target.control.setControlTarget({
      authorize: (caller) => target.auth.authorize(caller, targetDeps),
      stillAuthorized: (principal) => target.auth.stillAuthorized(principal, targetDeps),
      dispatch: async (principal, request, context) => {
        expect(principal).toMatchObject({ fingerprint: peerB.fingerprint, pin: peerB.tlsCertificateFingerprint, via: 'reverse' });
        inFlight.add(context);
        try {
          if (request.path === HANDOFF_TRANSFER_ROUTE && request.method === 'POST') {
            handoffRequests++;
            return { complete: true, status: 200, headers: { 'content-type': 'application/json' },
              body: Buffer.from(JSON.stringify({ base64: readFileSync(file).toString('base64'), sha256: digest })),
            };
          }
          if (request.path === '/api/v1/icons/project/p' && request.method === 'GET') {
            return { complete: true, status: 200, headers: { 'content-type': 'image/png' }, body: icon };
          }
          if (request.path.startsWith('/api/v1/projects/p/files/read?') && request.method === 'GET') {
            return { complete: true, status: 200, headers: {}, body: Buffer.from('one route caf\u00e9\n') };
          }
          if (request.path === '/api/v1/projects/p/files/tree' && request.method === 'GET') {
            pendingRead = context.signal;
            await new Promise<void>((resolve) => {
              if (context.signal.aborted) resolve();
              else context.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            return { complete: false, status: 200, headers: {}, body: Buffer.alloc(0) };
          }
          return { complete: true, status: 404, headers: {}, body: Buffer.alloc(0) };
        } finally { inFlight.delete(context); }
      },
      subscribe: (principal, sink) => {
        expect(principal.via).toBe('reverse');
        const owned = { sink, closed: false };
        serving.add(owned);
        originalStream = owned;
        sink.send(JSON.stringify({ type: 'snapshot', payload: {
          protocolVersion: 2, lastSeq: 1,
          projects: [{ id: 'p', name: 'Fixture project', path: aDir, color: 'indigo', icon: 'fixture.png' }],
          agents: { p: [] }, quickAgents: {},
        } }));
        return { close: () => { owned.closed = true; serving.delete(owned); } };
      },
    });
    requester.control.setInboundAuthority({
      accept: (socket) => {
        if (!(socket instanceof TLSSocket)) return { ok: false, status: 401, error: 'unauthorized', message: 'TLS required' };
        const fingerprint = requester.tls.extractPeerFingerprint(socket) ?? '';
        const pin = requester.tls.extractPeerCertificateFingerprint(socket);
        const result = requester.auth.authorizeControlLink({ fingerprint, pin, via: 'direct' }, requesterDeps);
        if (requester.auth.isRefusal(result)) return result;
        return { ok: true, fingerprint: result.fingerprint, pin: result.principal.pin };
      },
      stillAllowed: (fingerprint, pin) => requester.auth.authorizeControlLink({ fingerprint, pin, via: 'direct' }, requesterDeps).ok,
    });
    let httpRequests = 0;
    const upgrades: string[] = [];
    server = https.createServer(requester.tls.createTlsServerOptions(requester.info), (_req, res) => {
      httpRequests++;
      res.writeHead(404).end();
    });
    server.on('connection', (socket) => {
      serverSockets.add(socket);
      socket.once('close', () => { serverSockets.delete(socket); });
    });
    server.on('upgrade', (request, socket, head) => {
      upgrades.push(request.url ?? '');
      requester.control.handleControlUpgrade(request, socket, head);
    });
    const port = await listen(server);
    // The single usable forward is byte-transparent, including the TLS handshake.
    forward = net.createServer((incoming) => {
      const outgoing = net.connect(port, '127.0.0.1');
      for (const socket of [incoming, outgoing]) {
        forwardSockets.add(socket);
        socket.once('close', () => { forwardSockets.delete(socket); });
      }
      incoming.on('error', () => outgoing.destroy());
      outgoing.on('error', () => incoming.destroy());
      incoming.on('close', () => outgoing.destroy());
      outgoing.on('close', () => incoming.destroy());
      incoming.pipe(outgoing).pipe(incoming);
    });
    const forwardedPort = await listen(forward);
    expect(port).not.toBe(blockedPort);
    expect(forwardedPort).not.toBe(blockedPort);
    await close(barrier);
    await expect(new Promise<void>((resolve, reject) => {
      const socket = net.connect(blockedPort, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => { socket.destroy(); resolve(); });
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    requester.client.startClient();
    target.control.connectTo(peerB.fingerprint, '127.0.0.1', forwardedPort,
      target.tls.createPinnedTlsClientOptions(target.info, {
        certPem: requester.cert.certPem, fingerprint: requester.tls.certificateFingerprint(requester.cert.certPem),
      }), peerB.tlsCertificateFingerprint);
    await vi.waitFor(() => {
      expect(requester.control.getLinkReadiness(peerA.fingerprint).acceptedHere).toBe(true);
      const snapshot: IconSnapshot | null = requester.client.getSatellite(peerA.fingerprint)?.snapshot ?? null;
      expect(snapshot?.projectIcons?.p).toBe(`data:image/png;base64,${icon.toString('base64')}`);
    }, { timeout: 10_000, interval: 20 });
    expect(requester.client.isMachineConnected(peerA.fingerprint)).toBe(false);
    expect(upgrades).toEqual(['/control']);
    expect(httpRequests).toBe(0);
    const response = await requester.client.postToMachine(peerA.fingerprint, HANDOFF_TRANSFER_ROUTE, { op: 'chunk' }, { maxResponseBytes: 200 * 1024 });
    expect(response.status).toBe(200);
    if (!response.body || typeof response.body !== 'object' || !('base64' in response.body) || typeof response.body.base64 !== 'string') {
      throw new Error('Expected completed binary chunk envelope');
    }
    const decoded = Buffer.from(response.body.base64, 'base64');
    expect(decoded.equals(bytes)).toBe(true);
    expect(createHash('sha256').update(decoded).digest('hex')).toBe(digest);
    expect(handoffRequests).toBe(1);
    await expect(requester.client.requestFileRead(peerA.fingerprint, 'p', 'file.txt')).resolves.toBe('one route caf\u00e9\n');
    expect(upgrades).toEqual(['/control']);
    expect(httpRequests).toBe(0);
    expect(serving.size).toBe(1);
    const owned = originalStream;
    if (!owned) throw new Error('Expected the original owned subscription');
    owned.sink.send(JSON.stringify({ type: 'pty:data', payload: { agentId: 'agent', data: 'owned\n', outputSeq: 1 } }));
    const terminalId = `remote:${peerA.fingerprint}:agent`;
    await vi.waitFor(() => expect(requester.headless.getSize(terminalId)).toBeDefined());
    const pending = requester.client.requestFileTree(peerA.fingerprint, 'p');
    await vi.waitFor(() => expect(pendingRead).toBeDefined());
    requester.client.stopClient();
    await pending;
    await vi.waitFor(() => {
      expect(pendingRead?.aborted).toBe(true);
      expect(inFlight.size).toBe(0);
      expect(serving.size).toBe(0);
      expect(owned.closed).toBe(true);
      expect(requester.headless.getSize(terminalId)).toBeUndefined();
    });
    const before = requester.events.length;
    expect(owned.sink.send(JSON.stringify({ type: 'pty:data', payload: { agentId: 'agent', data: 'late', outputSeq: 2 } }))).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requester.events).toHaveLength(before);
    expect(requester.control.getLinkReadiness(peerA.fingerprint).acceptedHere).toBe(true);
    if (!forward || !server) throw new Error('Lost an owned fixture listener before teardown');
    const ownedForward = forward, ownedServer = server;
    reportTeardown = () => { process.stdout.write(`ANNEX_REVERSE_FIXTURE_TEARDOWN ${JSON.stringify({
      forwardSockets: forwardSockets.size, serverSockets: serverSockets.size,
      forwardListening: ownedForward.listening, serverListening: ownedServer.listening,
    })}\n`); };
    process.stdout.write(`ANNEX_REVERSE_CONSUMER ${JSON.stringify({
      binaryBytes: decoded.length, sha256: digest, iconBytes: icon.length,
      controlUpgrades: upgrades, ordinaryHttpRequests: httpRequests, handoffRequests,
      reverseDirectRefused: true, directConnected: false, subscriptionsAfterStop: serving.size,
      inFlightAfterStop: inFlight.size, headlessDisposed: true, lateIpc: requester.events.length - before,
      independentAcceptedControlRetained: true,
    })}\n`);
  } finally {
    b?.client.stopClient();
    a?.control.closeAll();
    b?.control.closeAll();
    for (const socket of forwardSockets) socket.destroy();
    for (const socket of serverSockets) socket.destroy();
    try {
      await Promise.all([close(forward), close(server), close(barrier)]);
      await vi.waitFor(() => {
        expect(forwardSockets.size).toBe(0);
        expect(serverSockets.size).toBe(0);
      });
      reportTeardown?.();
    } finally {
      a?.headless.disposeAll();
      b?.headless.disposeAll();
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorUserProfile;
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 20_000);
