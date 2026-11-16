import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FederatedRequest } from '../../shared/dispatcher-federation-requests';
const fixture = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.base, isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-runtime/chat-transcript', () => ({
  appendChatEvent: vi.fn(async () => {}), readChatTranscript: vi.fn(async () => []), agentMediaDir: () => fixture.base,
}));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
import { ChatAgentRuntime } from './agent-runtime/chat-runtime';
import { FakeChatDriver } from './agent-runtime/fake-chat-driver';
import { registerChatRuntime, unregisterChatRuntime } from './agent-runtime';
import { FEDERATED_REQUEST_LIMITS } from './dispatcher-federation-requests';
import { startFederationTurnTracking, withFederationInput } from './dispatcher-federation-context';
import { _setLocalWorkStoreForTesting, _settleLocalWorkForTesting, createLocalWorkStore, localCausalInputs, localOutputInputs, withLocalCausalCall } from './dispatcher-federation-local-work';

const LEDGER = 'dispatcher-federation-local-work.json';
const runtimes: ChatAgentRuntime[] = [];
const stops: Array<() => void> = [];
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve)); };
function remote(depth: number, id = 'remote-request'): FederatedRequest {
  return {
    id, direction: 'incoming', callerId: 'controller', targetId: 'controller', machineId: 'other-desktop',
    origin: { machineId: 'other-desktop', machineName: 'Other', agentId: 'remote-controller', agentName: 'Dispatcher' },
    originRequestId: 'origin', localRequestId: `local-${id}`, text: 'Remote work',
    epoch: { sender: 'local-pair', receiver: 'remote-pair' }, cause: { rootId: 'root', depth },
    createdAt: Date.now(), expiresAt: Date.now() + FEDERATED_REQUEST_LIMITS.ttl, delivery: 'delivered', outcome: 'under_way', revision: 0, receivedRevision: 0, duplicates: 0,
  };
}
function desktop(agentId: string) {
  const driver = new FakeChatDriver(); let seq = 0;
  const runtime = new ChatAgentRuntime({ agentId, provider: 'claude-code', driverId: driver.id, cwd: fixture.base, level: 'ask', idleTimeoutMs: 0,
    newId: () => `${agentId}-${++seq}`, startSession: () => driver.start({ agentId, provider: 'claude-code', cwd: fixture.base, binaryPath: '/fake', level: 'ask' }),
  });
  const stopTracking = startFederationTurnTracking(agentId);
  runtimes.push(runtime); registerChatRuntime(runtime); stops.push(stopTracking);
  return { runtime, driver,
    async start() { await runtime.start(); },
    async turn() { driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } }); await flush(); await _settleLocalWorkForTesting(); },
    async end() { driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } }); await flush(); await _settleLocalWorkForTesting(); await flush(); },
  };
}

/** Durable-write counters for the ledger file: each commit is one temp-file fsync followed by one rename over it. */
const disk = { fsyncs: 0, renames: 0 };
function countLedgerWrites() {
  disk.fsyncs = 0; disk.renames = 0;
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    if (String(args[0]).includes(LEDGER)) { const sync = handle.sync.bind(handle); handle.sync = async () => { disk.fsyncs++; await sync(); }; }
    return handle;
  });
  const rename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => { if (String(to).endsWith(LEDGER)) disk.renames++; await rename(from, to); });
}

beforeEach(() => {
  fixture.base = fs.mkdtempSync(path.join(os.tmpdir(), 'federation-local-work-writes-'));
  _setLocalWorkStoreForTesting(createLocalWorkStore());
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.stop(); unregisterChatRuntime(runtime.agentId, runtime); }
  for (const stop of stops.splice(0)) stop();
  await _settleLocalWorkForTesting();
  _setLocalWorkStoreForTesting(); vi.restoreAllMocks(); fs.rmSync(fixture.base, { recursive: true, force: true });
});

describe('durable writes per local round trip', () => {
  async function roundTrips(trips: number) {
    const controller = desktop('controller'); const worker = desktop('worker'); await controller.start(); await worker.start();
    await withFederationInput(remote(3), () => controller.runtime.sendMessage('Remote', { source: 'mcp' })); await controller.turn();
    countLedgerWrites();
    for (let i = 0; i < trips; i++) {
      const taskId = `round-${i}`;
      await withLocalCausalCall('controller', { task_id: taskId }, () => worker.runtime.sendMessage('Do it', { source: 'mcp', taskId })); await worker.turn();
      await controller.end(); await worker.end();
      await withLocalCausalCall('worker', { task_id: taskId }, () => controller.runtime.sendMessage('Done', { source: 'mcp', taskId })); await controller.turn();
    }
    return { controller, worker };
  }
  it('commits the ledger once per send: a record and its checkpoint share one write', async () => {
    await roundTrips(5);
    // Before the record was deferred: 4 per round trip (record, then checkpoint, for each of the two sends).
    console.info(`local-work durable writes over 5 round trips: fsyncs=${disk.fsyncs} renames=${disk.renames}`);
    expect(disk.renames).toBe(5 * 2);
    expect(disk.fsyncs).toBe(disk.renames);
  });
  it('keeps every acknowledged checkpoint durable and the record with it', async () => {
    const { worker } = await roundTrips(2);
    expect(worker.driver.last.sent.length).toBeGreaterThan(0);
    // Nothing is left to write: the checkpoint's write already carried the record.
    const before = disk.renames; await _settleLocalWorkForTesting();
    expect(disk.renames).toBe(before);
    const onDisk = JSON.parse(fs.readFileSync(path.join(fixture.base, LEDGER), 'utf8'));
    expect(onDisk.records).toHaveLength(4);
    expect(Object.keys(onDisk.current).sort()).toEqual(['controller', 'worker']);
    expect(onDisk.currentInputs.controller[0].cause.depth).toBe(3);
  });
  it('restarts with its checkpoints and depth when a crash falls between a record and the checkpoint after it', async () => {
    const controller = desktop('controller'); const worker = desktop('worker'); await controller.start(); await worker.start();
    await withFederationInput(remote(6), () => controller.runtime.sendMessage('Remote', { source: 'mcp' })); await controller.turn();
    await withLocalCausalCall('controller', {}, () => worker.runtime.sendMessage('First', { source: 'mcp', taskId: 'first' })); await worker.turn();
    const disk = () => createLocalWorkStore().get();
    const acknowledged = disk();
    // The next send's record is applied in memory only; the process dies before its checkpoint is written.
    const ledger = createLocalWorkStore();
    await ledger.update((file) => { file.records.push({ id: 'unwritten', sender: 'controller', receiver: 'worker', taskId: 'second', hash: 'h', expiresAt: Date.now() + 60_000, inputs: [remote(6)] }); }, { durable: false });
    expect(ledger.get().records.some((r) => r.id === 'unwritten')).toBe(true);
    expect(disk()).toEqual(acknowledged);
    _setLocalWorkStoreForTesting(createLocalWorkStore()); // restart: the file on disk is all that remains
    expect(disk().records.some((r) => r.id === 'unwritten')).toBe(false);
    expect((await localCausalInputs('worker', undefined, undefined, true)).map((r) => r.cause.depth)).toEqual([6]);
    expect(localOutputInputs('controller', 'worker')[0].cause.depth).toBe(6);
    // The worker's result still returns the original cause, and a resend of the lost send never starts a lower one.
    const resent = await withLocalCausalCall('controller', { task_id: 'second' }, () => localCausalInputs('worker', 'second', 'Second', true));
    expect(Math.min(...resent.map((r) => r.cause.depth))).toBe(6);
    expect((await withLocalCausalCall('worker', { task_id: 'first' }, () => localCausalInputs('controller', 'first', 'First result'))).map((r) => r.cause.depth)).toEqual([6]);
  });
  it('writes a deferred change with the next durable one, and alone if none comes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      countLedgerWrites();
      const ledger = createLocalWorkStore(); const record = (id: string) => (file: ReturnType<typeof ledger.get>) => { file.records.push({ id, sender: 's', receiver: 'r', hash: id, expiresAt: Date.now() + 60_000, inputs: [remote(1, id)] }); };
      await ledger.update(record('a'), { durable: false }); await ledger.update(record('b'), { durable: false });
      expect(disk.renames).toBe(0);
      await ledger.update(record('c'));
      expect(disk.renames).toBe(1);
      expect(createLocalWorkStore().get().records.map((r) => r.id)).toEqual(['a', 'b', 'c']);
      await ledger.update(record('d'), { durable: false });
      expect(createLocalWorkStore().get().records.map((r) => r.id)).toEqual(['a', 'b', 'c']);
      await vi.advanceTimersByTimeAsync(1_500); await ledger.settled();
      expect(disk.renames).toBe(2);
      expect(createLocalWorkStore().get().records.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    } finally { vi.useRealTimers(); }
  });
  it('fails a durable change that cannot be written without losing earlier deferred ones', async () => {
    const ledger = createLocalWorkStore(); const record = (id: string) => (file: ReturnType<typeof ledger.get>) => { file.records.push({ id, sender: 's', receiver: 'r', hash: id, expiresAt: Date.now() + 60_000, inputs: [remote(1, id)] }); };
    await ledger.update(record('kept'), { durable: false });
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk full'));
    await expect(ledger.update(record('refused'))).rejects.toThrow('disk full');
    expect(ledger.get().records.map((r) => r.id)).toEqual(['kept']);
    await ledger.update(record('after'));
    expect(createLocalWorkStore().get().records.map((r) => r.id)).toEqual(['kept', 'after']);
  });
});
