/**
 * Real pinned control, handoff adapter/source/receiver and filesystem proof.
 * Accepted agreements, preparation lookup, route dispatch and agent-grant
 * admission are fixtures; this does not exercise handoff offer/accept/apply UI.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import * as https from 'https';
import * as net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Duplex } from 'stream';
import { TLSSocket } from 'tls';
import { expect, it, vi } from 'vitest';
import { decodeControlBody } from '../../src/shared/annex-control-protocol';
import { canonicalHandoffManifest, HANDOFF_TRANSFER_DEFAULTS, summarizeHandoffManifest, type HandoffWorktreeManifest } from '../../src/shared/handoff-manifest';
import { HANDOFF_CHUNK_BYTES, HANDOFF_TRANSFER_ROUTE, parseHandoffTransferRequest, type HandoffTransferRequest } from '../../src/shared/handoff-transfer';
import type { Handoff } from '../../src/shared/handoffs';
import type { DispatchContext } from '../../src/main/services/annex-control';
import type { HandoffTransferReply } from '../../src/main/services/handoff-transfer-source';
import { authority, close, desktop, listen, pairedPeer } from './reverse-desktop-fixture';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from(Array.from({ length: 600 * 1024 + 17 }, (_, index) => index & 255));

async function handoffDesktop(dir: string) {
  const machine = await desktop(dir);
  const transport = await import('../../src/main/services/handoff-transfer-transport');
  const receiver = await import('../../src/main/services/handoff-transfer-receiver');
  const source = await import('../../src/main/services/handoff-transfer-source');
  const snapshot = await import('../../src/main/services/handoff-snapshot');
  const diagnostics = await import('../../src/shared/handoff-transfer-diagnostics');
  return { ...machine, transport, receiver, source, snapshot, diagnostics };
}

async function createPair(root: string) {
  const aDir = join(root, 'a'), bDir = join(root, 'b');
  mkdirSync(aDir); mkdirSync(bDir);
  const target = await handoffDesktop(aDir);
  const requester = await handoffDesktop(bDir);
  const peerA = pairedPeer(target), peerB = pairedPeer(requester);
  const targetDeps = authority(target), requesterDeps = authority(requester);
  const records = new Map<string, Handoff>();
  const snapshots = new Map<string, { root: string; manifest: HandoffWorktreeManifest }>();
  const artifacts = new Set<Awaited<ReturnType<typeof target.snapshot.openHandoffSnapshotArtifact>>>();
  const received: HandoffTransferRequest[] = [], published: HandoffTransferRequest[] = [];
  const inFlight = new Set<DispatchContext>();
  const releases = new Set<() => void>();
  let beforeReply: ((request: HandoffTransferRequest, context: DispatchContext) => Promise<void>) | undefined;
  let transform: ((reply: HandoffTransferReply) => HandoffTransferReply) | undefined;
  const source = new target.source.HandoffTransferSource({
    machine: peerA.fingerprint,
    record: (id) => records.get(id),
    authorize: async (_record, peer) => {
      if (peer !== peerB.fingerprint || !target.auth.authorize({
        fingerprint: peer, pin: peerB.tlsCertificateFingerprint, via: 'reverse',
      }, targetDeps).ok) throw new Error('Fixture sender admission refused');
    },
    prepared: async (record) => {
      const snapshot = snapshots.get(record.id);
      if (!snapshot) throw new Error('Missing fixture preparation');
      return { snapshot, source: { bounds: HANDOFF_TRANSFER_DEFAULTS } };
    },
    open: async (options) => {
      const artifact = await target.snapshot.openHandoffSnapshotArtifact(options);
      artifacts.add(artifact);
      return { size: artifact.size, read: artifact.read, close: async () => {
        await artifact.close(); artifacts.delete(artifact);
      } };
    },
  });
  target.control.setControlTarget({
    authorize: (caller) => target.auth.authorize(caller, targetDeps),
    stillAuthorized: (principal) => target.auth.stillAuthorized(principal, targetDeps),
    dispatch: async (principal, request, context) => {
      expect(principal).toMatchObject({ fingerprint: peerB.fingerprint, pin: peerB.tlsCertificateFingerprint, via: 'reverse' });
      if (request.path !== HANDOFF_TRANSFER_ROUTE || request.method !== 'POST') {
        return { complete: true, status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      const operation = parseHandoffTransferRequest(JSON.parse(decodeControlBody(request.body).toString('utf8')));
      received.push(operation); inFlight.add(context);
      const beforeRead = () => {
        if (context.signal.aborted || context.deadline.aborted || !context.linkOpen()
          || !target.auth.stillAuthorized(principal, targetDeps)) throw new Error('Fixture request retired');
      };
      try {
        const reply = await source.receive(principal.fingerprint, operation, beforeRead);
        await beforeReply?.(operation, context);
        beforeRead();
        const output = transform ? transform(reply) : reply;
        published.push(operation);
        return { complete: true, status: 200, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify(output)) };
      } catch (error) {
        return { complete: true, status: 400, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ error: 'handoff_transfer_refused', reason: target.diagnostics.handoffTransferDiagnostic(error) })) };
      } finally { inFlight.delete(context); }
    },
    subscribe: (_principal, sink) => {
      sink.send(JSON.stringify({ type: 'snapshot', payload: {
        protocolVersion: 2, lastSeq: 1, projects: [], agents: {}, quickAgents: {},
      } }));
      return { close: () => {} };
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
  const sockets = new Set<Duplex>();
  const upgrades: string[] = [];
  let ordinaryHttp = 0;
  const server = https.createServer(requester.tls.createTlsServerOptions(requester.info), (_req, res) => {
    ordinaryHttp++; res.writeHead(404).end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket); socket.once('close', () => { sockets.delete(socket); });
  });
  server.on('upgrade', (request, socket, head) => {
    upgrades.push(request.url ?? ''); requester.control.handleControlUpgrade(request, socket, head);
  });
  const barrier = net.createServer((socket) => socket.destroy());
  let forward: net.Server | undefined;
  const dispose = async () => {
    for (const release of releases) release();
    requester.client.stopClient(); target.control.closeAll(); requester.control.closeAll();
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(server), close(forward), close(barrier)]);
    await vi.waitFor(() => { expect(sockets.size).toBe(0); expect(inFlight.size).toBe(0); });
    await source.close();
    expect(artifacts.size).toBe(0);
    expect(server.listening).toBe(false); expect(forward?.listening ?? false).toBe(false);
    target.headless.disposeAll(); requester.headless.disposeAll();
    process.stdout.write(`ANNEX_REVERSE_HANDOFF_TEARDOWN ${JSON.stringify({
      sockets: sockets.size, inFlight: inFlight.size, artifacts: artifacts.size,
      serverListening: server.listening, forwardListening: forward?.listening ?? false,
    })}\n`);
  };
  try {
    const blockedPort = await listen(barrier);
    requester.peers.addPeer({ ...peerA, typedHost: `127.0.0.1:${blockedPort}`, typedHostCert: peerA.tlsCertificateFingerprint });
    target.peers.addPeer(peerB);
    const port = await listen(server);
    forward = net.createServer((incoming) => {
      const outgoing = net.connect(port, '127.0.0.1');
      for (const socket of [incoming, outgoing]) {
        sockets.add(socket); socket.once('close', () => { sockets.delete(socket); });
      }
      incoming.on('error', () => outgoing.destroy()); outgoing.on('error', () => incoming.destroy());
      incoming.on('close', () => outgoing.destroy()); outgoing.on('close', () => incoming.destroy());
      incoming.pipe(outgoing).pipe(incoming);
    });
    const forwardedPort = await listen(forward);
    await close(barrier);
    await expect(new Promise<void>((resolve, reject) => {
      const socket = net.connect(blockedPort, '127.0.0.1');
      socket.once('error', reject); socket.once('connect', () => { socket.destroy(); resolve(); });
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    requester.client.startClient();
    const connect = async () => {
      target.control.connectTo(peerB.fingerprint, '127.0.0.1', forwardedPort,
        target.tls.createPinnedTlsClientOptions(target.info, {
          certPem: requester.cert.certPem, fingerprint: peerB.tlsCertificateFingerprint,
        }), peerB.tlsCertificateFingerprint);
      await vi.waitFor(() => expect(requester.control.getLinkReadiness(peerA.fingerprint).acceptedHere).toBe(true),
        { timeout: 10_000, interval: 20 });
      expect(requester.client.isMachineConnected(peerA.fingerprint)).toBe(false);
      const epoch = requester.control.getAcceptedLinkEpoch(peerA.fingerprint);
      process.stdout.write(`ANNEX_REVERSE_HANDOFF_LINK ${JSON.stringify({ epoch, upgrades, ordinaryHttp, directConnected: false })}\n`);
      return epoch;
    };
    const cut = async () => {
      target.control.closeAll();
      await vi.waitFor(() => expect(requester.control.getAcceptedLinkEpoch(peerA.fingerprint)).toBe(0));
    };
    await connect();
    let sequence = 0;
    const register = () => {
      const id = `11111111-1111-4111-8111-${(++sequence).toString(16).padStart(12, '0')}`;
      const name = 'fixtures/selected.bin', outgoing = join(aDir, id), incoming = join(bDir, id);
      mkdirSync(join(outgoing, 'files', 'fixtures'), { recursive: true }); mkdirSync(incoming);
      writeFileSync(join(outgoing, 'files', name), bytes);
      const manifest: HandoffWorktreeManifest = { v: 1,
        repo: { branch: 'main', base: 'a'.repeat(40), remote: null },
        include: { tracked_changes: true, untracked: true, ignored: ['fixtures/*.bin'] },
        exclude: ['**/node_modules/**'], files: [{ path: name, size: bytes.length, mode: '100644', sha256: hash(bytes) }],
        deletions: [], total_bytes: bytes.length, manifest_sha256: 'b'.repeat(64) };
      manifest.manifest_sha256 = hash(canonicalHandoffManifest(manifest));
      const destination = { machine: peerB.fingerprint, agentId: 'receiver' };
      const record: Handoff = { schemaVersion: 1, id, createdAt: 1_795_344_000_000, updatedAt: 1_795_344_000_000,
        version: 2, state: 'accepted', history: [], from: { machine: peerA.fingerprint, agentId: 'sender' },
        to: destination, acceptance: { by: destination, target: destination }, mode: 'worktree',
        task: { title: 'Fixture transfer', brief: 'Verify selected bytes' }, manifest: summarizeHandoffManifest(manifest) };
      records.set(id, record); snapshots.set(id, { root: outgoing, manifest });
      process.stdout.write(`ANNEX_REVERSE_HANDOFF_AGREEMENT ${JSON.stringify({
        record, manifest, sourcePin: peerA.tlsCertificateFingerprint, receiverPin: peerB.tlsCertificateFingerprint,
        operations: ['manifest', 'read'], preparedAndAgentGrantsAreFixtures: true,
      })}\n`);
      const receiverRecord = structuredClone(record), expected = structuredClone(record.manifest!);
      const receive = (progress?: (done: number, total: number) => Promise<void>) => requester.receiver.receiveHandoffSnapshot({
        id, stagingRoot: incoming, expected, bounds: HANDOFF_TRANSFER_DEFAULTS,
        authorize: async () => {
          if (!requester.auth.authorizeControlLink({ fingerprint: peerA.fingerprint, pin: peerA.tlsCertificateFingerprint, via: 'direct' }, requesterDeps).ok) {
            throw new requester.receiver.HandoffTransferRefused('peer_or_link');
          }
        },
        request: (operation) => requester.transport.requestHandoffTransfer(receiverRecord, operation),
        progress,
      });
      return { id, name, manifest, record, expected, receive, staged: join(incoming, id), file: join(incoming, id, 'files', name) };
    };
    return { register, records, source, requester, peerA, received, published, inFlight, artifacts, releases, connect, cut, dispose,
      setBeforeReply: (hook: typeof beforeReply) => { beforeReply = hook; },
      setTransform: (hook: typeof transform) => { transform = hook; },
      assertRoute: () => {
        expect(upgrades.every((path) => path === '/control')).toBe(true); expect(ordinaryHttp).toBe(0);
        process.stdout.write(`ANNEX_REVERSE_HANDOFF_DISPATCH ${JSON.stringify({ received, published, upgrades, ordinaryHttp })}\n`);
      },
    };
  } catch (error) { await dispose(); throw error; }
}

async function withPair(work: (pair: Awaited<ReturnType<typeof createPair>>) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'annex-reverse-handoff-')));
  const priorHome = process.env.HOME, priorProfile = process.env.USERPROFILE;
  process.env.HOME = root; process.env.USERPROFILE = root;
  let pair: Awaited<ReturnType<typeof createPair>> | undefined;
  try { pair = await createPair(root); await work(pair); pair.assertRoute(); }
  finally {
    try { await pair?.dispose(); }
    finally {
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
      rmSync(root, { recursive: true, force: true });
    }
  }
}

it('resumes exact agreement-bound bytes after an actual control cut at the fsynced chunk checkpoint', async () => {
  await withPair(async (pair) => {
    const transfer = pair.register(), agreement = JSON.stringify(transfer.record);
    const epoch = pair.requester.control.getAcceptedLinkEpoch(pair.peerA.fingerprint);
    let checkpoint = false;
    await expect(transfer.receive(async (done) => {
      if (done !== HANDOFF_CHUNK_BYTES || checkpoint) return;
      checkpoint = true;
      // receiveHandoffSnapshot calls progress only after its real handle.sync().
      expect(statSync(transfer.file).size).toBe(HANDOFF_CHUNK_BYTES);
      expect(readFileSync(transfer.file)).toEqual(bytes.subarray(0, HANDOFF_CHUNK_BYTES));
      process.stdout.write(`ANNEX_REVERSE_HANDOFF_CHECKPOINT ${JSON.stringify({
        id: transfer.id, bytes: statSync(transfer.file).size, sha256: hash(readFileSync(transfer.file)), epoch,
        afterRealSyncProgress: true,
      })}\n`);
      await pair.cut();
    })).rejects.toBeInstanceOf(pair.requester.receiver.HandoffTransferInterrupted);
    expect(checkpoint).toBe(true); expect(statSync(transfer.file).size).toBe(HANDOFF_CHUNK_BYTES);
    expect(pair.received).toEqual([{ op: 'manifest', id: transfer.id }, { op: 'read', id: transfer.id, file: 0, offset: 0 }]);
    const before = pair.received.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pair.received).toHaveLength(before);
    const resumedEpoch = await pair.connect();
    expect(resumedEpoch).not.toBe(epoch); expect(resumedEpoch).toBeGreaterThan(0);
    expect(JSON.stringify(pair.records.get(transfer.id))).toBe(agreement);
    const received = await transfer.receive();
    expect(received.manifest).toEqual(transfer.manifest);
    expect(readFileSync(transfer.file)).toEqual(bytes); expect(hash(readFileSync(transfer.file))).toBe(transfer.manifest.files[0].sha256);
    expect(pair.received.slice(before)).toEqual([{ op: 'manifest', id: transfer.id },
      { op: 'read', id: transfer.id, file: 0, offset: HANDOFF_CHUNK_BYTES },
      { op: 'read', id: transfer.id, file: 0, offset: 2 * HANDOFF_CHUNK_BYTES }]);
    expect(bytes.length).toBeGreaterThan(512 * 1024);
    await pair.source.close(transfer.id); expect(pair.artifacts.size).toBe(0);
    process.stdout.write(`ANNEX_REVERSE_HANDOFF_COMPLETE ${JSON.stringify({
      id: transfer.id, bytes: statSync(transfer.file).size, sha256: hash(readFileSync(transfer.file)),
      manifestSha256: received.manifest.manifest_sha256, originalEpoch: epoch, resumedEpoch, explicitResume: true,
    })}\n`);
  });
}, 20_000);

it('refuses a retired sender agreement after a durable chunk and leaves another agreement usable', async () => {
  await withPair(async (pair) => {
    const retired = pair.register(), unrelated = pair.register();
    await expect(retired.receive(async (done) => {
      if (done === HANDOFF_CHUNK_BYTES) pair.records.set(retired.id, { ...retired.record, state: 'cancelled', version: 3 });
    })).rejects.toMatchObject({ diagnostic: 'record_state' });
    expect(existsSync(retired.staged)).toBe(false);
    const reads = pair.published.filter((request) => request.id === retired.id && request.op === 'read');
    expect(reads).toEqual([{ op: 'read', id: retired.id, file: 0, offset: 0 }]);
    await pair.source.close(retired.id);
    await expect(unrelated.receive()).resolves.toMatchObject({ manifest: unrelated.manifest });
    expect(readFileSync(unrelated.file)).toEqual(bytes);
    expect(pair.requester.control.getLinkReadiness(pair.peerA.fingerprint).acceptedHere).toBe(true);
    process.stdout.write(`ANNEX_REVERSE_HANDOFF_RETIRED ${JSON.stringify({
      id: retired.id, diagnostic: 'record_state', allocationRemoved: !existsSync(retired.staged),
      unrelatedId: unrelated.id, unrelatedBytes: statSync(unrelated.file).size, unrelatedSha256: hash(readFileSync(unrelated.file)),
    })}\n`);
  });
}, 20_000);

it.each(['chunk', 'final digest'] as const)('refuses %s corruption and removes receiving bytes', async (kind) => {
  await withPair(async (pair) => {
    const transfer = pair.register();
    pair.setTransform((reply) => {
      if (!('data' in reply)) return reply;
      const altered = Buffer.from(reply.data, 'base64'); altered[0] ^= 1;
      return { ...reply, data: altered.toString('base64'), sha256: kind === 'chunk' ? reply.sha256 : hash(altered) };
    });
    await expect(transfer.receive()).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect(existsSync(transfer.staged)).toBe(false);
    expect(pair.published.filter((request) => request.op === 'read')).toHaveLength(kind === 'chunk' ? 1 : 3);
    await pair.source.close(transfer.id); expect(pair.artifacts.size).toBe(0);
    process.stdout.write(`ANNEX_REVERSE_HANDOFF_CORRUPTION ${JSON.stringify({
      id: transfer.id, kind, code: 'hash_mismatch', allocationRemoved: !existsSync(transfer.staged),
      completedChunkReplies: pair.published.filter((request) => request.op === 'read').length,
      chunkDigestsValid: kind === 'final digest',
    })}\n`);
  });
}, 20_000);

it('never publishes a held old-link reply into a replacement and requires explicit receiver resume', async () => {
  await withPair(async (pair) => {
    const transfer = pair.register(), unrelated = pair.register();
    let context: DispatchContext | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    pair.releases.add(release);
    pair.setBeforeReply(async (request, captured) => {
      if (request.id !== transfer.id || request.op !== 'read') return;
      context = captured; await held;
    });
    const pending = expect(transfer.receive()).rejects.toBeInstanceOf(pair.requester.receiver.HandoffTransferInterrupted);
    await vi.waitFor(() => expect(context).toBeDefined());
    const old = context;
    if (!old) throw new Error('Missing held request');
    await pair.cut(); await pending;
    expect(old.signal.aborted).toBe(true); expect(old.linkOpen()).toBe(false);
    expect(statSync(transfer.file).size).toBe(0);
    const before = pair.published.filter((request) => request.id === transfer.id).length;
    await pair.connect();
    release(); pair.releases.delete(release);
    await vi.waitFor(() => expect(pair.inFlight.size).toBe(0));
    expect(pair.published.filter((request) => request.id === transfer.id)).toHaveLength(before);
    const oldReadRepliesPublished = pair.published.filter((request) => request.id === transfer.id && request.op === 'read').length;
    expect(oldReadRepliesPublished).toBe(0);
    expect(statSync(transfer.file).size).toBe(0);
    pair.setBeforeReply(undefined);
    await expect(unrelated.receive()).resolves.toMatchObject({ manifest: unrelated.manifest });
    expect(statSync(transfer.file).size).toBe(0);
    await expect(transfer.receive()).resolves.toMatchObject({ manifest: transfer.manifest });
    expect(readFileSync(transfer.file)).toEqual(bytes);
    process.stdout.write(`ANNEX_REVERSE_HANDOFF_HELD ${JSON.stringify({
      id: transfer.id, oldSignalAborted: old.signal.aborted, oldLinkOpen: old.linkOpen(),
      oldReadRepliesPublished,
      unrelatedId: unrelated.id, unrelatedSha256: hash(readFileSync(unrelated.file)),
      explicitResumeBytes: statSync(transfer.file).size, explicitResumeSha256: hash(readFileSync(transfer.file)),
    })}\n`);
  });
}, 20_000);
