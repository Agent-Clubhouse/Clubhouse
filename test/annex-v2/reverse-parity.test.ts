import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { createHash } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BULLETIN_MESSAGES, BULLETIN_MESSAGE_BYTES, NATIVE_TRANSCRIPT_EVENTS, NATIVE_TRANSCRIPT_EVENT_BYTES,
  createInventoryPeer, LARGE_DIFF_BYTES, type InventoryPeer, type InventoryPeerInfo, type WireAnswer,
} from './reverse-inventory-peer';
import { assertDialAudit, closeServer, rpcPeer, sentinel, transparentForward, type RpcPeer } from './reverse-parity-fixture';

type Status = ReturnType<InventoryPeer['status']>;

describe('full-server audit inventory over one A to B forward', () => {
  let a: InventoryPeer;
  let b: RpcPeer;
  let bInfo: InventoryPeerInfo;
  let child: ChildProcess;
  let childExit: Promise<number | null>;
  let output = '';
  let ipc: net.Server;
  let ipcDir: string;
  let forward: Awaited<ReturnType<typeof transparentForward>>;
  let guard: Awaited<ReturnType<typeof sentinel>>;
  const status = (who: 'A' | 'B'): Promise<Status> => who === 'A' ? Promise.resolve(a.status()) : b.call('status');
  const target = (who: 'A' | 'B') => who === 'A' ? bInfo : a.info;

  beforeAll(async () => {
    a = await createInventoryPeer('A');
    ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-ipc-'));
    const ipcPath = process.platform === 'win32' ? `\\\\.\\pipe\\annex-inventory-${path.basename(ipcDir)}` : path.join(ipcDir, 'p');
    ipc = net.createServer();
    const connected = new Promise<net.Socket>((resolve) => ipc.once('connection', resolve));
    await new Promise<void>((resolve, reject) => { ipc.once('error', reject); ipc.listen(ipcPath, resolve); });
    child = spawn(process.execPath, [
      path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--project', 'integration',
      'test/annex-v2/reverse-inventory-worker.test.ts', '--maxWorkers=1', '--disableConsoleIntercept',
    ], { env: { ...process.env, CLUBHOUSE_ANNEX_INVENTORY_PEER: '1', CLUBHOUSE_ANNEX_INVENTORY_IPC: ipcPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (data) => { output += data.toString(); });
    child.stderr!.on('data', (data) => { output += data.toString(); });
    childExit = new Promise((resolve) => child.once('exit', resolve));
    const socket = await Promise.race([
      connected, childExit.then((code): never => { throw new Error(`Inventory peer exited ${code}: ${output}`); }),
      new Promise<never>((_resolve, reject) => { const t = setTimeout(() => reject(new Error(`Inventory peer startup timed out: ${output}`)), 30_000); t.unref(); }),
    ]);
    b = rpcPeer(socket, async (method) => { throw new Error(`Unexpected inventory child request: ${method}`); });
    bInfo = await b.call('info');
    guard = await sentinel();
    forward = await transparentForward(bInfo.port);
    await b.call('configure', { peer: a.info, routePort: guard.port, forwardPort: null });
    await a.configure({ peer: bInfo, routePort: forward.port, forwardPort: forward.port });
    await vi.waitFor(async () => {
      expect((await status('A')).readiness?.openedHere).toBe(true);
      expect((await status('B')).readiness?.acceptedHere).toBe(true);
      expect((await status('A')).snapshot?.projects[0]).toMatchObject({ id: bInfo.projectId });
      expect((await status('B')).snapshot?.projects[0]).toMatchObject({ id: a.info.projectId });
    }, { timeout: 15_000, interval: 25 });
  }, 60_000);

  afterAll(async () => {
    if (b) await b.call('stop');
    if (a) await a.close();
    b?.close();
    await forward?.close();
    await guard?.close();
    if (ipc) await closeServer(ipc);
    if (child) expect(await childExit, output).toBe(0);
    if (ipcDir) fs.rmSync(ipcDir, { recursive: true, force: true });
  }, 30_000);

  it.each(['A', 'B'] as const)('R08 %s: file adapters reach the production handlers', async (who) => {
    const peer = target(who);
    const tree = who === 'A' ? await a.probe('tree') : await b.call('probe', 'tree');
    expect(tree).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'fixture.txt' })]));
    const file = who === 'A' ? await a.probe('file') : await b.call('probe', 'file');
    expect(file).toBe(`file:${peer.alias}:é\n`);
  });

  it.each(['A', 'B'] as const)('R22 %s: server-only status uses the production route table', async (who) => {
    const request = { method: 'GET' as const, path: '/api/v1/status' };
    const answer: WireAnswer = who === 'A' ? await a.wire(request) : await b.call('wire', request);
    expect(answer.status).toBe(200);
    expect(JSON.parse(Buffer.from(answer.body, 'base64').toString())).toMatchObject({ deviceName: target(who).alias });
  });

  describe('R11: uncapped working-tree Git diff', () => {
    let direct: Awaited<ReturnType<InventoryPeer['gitDiff']>>;
    beforeAll(async () => { a.seedLargeDiff(); await b.call('seedLargeDiff'); });

    const expected = () => ({
      originalBytes: 0, modifiedBytes: LARGE_DIFF_BYTES,
      digest: createHash('sha256').update(Buffer.alloc(LARGE_DIFF_BYTES, 'x')).digest('hex'),
    });

    it('A to B: the direct desktop adapter returns the complete large diff through F', async () => {
      expect((await status('A')).direct).toBe(true);
      direct = await a.gitDiff();
      expect(direct).toEqual(expected());
    });

    it('B to A: the reverse-only desktop adapter returns that same complete diff', async () => {
      expect((await status('B')).direct).toBe(false);
      expect((await status('B')).readiness?.acceptedHere).toBe(true);
      expect(direct).toBeDefined();
      expect(await b.call('gitDiff')).toEqual(direct);
    });
  });

  describe('known uncapped-read findings, retained as RED acceptance probes', () => {
    let aGroup: string;
    let bGroup: string;

    beforeAll(async () => {
      expect(await a.seedLargeTranscript()).toEqual({ rawEvents: NATIVE_TRANSCRIPT_EVENTS });
      expect(await b.call('seedLargeTranscript')).toEqual({ rawEvents: NATIVE_TRANSCRIPT_EVENTS });
      aGroup = await a.seedLargeBoard();
      bGroup = await b.call('seedLargeBoard');
    });

    beforeEach(async () => {
      // An oversized bulk offer retires the link, so each probe starts with an explicit retry.
      a.retryControl();
      await vi.waitFor(async () => {
        expect((await status('A')).readiness?.openedHere).toBe(true);
        expect((await status('B')).readiness?.acceptedHere).toBe(true);
      }, { timeout: 10_000, interval: 25 });
    }, 12_000);

    function assertBulletin(result: Awaited<ReturnType<InventoryPeer['bulletin']>>, kind: 'messages' | 'topic') {
      expect(result.count).toBe(BULLETIN_MESSAGES);
      // The all-message page can also include the host's automatic control notice.
      expect(result.bytes).toBeGreaterThanOrEqual((BULLETIN_MESSAGES - 1) * BULLETIN_MESSAGE_BYTES);
      if (kind === 'topic') expect(result).toEqual({
        count: BULLETIN_MESSAGES, bytes: BULLETIN_MESSAGES * BULLETIN_MESSAGE_BYTES,
        digest: createHash('sha256').update(Buffer.alloc(BULLETIN_MESSAGES * BULLETIN_MESSAGE_BYTES, 'b')).digest('hex'),
      });
    }

    for (const kind of ['messages', 'topic'] as const) {
      it(`F2 ${kind}: direct reads a board containing 100 legitimate 100 KiB posts`, async () => {
        assertBulletin(await a.bulletin({ groupId: bGroup, kind }), kind);
      });

      it(`F2 ${kind}: reverse-only reads the same complete board`, async () => {
        expect((await status('B')).direct).toBe(false);
        assertBulletin(await b.call('bulletin', { groupId: aGroup, kind }), kind);
      });
    }

    const expectedTranscript = () => ({
      count: NATIVE_TRANSCRIPT_EVENTS, totalEvents: NATIVE_TRANSCRIPT_EVENTS,
      bytes: NATIVE_TRANSCRIPT_EVENTS * NATIVE_TRANSCRIPT_EVENT_BYTES,
      digest: createHash('sha256').update(Buffer.alloc(NATIVE_TRANSCRIPT_EVENTS * NATIVE_TRANSCRIPT_EVENT_BYTES, 't')).digest('hex'),
    });

    it('F3: the production native session reader and direct adapter return the complete page', async () => {
      expect(await a.transcript()).toEqual(expectedTranscript());
    });

    it('F3: reverse-only returns that same legitimate native transcript page', async () => {
      expect((await status('B')).direct).toBe(false);
      expect(await b.call('transcript')).toEqual(expectedTranscript());
    });
  });

  it('audits every app dial independently of the direct-dial sentinel', async () => {
    assertDialAudit((await status('A')).attempts, { host: '127.0.0.1', port: forward.port }, forward.sourcePorts, guard.accepts());
    assertDialAudit((await status('B')).attempts, null, [], guard.accepts());
    expect(forward.targetPorts.every((port) => port === bInfo.port)).toBe(true);
  });
});
