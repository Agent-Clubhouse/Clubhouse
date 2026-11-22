import * as fs from 'fs';
import * as https from 'https';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Duplex } from 'stream';
import { TLSSocket } from 'tls';
import { describe, expect, it, vi } from 'vitest';
import { parseHandoff, transitionHandoff, type Handoff } from '../../src/shared/handoffs';
import type { ControlRequestOptions } from '../../src/main/services/annex-control';
import type { AnnexPrincipal } from '../../src/main/services/annex-authorizer';
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
  const principals: AnnexPrincipal[] = [];
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
    const requesterPin = peerB.tlsCertificateFingerprint;
    if (!requesterPin) throw new Error('Expected an actual pinned requester certificate');
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
    const exchange = (body: Record<string, unknown>, options?: ControlRequestOptions) => own(caller.control.request(peerA.fingerprint, {
      method: 'POST', path: '/api/v1/network/handoffs', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, options));
    const request = (record: Handoff, options?: ControlRequestOptions) => exchange({ op: 'offer', record }, options);
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
        const work = transact(id, (current: Handoff | undefined) => { callbackStarted = true; return change(current); });
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
          const prepared = JSON.parse(await fs.promises.readFile(from, 'utf8'));
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
      request, exchange, connect, holdQueue, holdRename, own, witness, requesterPin, cleanup };
  } catch (error) {
    await cleanup(); throw error;
  }
}

describe('native incoming actual TLS and queue assembly', () => {
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
    expect(pair.host.incoming.size).toBe(1);
    expect(pair.target.control._activeRunsForTesting(pair.peerB.fingerprint, pair.requesterPin)).toBe(1);
    const authorizations = pair.principals.length;
    abort.abort();
    expect(await reply).toMatchObject({ status: 'rejected', error: { code: 'cancelled', indeterminate: true } });
    const replay = pair.request(record, { requestId });
    await vi.waitFor(() => expect(pair.principals.length).toBeGreaterThan(authorizations));
    expect(pair.calls).toHaveLength(1);
    expect(pair.host.incoming.size).toBe(1);
    held.release();
    expect(await replay).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(await pair.calls[0]).toMatchObject({ status: 'fulfilled', value: record });
    expect(pair.host.store.get(record.id)).toEqual(record);
    expect(JSON.parse(await fs.promises.readFile(join(pair.aDir, 'handoffs.json'), 'utf8')).records).toEqual([record]);
    expect(await pair.request(record, { requestId })).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(pair.calls).toHaveLength(1);
    const conflict = await pair.request({ ...record, task: { ...record.task, brief: 'Different immutable request body' } }, { requestId });
    expect(conflict).toMatchObject({ status: 'fulfilled', value: { status: 409 } });
    if (conflict.status !== 'fulfilled') throw new Error('Expected a bounded RPC conflict response');
    expect(JSON.parse(conflict.value.body.toString('utf8'))).toMatchObject({ error: 'request_conflict' });
    expect(pair.calls).toHaveLength(1);
    expect(pair.host.incoming.size).toBe(0);
  } finally { await pair.cleanup(); }
}, 30_000);

it('handles current native history, cancellation and snapshots without reintroducing new-offer permission gates', async () => {
  const pair = await nativePair();
  try {
    const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint);
    expect(await pair.request(record)).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    pair.target.dispatcher.enabled = false;
    expect(await pair.request(record)).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    const cancelled = await pair.exchange({ op: 'cancel', command: { id: record.id, operationId: randomUUID(), from: record.from } });
    expect(cancelled).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(pair.host.store.get(record.id)).toMatchObject({ state: 'cancelled', version: 2 });
    pair.target.dispatcher.enabled = true;
    const unsent = offered(pair.peerB.fingerprint, pair.peerA.fingerprint);
    const command = { id: unsent.id, operationId: randomUUID(), from: unsent.from };
    expect(await pair.exchange({ op: 'cancel', command, record: unsent })).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    const terminal = pair.host.store.get(unsent.id);
    expect(terminal).toMatchObject({ state: 'cancelled', version: 2 });
    pair.target.dispatcher.enabled = false;
    expect(await pair.exchange({ op: 'cancel', command: { ...command, operationId: randomUUID() }, record: unsent }))
      .toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(pair.host.store.get(unsent.id)).toEqual(terminal);
    const outgoing = offered(pair.peerA.fingerprint, pair.peerB.fingerprint);
    await pair.host.store.transact(outgoing.id, () => outgoing);
    const declined = transitionHandoff(outgoing, { state: 'declined', operationId: randomUUID(), at: outgoing.updatedAt + 1,
      by: { kind: 'agent', address: { machine: outgoing.to.machine, agentId: 'fixture-remote-receiver' } } }, 1);
    expect(await pair.exchange({ op: 'snapshot', record: declined })).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(await pair.exchange({ op: 'snapshot', record: outgoing })).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(pair.host.store.get(outgoing.id)).toEqual(declined);
    expect(pair.host.incoming.size).toBe(0);
  } finally { await pair.cleanup(); }
}, 30_000);

it('keeps a deadline-destroyed native result unretained while actual slot, owner and save remain held', async () => {
  const pair = await nativePair();
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    pair.target.control._setTargetTimeoutForTesting(200);
    const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint), requestId = randomUUID();
    const held = pair.holdRename(record), reply = pair.request(record, { requestId, timeoutMs: 10_000 });
    await held.admitted; pair.witness(record);
    await vi.advanceTimersByTimeAsync(200);
    expect(await reply).toMatchObject({ status: 'rejected', error: { code: 'timeout', indeterminate: true } });
    expect(pair.host.incoming.size).toBe(1);
    expect(pair.target.control._activeRunsForTesting(pair.peerB.fingerprint, pair.requesterPin)).toBe(1);
    const replay = pair.request(record, { requestId, timeoutMs: 10_000 });
    held.release();
    expect(await pair.calls[0]).toMatchObject({ status: 'fulfilled', value: record });
    expect(await replay).toMatchObject({ status: 'rejected', error: { code: 'replay_unavailable' } });
    expect(pair.calls).toHaveLength(1);
    expect(pair.host.store.get(record.id)).toEqual(record);
    expect(pair.host.incoming.size).toBe(0);
    expect(pair.target.control._activeRunsForTesting(pair.peerB.fingerprint, pair.requesterPin)).toBe(0);
  } finally {
    pair.target.control._setTargetTimeoutForTesting(null);
    vi.useRealTimers();
    await pair.cleanup();
  }
}, 30_000);

it.each(['before-rename', 'after-real-rename'] as const)(
  'preserves the real native %s IO failure instead of inventing rollback or success', async (stage) => {
    const pair = await nativePair();
    try {
      const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint), rename = fs.promises.rename;
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (to === join(pair.aDir, 'handoffs.json')) {
          if (stage === 'after-real-rename') await rename(from, to);
          throw Object.assign(new Error('Fixture native IO failure'), { code: 'EIO' });
        }
        return rename(from, to);
      });
      expect(await pair.request(record)).toMatchObject({ status: 'fulfilled', value: { status: 400 } });
      expect(await pair.calls[0]).toMatchObject({ status: 'rejected', error: { code: 'EIO' } });
      expect(pair.host.store.get(record.id)).toBeUndefined();
      const file = join(pair.aDir, 'handoffs.json');
      if (stage === 'after-real-rename') expect(JSON.parse(await fs.promises.readFile(file, 'utf8')).records).toEqual([record]);
      else expect(fs.existsSync(file)).toBe(false);
      expect(pair.host.incoming.size).toBe(0);
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
    expect(JSON.parse(await fs.promises.readFile(join(pair.aDir, 'handoffs.json'), 'utf8')).records).toEqual([record]);
  } finally { await pair.cleanup(); }
}, 30_000);

it('normal host stop refuses queued native work and new admissions until actual queued ownership drains', async () => {
  const pair = await nativePair();
  try {
    const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint), held = pair.holdQueue(record);
    const reply = pair.request(record);
    await held.queued; await held.entered; pair.witness(record);
    const stopping = pair.own(pair.target.handoff.stopHandoffs());
    expect(pair.host.incoming.size).toBe(1);
    expect(() => pair.target.handoff.handoffHost()).toThrow('changed');
    const unrelated = offered(pair.peerB.fingerprint, pair.peerA.fingerprint);
    expect(await pair.request(unrelated)).toMatchObject({ status: 'fulfilled', value: { status: 400 } });
    expect(pair.calls).toHaveLength(1);
    held.release();
    expect(await stopping).toMatchObject({ status: 'fulfilled' });
    expect(await pair.calls[0]).toMatchObject({ status: 'rejected' });
    expect(await reply).toMatchObject({ status: 'fulfilled', value: { status: 400 } });
    expect(pair.host.store.get(record.id)).toBeUndefined();
    expect(pair.host.store.get(held.unrelated.id)).toEqual(held.unrelated);
    expect(await pair.request(unrelated)).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(pair.target.handoff.handoffHost().store.get(unrelated.id)).toEqual(unrelated);
  } finally { await pair.cleanup(); }
}, 30_000);

it.each(['pairingId', 'certificatePem', 'unchanged', 'legacy-undefined', 'route', 'alias', 'lastSeen'] as const)(
  'checks canonical native trust at the real held queue for %s-only updates', async (change) => {
    const pair = await nativePair();
    try {
      if (change !== 'legacy-undefined') pair.target.peers.addPeer({ ...pair.peerB, pairingId: 'native-pairing-original' });
      const saved = pair.target.peers.getPeer(pair.peerB.fingerprint);
      if (!saved) throw new Error('Expected the actual saved requester pairing');
      if (change === 'legacy-undefined') expect(saved.pairingId).toBeUndefined();
      const originalTrust = JSON.stringify([pair.target.peers.trustOf(saved), saved.kind]);
      const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint), held = pair.holdQueue(record);
      const reply = pair.request(record);
      await held.queued; await held.entered; pair.witness(record);
      expect(held.started()).toBe(false);
      if (change === 'pairingId') pair.target.peers.addPeer({ ...saved, pairingId: 'native-pairing-replacement' });
      if (change === 'certificatePem') pair.target.peers.addPeer({ ...saved, tlsCertificatePem: pair.target.cert.certPem });
      if (change === 'route') pair.target.peers.addPeer({ ...saved, knownHosts: ['metadata-route.invalid'],
        hostPorts: { 'metadata-route.invalid': 7443 }, mainPort: 7443 });
      if (change === 'alias') pair.target.peers.addPeer({ ...saved, alias: 'Changed fixture display name' });
      if (change === 'lastSeen') pair.target.peers.recordLastSeen(saved.fingerprint, new Date('2030-01-01T00:00:00.000Z'));
      const current = pair.target.peers.getPeer(saved.fingerprint);
      if (!current) throw new Error('Expected the same actual saved requester');
      const changedTrust = change === 'pairingId' || change === 'certificatePem';
      expect(JSON.stringify([pair.target.peers.trustOf(current), current.kind]) !== originalTrust).toBe(changedTrust);
      if (change === 'pairingId') expect({ ...current, pairingId: saved.pairingId }).toEqual(saved);
      if (change === 'certificatePem') expect({ ...current, tlsCertificatePem: saved.tlsCertificatePem }).toEqual(saved);
      expect(pair.target.auth.stillAuthorized(pair.principals[0], authority(pair.target))).toBe(true);
      expect(pair.requester.control.getLinkReadiness(pair.peerA.fingerprint).acceptedHere).toBe(true);
      held.release();
      const result = await pair.calls[0];
      process.stdout.write(`ANNEX_NATIVE_TRUST_QUEUE ${JSON.stringify({
        change, changedTrust, domainOutcome: result.status, storedState: pair.host.store.get(record.id)?.state ?? null,
      })}\n`);
      expect(result.status).toBe(changedTrust ? 'rejected' : 'fulfilled');
      expect(await reply).toMatchObject({ status: 'fulfilled', value: { status: changedTrust ? 400 : 200 } });
      expect(pair.host.store.get(record.id)).toEqual(changedTrust ? undefined : record);
      expect(pair.host.store.get(held.unrelated.id)).toEqual(held.unrelated);
      expect(pair.host.incoming.size).toBe(0);
    } finally { await pair.cleanup(); }
  }, 30_000);

it.each(['pairing-scalar', 'pin-mismatch'] as const)(
  'refuses an original native request after its saved %s changes while the actual queue is held', async (change) => {
    const pair = await nativePair();
    try {
      const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint), held = pair.holdQueue(record);
      const reply = pair.request(record);
      await held.queued; await held.entered; pair.witness(record);
      const pin = pair.requesterPin.startsWith('00:') ? `01:${pair.requesterPin.slice(3)}` : `00:${pair.requesterPin.slice(3)}`;
      pair.target.peers.addPeer({ ...pair.peerB,
        ...(change === 'pairing-scalar' ? { pairedAt: '2026-11-22T00:00:00.000Z' } : { tlsCertificateFingerprint: pin }) });
      expect(pair.target.auth.stillAuthorized(pair.principals[0], authority(pair.target))).toBe(change === 'pairing-scalar');
      held.release();
      expect(await pair.calls[0]).toMatchObject({ status: 'rejected' });
      expect(pair.host.store.get(record.id)).toBeUndefined();
      pair.requester.control.closeAll();
      await reply;
      expect(pair.host.incoming.size).toBe(0);
    } finally { await pair.cleanup(); }
  }, 30_000);

it('does not adopt an original native request across an owned TLS server generation restart', async () => {
  const pair = await nativePair();
  try {
    const record = offered(pair.peerB.fingerprint, pair.peerA.fingerprint), held = pair.holdQueue(record);
    const reply = pair.request(record);
    await held.queued; await held.entered; pair.witness(record);
    pair.target.server.stop();
    expect(pair.host.incoming.size).toBe(1);
    await pair.target.server.startVerified();
    await pair.connect();
    held.release();
    expect(await pair.calls[0]).toMatchObject({ status: 'rejected' });
    expect(pair.host.store.get(record.id)).toBeUndefined();
    expect(await reply).toMatchObject({ status: 'rejected' });
    const fresh = offered(pair.peerB.fingerprint, pair.peerA.fingerprint);
    expect(await pair.request(fresh)).toMatchObject({ status: 'fulfilled', value: { status: 200 } });
    expect(pair.host.store.get(fresh.id)).toEqual(fresh);
  } finally { await pair.cleanup(); }
}, 30_000);
});
