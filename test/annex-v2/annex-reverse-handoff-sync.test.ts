import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import * as https from 'https';
import * as net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Duplex } from 'stream';
import { TLSSocket } from 'tls';
import { expect, it, vi } from 'vitest';
import { decodeControlBody } from '../../src/shared/annex-control-protocol';
import type { OrchestrationControl } from '../../src/shared/orchestration-policy';
import type { DispatchContext } from '../../src/main/services/annex-control';
import { authority, close, desktop, listen, pairedPeer } from './reverse-desktop-fixture';

async function syncDesktop(dir: string) {
  vi.doMock('../../src/main/services/agent-config', () => ({
    agentConfigGeneration: () => 0, peekDurableConfigs: async () => [{ id: 'sender', name: 'Sender' }, { id: 'dispatcher', name: 'Dispatcher' }],
  }));
  vi.doMock('../../src/main/services/project-store', () => ({ peekProjects: async () => [{ id: 'project', path: dir, name: 'Fixture' }] }));
  vi.doMock('../../src/main/services/agent-registry', () => ({ agentRegistry: { get: (): undefined => undefined } }));
  vi.doMock('../../src/main/services/agent-runtime', () => ({ getAgentRuntime: (): undefined => undefined }));
  vi.doMock('../../src/main/services/dispatcher/dispatcher-service', () => ({
    getDispatcherState: () => ({ enabled: true, agentId: 'dispatcher', path: dir, config: { name: 'Dispatcher' } }),
    isDispatcherAgentId: (id: string) => id === 'dispatcher',
  }));
  vi.doMock('../../src/main/services/agent-grants-store', () => ({ getAgentGrantChanges: () => 0, getAgentGrantRevision: () => 0 }));
  vi.doMock('../../src/main/services/agent-grants-service', () => ({
    effectiveAgentGrants: async () => [{ action: 'handoff.offer', target: { kind: 'any' }, mode: 'allow' }],
  }));
  vi.doMock('../../src/main/services/connection-grants-store', () => ({
    onConnectionGrantsChanged: () => () => {}, getConnectionDirection: (): undefined => undefined, localConnectionWakeOn: () => false,
  }));
  vi.doMock('../../src/main/services/clubhouse-mcp/binding-manager', () => ({
    bindingManager: { onChange: () => () => {}, getAllBindings: (): [] => [], getBindingsForAgent: (): [] => [] },
  }));
  vi.doMock('../../src/main/services/clubhouse-mcp/grant-check', () => ({ callerGrants: (): [] => [] }));
  vi.doMock('../../src/main/services/clubhouse-mcp/orchestration-gate', () => ({
    onOrchestrationGateChange: () => () => {}, notifyToolGateChange: () => {},
    isOrchestrationEnabled: () => true, isCrossProjectEnabled: () => true, orchestrationControl: (): OrchestrationControl => 'hands-off',
  }));
  vi.doMock('../../src/main/services/clubhouse-mcp/handoff-permissions', () => ({ handoffAgreementCallApproved: async () => true }));
  vi.doMock('../../src/main/services/handoff-preparations', () => ({
    bindPreparedHandoff: async () => {}, settleHandoffPreparationBinding: () => {}, pruneHandoffPreparations: async () => {},
    preparedSourceForRecord: async () => { throw new Error('No content preparation in sync assembly fixture'); },
  }));
  vi.doMock('../../src/main/services/handoff-worker', async (original) => ({
    ...await original<typeof import('../../src/main/services/handoff-worker')>(),
    HandoffWorker: class { async run() {} async flush() {} async stop() {} },
  }));
  const machine = await desktop(dir);
  const handoff = await import('../../src/main/services/handoff-host');
  return { ...machine, handoff };
}

it('assembles actual hosts, durable agreement and command stores over pinned request-only reverse control', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reverse-handoff-sync-'));
  const aDir = join(root, 'a'), bDir = join(root, 'b'); mkdirSync(aDir); mkdirSync(bDir);
  const target = await syncDesktop(aDir), requester = await syncDesktop(bDir);
  const peerA = pairedPeer(target), peerB = pairedPeer(requester);
  const targetDeps = authority(target), requesterDeps = authority(requester);
  const requests: Array<{ op: unknown; record: { id?: string } | undefined }> = [];
  const inFlight = new Set<DispatchContext>(), subscriptions = new Set<object>(), sockets = new Set<Duplex>();
  let ordinaryHttp = 0; const upgrades: string[] = [];
  const server = https.createServer(requester.tls.createTlsServerOptions(requester.info), (_req, res) => {
    ordinaryHttp++; res.writeHead(404).end();
  });
  const barrier = net.createServer((socket) => socket.destroy());
  let forward: net.Server | undefined;
  try {
    target.peers.addPeer(peerB);
    const blockedPort = await listen(barrier);
    requester.peers.addPeer({ ...peerA, typedHost: `127.0.0.1:${blockedPort}`, typedHostCert: peerA.tlsCertificateFingerprint });
    await close(barrier);
    await expect(new Promise<void>((resolve, reject) => {
      const socket = net.connect(blockedPort, '127.0.0.1');
      socket.once('error', reject); socket.once('connect', () => { socket.destroy(); resolve(); });
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    target.control.setControlTarget({
      authorize: (caller) => target.auth.authorize(caller, targetDeps),
      stillAuthorized: (principal) => target.auth.stillAuthorized(principal, targetDeps),
      dispatch: async (principal, request, context) => {
        expect(principal).toMatchObject({ fingerprint: peerB.fingerprint, pin: peerB.tlsCertificateFingerprint, via: 'reverse' });
        expect(request.path).toBe('/api/v1/network/handoffs'); expect(request.method).toBe('POST');
        if (context.signal.aborted || context.deadline.aborted || !context.linkOpen()) throw new Error('Fixture request retired');
        const body = JSON.parse(decodeControlBody(request.body, request.encoding).toString('utf8'));
        requests.push({ op: body.op, record: body.record }); inFlight.add(context);
        try {
          const record = await target.handoff.receiveNetworkHandoff(principal.fingerprint, body);
          return { complete: true, status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(record)) };
        } finally { inFlight.delete(context); }
      },
      subscribe: () => {
        const owned = {}; subscriptions.add(owned);
        return { close: () => { subscriptions.delete(owned); } };
      },
    });
    requester.control.setInboundAuthority({
      accept: (socket) => {
        if (!(socket instanceof TLSSocket)) return { ok: false, status: 401, error: 'unauthorized', message: 'TLS required' };
        const result = requester.auth.authorizeControlLink({
          fingerprint: requester.tls.extractPeerFingerprint(socket) ?? '',
          pin: requester.tls.extractPeerCertificateFingerprint(socket), via: 'direct',
        }, requesterDeps);
        if (requester.auth.isRefusal(result)) return result;
        return { ok: true, fingerprint: result.fingerprint, pin: result.principal.pin };
      },
      stillAllowed: (fingerprint, pin) => requester.auth.authorizeControlLink({ fingerprint, pin, via: 'direct' }, requesterDeps).ok,
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); }); });
    server.on('upgrade', (request, socket, head) => { upgrades.push(request.url ?? ''); requester.control.handleControlUpgrade(request, socket, head); });
    const port = await listen(server);
    forward = net.createServer((incoming) => {
      const outgoing = net.connect(port, '127.0.0.1');
      for (const socket of [incoming, outgoing]) { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); }); }
      incoming.on('error', () => outgoing.destroy()); outgoing.on('error', () => incoming.destroy());
      incoming.on('close', () => outgoing.destroy()); outgoing.on('close', () => incoming.destroy());
      incoming.pipe(outgoing).pipe(incoming);
    });
    const forwardedPort = await listen(forward);
    requester.client.startClient();
    const connect = async () => {
      target.control.connectTo(peerB.fingerprint, '127.0.0.1', forwardedPort,
        target.tls.createPinnedTlsClientOptions(target.info, { certPem: requester.cert.certPem, fingerprint: peerB.tlsCertificateFingerprint }),
        peerB.tlsCertificateFingerprint);
      await vi.waitFor(() => { expect(requester.client.getControllerReadObservation(peerA.fingerprint).ready).toBe(true); }, { timeout: 10_000, interval: 20 });
      expect(requester.client.isMachineConnected(peerA.fingerprint)).toBe(false);
      expect(requester.client.getSatellite(peerA.fingerprint)?.snapshot).toBeFalsy();
      return requester.control.getAcceptedLinkEpoch(peerA.fingerprint);
    };
    const firstEpoch = await connect();
    process.stdout.write(`ANNEX_REVERSE_HANDOFF_SYNC_READY ${JSON.stringify({
      requester: peerB.fingerprint, target: peerA.fingerprint, requesterPin: peerB.tlsCertificateFingerprint, targetPin: peerA.tlsCertificateFingerprint,
      epoch: firstEpoch, observation: requester.client.getControllerReadObservation(peerA.fingerprint),
      directConnected: requester.client.isMachineConnected(peerA.fingerprint), acceptedSnapshot: !!requester.client.getSatellite(peerA.fingerprint)?.snapshot,
    })}\n`);
    const source = requester.handoff.handoffHost(), destination = target.handoff.handoffHost();
    await Promise.all([source.ready, destination.ready]);
    const sender = requester.handoff.localHandoffAgent('sender');
    const input = { to: { machine: peerA.fingerprint, via: 'dispatcher' as const },
      task: { title: 'Paired sync fixture', brief: 'Explicit finite agreement synchronization, not content transfer or apply.' }, mode: 'worktree' as const };
    const offered = await source.coordinator.offer(input, sender);
    process.stdout.write(`ANNEX_REVERSE_HANDOFF_SYNC_FIRST_OFFER ${JSON.stringify({
      id: offered.id, requests: requests.length, undelivered: source.commands.isUndelivered(offered.id),
      destinationVersion: destination.store.get(offered.id)?.version ?? null,
    })}\n`);
    expect(destination.store.get(offered.id)).toEqual(offered); expect(source.commands.isUndelivered(offered.id)).toBe(false);
    expect(requests).toHaveLength(1);
    const declined = await destination.coordinator.respond(offered.id, target.handoff.localHandoffAgent('dispatcher'), false);
    await source.coordinator.sync(offered.id);
    expect(source.store.get(offered.id)).toEqual(declined); expect(source.commands.acknowledged(offered.id)).toBe(declined.version);
    expect(JSON.parse(readFileSync(join(bDir, 'handoff-commands.json'), 'utf8')).acknowledgements[offered.id]).toBe(declined.version);
    requester.control.closeAll(); target.control.closeAll();
    await vi.waitFor(() => { expect(requester.client.getControllerReadObservation(peerA.fingerprint).ready).toBe(false); });
    const held = await source.coordinator.offer(input, sender);
    expect(destination.store.get(held.id)).toBeUndefined(); expect(source.commands.isUndelivered(held.id)).toBe(true);
    const secondEpoch = await connect();
    expect(secondEpoch).not.toBe(firstEpoch);
    await source.coordinator.sync(held.id);
    expect(destination.store.get(held.id)).toEqual(held); expect(source.commands.isUndelivered(held.id)).toBe(false);
    expect(requests.map((request) => [request.op, request.record?.id])).toEqual([
      ['offer', offered.id], ['offer', offered.id], ['offer', held.id],
    ]);
    expect(ordinaryHttp).toBe(0); expect(upgrades.every((url) => url === '/control')).toBe(true);
    expect(requester.client.getSatellite(peerA.fingerprint)?.snapshot).toBeFalsy();
    process.stdout.write(`ANNEX_REVERSE_HANDOFF_SYNC ${JSON.stringify({
      requester: peerB.fingerprint, target: peerA.fingerprint, requesterPin: peerB.tlsCertificateFingerprint, targetPin: peerA.tlsCertificateFingerprint,
      firstEpoch, secondEpoch, agreements: [offered.id, held.id], terminalVersion: declined.version,
      requests: requests.map((request) => [request.op, request.record?.id]), ordinaryHttp, upgrades,
      directConnected: requester.client.isMachineConnected(peerA.fingerprint), acceptedSnapshot: false,
      fixtureBoundaries: ['positive grant callbacks', 'preparation binding', 'worker', 'provider delivery', 'route dispatch adapter'],
    })}\n`);
  } finally {
    requester.client.stopClient(); target.control.closeAll(); requester.control.closeAll();
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(server), close(forward), close(barrier), requester.handoff.stopHandoffs(), target.handoff.stopHandoffs()]);
    await vi.waitFor(() => { expect(sockets.size).toBe(0); expect(inFlight.size).toBe(0); expect(subscriptions.size).toBe(0); });
    target.headless.disposeAll(); requester.headless.disposeAll(); rmSync(root, { recursive: true, force: true });
    process.stdout.write(`ANNEX_REVERSE_HANDOFF_SYNC_TEARDOWN ${JSON.stringify({
      sockets: sockets.size, inFlight: inFlight.size, subscriptions: subscriptions.size, listener: server.listening, forward: forward?.listening ?? false,
    })}\n`);
  }
}, 30_000);
