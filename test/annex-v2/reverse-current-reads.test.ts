import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createInventoryPeer, describeCurrentReadSurfaces, type InventoryPeer, type InventoryPeerInfo,
} from './reverse-inventory-peer';
import {
  assertAcceptAudit, assertDialAudit, closeServer, rpcPeer, sentinel, transparentForward, type RpcPeer,
} from './reverse-parity-fixture';
import * as annexClient from '../../src/main/services/annex-client';
import * as annexControl from '../../src/main/services/annex-control';

describe('current read surfaces with the opposite B to A forward opener', () => {
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
  const status = (who: 'A' | 'B'): Promise<ReturnType<InventoryPeer['status']>> =>
    who === 'A' ? Promise.resolve(a.status()) : b.call('status');

  beforeAll(async () => {
    a = await createInventoryPeer('A');
    ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-reads-ipc-'));
    const ipcPath = process.platform === 'win32' ? `\\\\.\\pipe\\annex-current-reads-${path.basename(ipcDir)}` : path.join(ipcDir, 'p');
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
      connected,
      childExit.then((code): never => { throw new Error(`Current-read peer exited ${code}: ${output}`); }),
      new Promise<never>((_resolve, reject) => { const t = setTimeout(() => reject(new Error(`Current-read peer startup timed out: ${output}`)), 30_000); t.unref(); }),
    ]);
    b = rpcPeer(socket, async (method) => { throw new Error(`Unexpected current-read child request: ${method}`); });
    bInfo = await b.call('info');
    guard = await sentinel();
    forward = await transparentForward(a.info.port);
    await a.configure({ peer: bInfo, routePort: guard.port, forwardPort: null });
    await b.call('configure', { peer: a.info, routePort: forward.port, forwardPort: forward.port });
    await vi.waitFor(async () => {
      expect((await status('B')).readiness?.openedHere).toBe(true);
      expect((await status('A')).readiness?.acceptedHere).toBe(true);
      expect((await status('B')).direct).toBe(true);
      expect((await status('A')).direct).toBe(false);
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
    if (child) {
      expect(await childExit, output).toBe(0);
      console.info('P8 opposite-opener child output\n' + output);
    }
    if (ipcDir) fs.rmSync(ipcDir, { recursive: true, force: true });
  }, 30_000);

  describeCurrentReadSurfaces(() => ({ a, b, bInfo, opener: 'B' }));

  it('rejects a held real reverse Settings response after disconnect and explicit recovery', async () => {
    a.prepareControllerReads();
    await b.call('prepareControllerReads');
    const actualRequest = annexControl.request;
    let received: Awaited<ReturnType<typeof annexControl.request>> | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const settingsPath = `/api/v1/agents/${bInfo.agentId}/settings-details`;
    const observed = vi.spyOn(annexControl, 'request').mockImplementation(async (fingerprint, input, options) => {
      const response = await actualRequest(fingerprint, input, options);
      if (fingerprint.toLowerCase() === bInfo.fingerprint.toLowerCase() && input.path === settingsPath && !received) {
        received = response;
        await held;
      }
      return response;
    });
    const pending = a.agentSettings(bInfo.agentId);
    try {
      await vi.waitFor(() => { expect(received?.status).toBe(200); }, { timeout: 5000, interval: 10 });
      const response = received;
      if (!response) throw new Error('The real Settings response was not observed');
      expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ agentId: bInfo.agentId, readOnly: true });
      annexClient.disconnect(bInfo.fingerprint);
      expect(a.status().connected).toBe(false);
      annexClient.retry(bInfo.fingerprint);
      await vi.waitFor(() => { expect(a.status().connected).toBe(true); });
      expect(a.status().direct).toBe(false);
      release();
      const result = await pending;
      expect(result).toEqual({ status: 'offline' });
      const requests = () => observed.mock.calls.filter(([fingerprint, input]) => fingerprint.toLowerCase() === bInfo.fingerprint.toLowerCase() && input.path === settingsPath);
      expect(requests()).toHaveLength(1);
      const fresh = await a.agentSettings(bInfo.agentId);
      expect(fresh).toMatchObject({ status: 'ok', value: { agentId: bInfo.agentId, readOnly: true } });
      expect(requests()).toHaveLength(2);
      console.info('P8 opposite-opener Settings currentness', JSON.stringify({
        rawStatus: response.status, stale: result, fresh, explicitRequests: requests().length,
        connected: a.status().connected, direct: a.status().direct,
      }));
    } finally {
      release();
      observed.mockRestore();
      a.finishControllerReads();
      await b.call('finishControllerReads');
    }
  }, 15_000);

  it('audits only B dials through F while A remains reverse-only, before fixture close', async () => {
    const aStatus = await status('A'), bStatus = await status('B');
    console.info('P8 opposite-opener pre-close audit', JSON.stringify({
      opener: 'B', a: { attempts: aStatus.attempts, accepts: aStatus.accepts },
      b: { attempts: bStatus.attempts, accepts: bStatus.accepts },
      forward: forward.snapshot(), sentinelAccepts: guard.accepts(),
    }));
    assertDialAudit(aStatus.attempts, null, [], guard.accepts());
    assertDialAudit(bStatus.attempts, { host: '127.0.0.1', port: forward.port }, forward.sourcePorts, guard.accepts());
    assertAcceptAudit(aStatus.accepts, a.info.port, forward.targetSourcePorts);
    assertAcceptAudit(bStatus.accepts, bInfo.port, []);
    expect(forward.targetPorts.length).toBeGreaterThan(0);
    expect(forward.targetPorts.every((port) => port === a.info.port)).toBe(true);
  });
});
