import * as fs from 'fs';
import * as https from 'https';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Duplex } from 'stream';
import { TLSSocket } from 'tls';
import { expect, it, vi } from 'vitest';
import { parseHandoff, type Handoff } from '../../src/shared/handoffs';
import type { ControlRequestOptions } from '../../src/main/services/annex-control';
import { authority, close, desktop, listen, pairedPeer } from './reverse-desktop-fixture';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function outcome<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
}

async function nativeDesktop(dir: string) {
  const dispatcher = { enabled: true, agentId: 'dispatcher', path: dir, config: { name: 'Fixture Dispatcher' } };
  const principals: Array<{ fingerprint: string; pin?: string; via: string }> = [];
  vi.doMock('../../src/main/services/annex-authorizer', async (original) => {
    const actual = await original<typeof import('../../src/main/services/annex-authorizer')>();
    return { ...actual, authorize: (...args: Parameters<typeof actual.authorize>) => {
      const result = actual.authorize(...args);
      if (!actual.isRefusal(result) && result.principal.via === 'reverse') principals.push(result.principal);
      return result;
    } };
  });
  vi.doMock('../../src/main/services/dispatcher/dispatcher-service', async (original) => ({
    ...await original<typeof import('../../src/main/services/dispatcher/dispatcher-service')>(),
    getDispatcherState: () => dispatcher,
    isDispatcherAgentId: (id: string) => id === dispatcher.agentId,
  }));
  vi.doMock('../../src/main/services/agent-runtime', async (original) => ({
    ...await original<typeof import('../../src/main/services/agent-runtime')>(),
    getAgentRuntime: (): undefined => undefined,
  }));
  const machine = await desktop(dir);
  const handoff = await import('../../src/main/services/handoff-host');
  const server = await import('../../src/main/services/annex-server');
  return { ...machine, handoff, server, dispatcher, principals };
}

type NativeDesktop = Awaited<ReturnType<typeof nativeDesktop>>;

function offered(from: string, to: string): Handoff {
  const at = Date.now(), sender = { machine: from.toLowerCase(), agentId: 'fixture-sender' };
  return parseHandoff({
    schemaVersion: 1, id: randomUUID(), createdAt: at, updatedAt: at, version: 1,
    from: sender, to: { machine: to.toLowerCase(), via: 'dispatcher' },
    state: 'offered', mode: 'worktree',
    task: { title: 'Native ingress boundary', brief: 'Metadata admission only, not preparation, transfer, apply or wake.' },
    history: [{ operationId: randomUUID(), at, by: { kind: 'agent', address: sender }, state: 'offered' }],
  });
}

async function nativePair() {
  const root = fs.mkdtempSync(join(tmpdir(), 'annex-native-admission-'));
  const aDir = join(root, 'a'), bDir = join(root, 'b'); fs.mkdirSync(aDir); fs.mkdirSync(bDir);
  const sockets = new Set<Duplex>(), releases = new Set<() => void>(), pending = new Set<Promise<unknown>>();
  const own = <T>(work: Promise<T>) => {
    const result = outcome(work); pending.add(result); return result;
  };
  let target: NativeDesktop | undefined, requester: NativeDesktop | undefined;
  let peerServer: https.Server | undefined;
  const cleanup = async () => {
    for (const release of releases) release();
    await Promise.all(pending);
    requester?.client.stopClient();
    target?.server.stop(); requester?.server.stop();
    target?.control.closeAll(); requester?.control.closeAll();
    await Promise.all([target?.handoff.stopHandoffs(), requester?.handoff.stopHandoffs()]);
    for (const socket of sockets) socket.destroy();
    await close(peerServer);
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    target = await nativeDesktop(aDir); requester = await nativeDesktop(bDir);
    const destination = target, caller = requester;
    const peerA = pairedPeer(destination), peerB = pairedPeer(caller);
    destination.peers.addPeer(peerB);
    caller.peers.addPeer(peerA);
    await destination.server.startVerified();
    expect(destination.server.getStatus().port).toBeGreaterThan(0);
    const principals = destination.principals;
    const deps = authority(caller);
    caller.control.setInboundAuthority({
      accept: (socket) => {
        if (!(socket instanceof TLSSocket)) return { ok: false, status: 401, error: 'unauthorized', message: 'TLS required' };
        const result = caller.auth.authorizeControlLink({
          fingerprint: caller.tls.extractPeerFingerprint(socket) ?? '',
          pin: caller.tls.extractPeerCertificateFingerprint(socket), via: 'direct',
        }, deps);
        if (caller.auth.isRefusal(result)) return result;
        return { ok: true, fingerprint: result.fingerprint, pin: result.principal.pin };
      },
      stillAllowed: (fingerprint, pin) => caller.auth.authorizeControlLink({ fingerprint, pin, via: 'direct' }, deps).ok,
    });
    peerServer = https.createServer(caller.tls.createTlsServerOptions(caller.info), (_req, res) => res.writeHead(404).end());
    peerServer.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); }); });
    peerServer.on('upgrade', (request, socket, head) => caller.control.handleControlUpgrade(request, socket, head));
    const peerPort = await listen(peerServer);
    const connect = async () => {
      destination.control.connectTo(peerB.fingerprint, '127.0.0.1', peerPort,
        destination.tls.createPinnedTlsClientOptions(destination.info, { certPem: caller.cert.certPem, fingerprint: peerB.tlsCertificateFingerprint }),
        peerB.tlsCertificateFingerprint);
      await vi.waitFor(() => expect(caller.control.getLinkReadiness(peerA.fingerprint).acceptedHere).toBe(true), { timeout: 10_000, interval: 20 });
      expect(caller.client.isMachineConnected(peerA.fingerprint)).toBe(false);
      expect(destination.client.getControllerReadObservation(peerB.fingerprint).ready).toBe(false);
    };
    await connect();
    const host = destination.handoff.handoffHost(); await host.ready;
    const calls: Array<ReturnType<typeof outcome<Awaited<ReturnType<typeof host.coordinator.receive>>>>> = [];
    const receive = host.coordinator.receive.bind(host.coordinator);
    vi.spyOn(host.coordinator, 'receive').mockImplementation((...args) => {
      const work = receive(...args); calls.push(own(work)); return work;
    });
    const request = (record: Handoff, options?: ControlRequestOptions) => own(caller.control.request(peerA.fingerprint, {
      method: 'POST', path: '/api/v1/network/handoffs', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'offer', record }),
    }, options));
    const holdQueue = (record: Handoff) => {
      const release = barrier(), entered = barrier(), queued = barrier();
      const unrelated = offered(peerA.fingerprint, peerA.fingerprint);
      releases.add(release.release);
      const transact = host.store.transact.bind(host.store);
      let held = false, callbackStarted = false;
      vi.spyOn(host.store, 'transact').mockImplementation((id, change) => {
        if (id !== record.id || held) return transact(id, change);
        held = true;
        own(transact(unrelated.id, async () => { entered.release(); await release.promise; return unrelated; }));
        const work = transact(id, (current) => { callbackStarted = true; return change(current); });
        queued.release(); return work;
      });
      return { ...release, entered: entered.promise, queued: queued.promise, unrelated, started: () => callbackStarted };
    };
    const holdRename = (record: Handoff) => {
      const admitted = barrier(), release = barrier();
      releases.add(release.release);
      const rename = fs.promises.rename;
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (to === join(aDir, 'handoffs.json')) {
          const prepared = JSON.parse(fs.readFileSync(from, 'utf8'));
          if (prepared.records.some((item: { id: string }) => item.id === record.id)) {
            admitted.release(); await release.promise;
          }
        }
        return rename(from, to);
      });
      return { ...release, admitted: admitted.promise };
    };
    const witness = (record: Handoff) => {
      expect(principals).toContainEqual(expect.objectContaining({
        fingerprint: peerB.fingerprint, pin: peerB.tlsCertificateFingerprint, via: 'reverse',
      }));
      process.stdout.write(`ANNEX_NATIVE_INGRESS ${JSON.stringify({
        id: record.id, requester: peerB.fingerprint, target: peerA.fingerprint,
        requesterPin: peerB.tlsCertificateFingerprint, targetPin: peerA.tlsCertificateFingerprint,
        nativeInvocations: calls.length, receiverOutboundReady: destination.client.getControllerReadObservation(peerB.fingerprint).ready,
      })}\n`);
    };
    return { target: destination, requester: caller, host, aDir, peerA, peerB, calls, principals,
      request, connect, holdQueue, holdRename, own, witness, cleanup };
  } catch (error) {
    await cleanup(); throw error;
  }
}

it('admits a current native reverse offer through the real held history queue without receiver outbound readiness', async () => {
  const pair = await nativePair();
  try {
    const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint);
    const held = pair.holdQueue(record), reply = pair.request(record);
    await held.queued; await held.entered; pair.witness(record);
    expect(held.started()).toBe(false); expect(pair.host.store.get(record.id)).toBeUndefined();
    held.release();
    expect(await reply).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(pair.host.store.get(record.id)).toEqual(record);
    expect(pair.host.store.get(held.unrelated.id)).toEqual(held.unrelated);
  } finally { await pair.cleanup(); }
}, 30_000);

it('refuses an original native request retired before actual queue admission even when a new link serves unrelated work', async () => {
  const pair = await nativePair();
  try {
    const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint);
    const held = pair.holdQueue(record), oldReply = pair.request(record);
    await held.queued; await held.entered; pair.witness(record);
    expect(held.started()).toBe(false);
    pair.target.control.closeAll(); pair.requester.control.closeAll();
    expect(await oldReply).toMatchObject({ status: 'rejected' });
    await pair.connect();
    const unrelated = offered(pair.peerB.fingerprint, pair.peerA.fingerprint);
    const newReply = pair.request(unrelated);
    await vi.waitFor(() => expect(pair.calls).toHaveLength(2));
    held.release();
    const original = await pair.calls[0], fresh = await newReply;
    process.stdout.write(`ANNEX_NATIVE_RETIRED_QUEUE ${JSON.stringify({
      id: record.id, originalOutcome: original.status, storedState: pair.host.store.get(record.id)?.state ?? null,
      unrelatedId: unrelated.id, unrelatedOutcome: fresh.status,
    })}\n`);
    expect(pair.host.store.get(record.id)).toBeUndefined();
    expect(original).toMatchObject({ status: 'rejected' });
    expect(fresh).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(pair.host.store.get(unrelated.id)).toEqual(unrelated);
    expect(pair.host.store.get(held.unrelated.id)).toEqual(held.unrelated);
  } finally { await pair.cleanup(); }
}, 30_000);

it('retains native new-offer authorization rather than treating a valid reverse principal as receiver permission', async () => {
  const pair = await nativePair();
  try {
    const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint);
    const held = pair.holdQueue(record), reply = pair.request(record);
    await held.queued; await held.entered; pair.witness(record);
    pair.target.dispatcher.enabled = false; held.release();
    const result = await reply;
    expect(result).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    if (result.status !== 'fulfilled') throw new Error('Expected a native domain refusal receipt');
    expect(JSON.parse(result.value.body.toString('utf8'))).toMatchObject({ kind: 'refused', record: { id: record.id, state: 'failed' } });
    expect(pair.host.store.get(record.id)).toBeUndefined();
  } finally { await pair.cleanup(); }
}, 30_000);

it('keeps an admitted real save truthful after actual cancellation and replays the same RPC key without readmission', async () => {
  const pair = await nativePair();
  try {
    const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint);
    const held = pair.holdRename(record), abort = new AbortController(), requestId = randomUUID();
    const reply = pair.request(record, { requestId, signal: abort.signal });
    await held.admitted; pair.witness(record);
    expect(pair.host.store.get(record.id)).toBeUndefined();
    const authorizations = pair.principals.length;
    abort.abort();
    expect(await reply).toMatchObject({ status: 'rejected', error: { code: 'cancelled', indeterminate: true } });
    const replay = pair.request(record, { requestId });
    await vi.waitFor(() => expect(pair.principals.length).toBeGreaterThan(authorizations));
    expect(pair.calls).toHaveLength(1);
    held.release();
    expect(await replay).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(await pair.calls[0]).toMatchObject({ status: 'fulfilled', value: record });
    expect(pair.host.store.get(record.id)).toEqual(record);
    expect(JSON.parse(fs.readFileSync(join(pair.aDir, 'handoffs.json'), 'utf8')).records).toEqual([record]);
    expect(await pair.request(record, { requestId })).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(pair.calls).toHaveLength(1);
  } finally { await pair.cleanup(); }
}, 30_000);

it('normal host stop retains an admitted incoming writer and refuses replacement until its actual save settles', async () => {
  const pair = await nativePair();
  try {
    const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint);
    const held = pair.holdRename(record), reply = pair.request(record);
    await held.admitted; pair.witness(record);
    const stopped = pair.own(pair.target.handoff.stopHandoffs());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(() => pair.target.handoff.handoffHost()).toThrow('changed');
    held.release();
    expect(await stopped).toMatchObject({ status: 'fulfilled' });
    expect(await pair.calls[0]).toMatchObject({ status: 'fulfilled', value: record });
    expect(await reply).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(pair.host.store.get(record.id)).toEqual(record);
    expect(pair.target.handoff.handoffHost().store.get(record.id)).toEqual(record);
    expect(JSON.parse(fs.readFileSync(join(pair.aDir, 'handoffs.json'), 'utf8')).records).toEqual([record]);
  } finally { await pair.cleanup(); }
}, 30_000);
