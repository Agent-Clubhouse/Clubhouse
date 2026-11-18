import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONSUMER_FAMILIES, createClientPeer, type ClientPeer, type ConsumerFamily, type PeerInfo } from './reverse-client-peer';
import { assertDialAudit, closeServer, rpcPeer, sentinel, transparentForward, type RpcPeer } from './reverse-parity-fixture';

// These honest RED probes are opt-in until the separately reviewed wiring slice.
const probe = it.runIf(process.env.CLUBHOUSE_ANNEX_REVERSE_PROBE === '1');
type Status = ReturnType<ClientPeer['status']>;

describe.each(['A', 'B'] as const)('one forward opened by %s', (opener) => {
  let a: ClientPeer;
  let b: RpcPeer;
  let bInfo: PeerInfo;
  let child: ChildProcess;
  let childExit: Promise<number | null>;
  let childOutput = '';
  let ipc: net.Server;
  let ipcDir: string;
  let forward: Awaited<ReturnType<typeof transparentForward>>;
  let guard: Awaited<ReturnType<typeof sentinel>>;
  const requester = opener === 'A' ? 'B' : 'A';

  const status = (who: 'A' | 'B'): Promise<Status> => who === 'A' ? Promise.resolve(a.status()) : b.call('status');
  const run = (who: 'A' | 'B', family: ConsumerFamily): Promise<unknown> => who === 'A' ? a.probe(family) : b.call('probe', family);
  const targetInfo = (who: 'A' | 'B') => who === 'A' ? bInfo : a.info;

  beforeAll(async () => {
    a = await createClientPeer('A');
    ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-ipc-'));
    const ipcPath = process.platform === 'win32' ? `\\\\.\\pipe\\annex-reverse-${path.basename(ipcDir)}` : path.join(ipcDir, 'p');
    ipc = net.createServer();
    const connection = new Promise<net.Socket>((resolve) => ipc.once('connection', resolve));
    await new Promise<void>((resolve, reject) => { ipc.once('error', reject); ipc.listen(ipcPath, resolve); });
    child = spawn(process.execPath, [
      path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--project', 'integration',
      'test/annex-v2/reverse-parity-peer.test.ts', '--maxWorkers=1', '--disableConsoleIntercept',
    ], {
      env: { ...process.env, CLUBHOUSE_ANNEX_REVERSE_PEER: '1', CLUBHOUSE_ANNEX_REVERSE_PROBE: '', CLUBHOUSE_ANNEX_REVERSE_IPC: ipcPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (data) => { childOutput += data.toString(); });
    child.stderr!.on('data', (data) => { childOutput += data.toString(); });
    childExit = new Promise((resolve) => child.once('exit', resolve));
    const socket = await Promise.race([
      connection,
      childExit.then((code): never => { throw new Error(`Reverse peer exited ${code}: ${childOutput}`); }),
      new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Reverse peer did not connect: ${childOutput}`)), 30_000); timer.unref(); }),
    ]);
    b = rpcPeer(socket, async (method) => { throw new Error(`Unexpected child request: ${method}`); });
    bInfo = await b.call<PeerInfo>('info');
    guard = await sentinel();
    forward = await transparentForward(opener === 'A' ? bInfo.port : a.info.port);
    const aConfig = { peer: bInfo, routePort: opener === 'A' ? forward.port : guard.port, forwardPort: opener === 'A' ? forward.port : null };
    const bConfig = { peer: a.info, routePort: opener === 'B' ? forward.port : guard.port, forwardPort: opener === 'B' ? forward.port : null };
    if (opener === 'A') {
      await b.call('configure', bConfig);
      await a.configure(aConfig);
    } else {
      await a.configure(aConfig);
      await b.call('configure', bConfig);
    }
    await vi.waitFor(async () => {
      expect((await status(requester)).readiness?.acceptedHere).toBe(true);
      expect((await status(opener)).readiness?.openedHere).toBe(true);
      expect((await status(opener)).snapshot?.projects[0]).toMatchObject({ name: requester });
    }, { timeout: 10_000, interval: 25 });
  }, 60_000);

  afterAll(async () => {
    if (b) await b.call('stop');
    if (a) await a.close();
    b?.close();
    await forward?.close();
    await guard?.close();
    if (ipc) await closeServer(ipc);
    if (child) {
      const code = await childExit;
      expect(code, childOutput).toBe(0);
    }
    if (ipcDir) fs.rmSync(ipcDir, { recursive: true, force: true });
  }, 30_000);

  it('calibrates every blocked reverse address, including the real listener and independent sentinel', async () => {
    const info = requester === 'A' ? bInfo : a.info;
    const endpoints = [
      { host: '127.0.0.1', port: info.port }, { host: 'localhost', port: info.port },
      { host: '::1', port: info.port }, { host: '127.0.0.2', port: info.port },
      { host: '::ffff:127.0.0.1', port: info.port }, { host: '127.0.0.1', port: guard.port },
      { host: '127.0.0.1', port: 65535 },
    ];
    const errors = requester === 'A' ? await a.calibrate(endpoints) : await b.call<string[]>('calibrate', endpoints);
    expect(errors).toEqual(endpoints.map(() => 'ERR_REVERSE_DIAL_BLOCKED'));
    expect(guard.accepts()).toBe(0);
  });

  it('proves the authorized reverse request and the sole consumer-owned subscription reach normal IPC', async () => {
    const result = requester === 'A' ? await a.lowLevel() : await b.call('lowLevel');
    expect(result).toMatchObject({
      status: 200, body: { alias: opener },
      frame: { type: 'snapshot', payload: { projects: [{ name: opener }] } },
    });
    expect((await status(opener)).received).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/api/v1/status', caller: requester === 'A' ? a.info.fingerprint : bInfo.fingerprint, via: 'reverse' }),
    ]));
  });

  async function assertConsumer(who: 'A' | 'B', family: ConsumerFamily) {
    const target = targetInfo(who);
    const result = await run(who, family);
    switch (family) {
      case 'history': expect(result).toMatchObject({ marker: `history:${target.alias}` }); break;
      case 'chat send': expect(result).toMatchObject({ status: 'applied', marker: `chat:${target.alias}` }); break;
      case 'subscription':
        expect(result).toMatchObject({
          snapshot: { projects: [{ name: target.alias }] },
          events: expect.arrayContaining([
            expect.objectContaining({
              channel: 'annex-client:satellite-event',
              payload: expect.objectContaining({ satelliteId: target.fingerprint, type: 'snapshot' }),
            }),
            expect.objectContaining({
              channel: 'annex-client:satellite-event',
              payload: expect.objectContaining({ satelliteId: target.fingerprint, type: 'agent:status' }),
            }),
          ]),
        });
        break;
      case 'file read': expect(result).toBe(`file:${target.alias}`); break;
      case 'terminal':
        expect(result).toEqual({ sent: true });
        await vi.waitFor(async () => expect((await status(who === 'A' ? 'B' : 'A')).frames).toContainEqual(
          { type: 'pty:input', payload: { sessionId: 'fixture-shell', data: 'fixture-input' } },
        ));
        break;
      case 'git op': expect(result).toMatchObject({ success: true, marker: `git:${target.alias}` }); break;
      case 'agent call': expect(result).toMatchObject({ content: [{ type: 'text', text: `agent:${target.alias}` }] }); break;
      case 'group-project write':
        expect(result).toMatchObject({ status: 200, body: { results: [{ id: 'probe-write', status: 'applied' }] } });
        break;
      case 'handoff offer': {
        expect(result).toHaveProperty('id');
        const id = (result as { id: string }).id;
        expect(who === 'A' ? await b.call('hasHandoff', id) : a.hasHandoff(id)).toBe(true);
        break;
      }
    }
  }

  it.each(CONSUMER_FAMILIES)('direct baseline through F: %s', async (family) => {
    await assertConsumer(opener, family);
  });

  probe.each(CONSUMER_FAMILIES)('reverse-only actual consumer: %s', async (family) => {
    expect((await status(requester)).readiness?.acceptedHere).toBe(true);
    await assertConsumer(requester, family);
  });

  it('audits every allowed socket against F and every blocked dial independently of the sentinel', async () => {
    const aStatus = await status('A');
    const bStatus = await status('B');
    const allowed = { host: '127.0.0.1', port: forward.port };
    assertDialAudit(aStatus.attempts, opener === 'A' ? allowed : null, opener === 'A' ? forward.sourcePorts : [], guard.accepts());
    assertDialAudit(bStatus.attempts, opener === 'B' ? allowed : null, opener === 'B' ? forward.sourcePorts : [], guard.accepts());
    expect(forward.sourcePorts.length).toBeGreaterThan(0);
    expect(forward.targetPorts.every((port) => port === (opener === 'A' ? bInfo.port : a.info.port))).toBe(true);
  });
});
