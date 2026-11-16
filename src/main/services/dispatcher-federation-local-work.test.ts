import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FederatedRequest } from '../../shared/dispatcher-federation-requests';
import type { FederationRequestFile } from './dispatcher-federation-requests';
const fixture = vi.hoisted(() => ({ base: '', deferDisk: false, deferred: new Set<() => Promise<void>>() }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.base, isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }));
// A test that sets `fixture.deferDisk` keeps the store's saves in memory and writes the latest file once, at
// `flushDeferredSaves()`. Per-save fsync + rename is the cost of a long run (minutes on a slow Windows disk) and
// is covered by every other test here, which keep the real store.
vi.mock('./settings-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settings-store')>();
  return { ...actual, createSettingsStore: (...args: Parameters<typeof actual.createSettingsStore>) => {
    const real = actual.createSettingsStore(...args); let latest: unknown;
    fixture.deferred.add(async () => { if (latest !== undefined) { const file = latest; latest = undefined; await real.save(file as never); } });
    return { ...real, get: () => (latest ?? real.get()) as never,
      save: async (file: never, precondition?: never) => { if (fixture.deferDisk) latest = structuredClone(file); else { latest = undefined; await real.save(file, precondition); } } };
  } };
});
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-runtime/chat-transcript', () => ({
  appendChatEvent: vi.fn(async () => {}), readChatTranscript: vi.fn(async () => []), agentMediaDir: () => fixture.base,
}));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
const terminal = vi.hoisted(() => ({ write: vi.fn(), paste: vi.fn(async () => {}), submit: vi.fn(async () => {}) }));
vi.mock('./pty-manager', () => ({ isRunning: () => true, isStopping: () => false, write: terminal.write }));
vi.mock('./agent-runtime/pty-input', () => ({ writeChunkedBracketedPaste: terminal.paste, submitAfterPaste: terminal.submit, sleep: async () => {} }));
import { ChatAgentRuntime } from './agent-runtime/chat-runtime';
import { FakeChatDriver } from './agent-runtime/fake-chat-driver';
import { PtyAgentRuntime } from './agent-runtime/pty-runtime';
import { registerChatRuntime, unregisterChatRuntime } from './agent-runtime';
import { createFederatedRequests, FEDERATED_REQUEST_LIMITS } from './dispatcher-federation-requests';
import { federationTurnInputs, startFederationTurnTracking, withFederationInput, withFederationInputs } from './dispatcher-federation-context';
import { _setLocalWorkStoreForTesting, _settleLocalWorkForTesting, activateLocalCausalInput, createLocalWorkStore, localCausalInputs, localOutputInputs, withLocalCausalCall, withLocalCausalInput, LOCAL_WORK_MAX_BYTES } from './dispatcher-federation-local-work';
import { deliverHelperUpdate, flushHelperUpdates, _resetHelperDeliveryForTesting } from './clubhouse-mcp/tools/helper-delivery';
import { forgetHookTurn, publishFromHookEvent } from './app-event-bus';

const runtimes: ChatAgentRuntime[] = [];
const stops: Array<() => void> = [];
const flushDeferredSaves = async () => { for (const write of fixture.deferred) await write(); };
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
  return { runtime, driver, stopTracking,
    async start() { await runtime.start(); },
    async turn() { driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } }); await flush(); await _settleLocalWorkForTesting(); },
    async end() { driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } }); await flush(); await _settleLocalWorkForTesting(); await flush(); },
  };
}
function federation(agentId = 'controller') {
  let file: FederationRequestFile = { version: 1, requests: [], paused: {}, crossings: {} };
  return createFederatedRequests({
    store: { get: () => structuredClone(file), update: async (change) => { const next = structuredClone(file); change(next); file = next; } },
    now: Date.now, inputs: federationTurnInputs, self: () => ({ machineId: 'here', machineName: 'Here', agentId, agentName: 'Dispatcher' }),
    authorized: () => true, epoch: () => ({ sender: 'local-pair', receiver: 'remote-pair' }),
    send: async (_caller, _machine, _target, _envelope, _cause, key) => ({ deliveryId: key }), delivery: () => undefined,
    createLocal: async () => {}, present: async () => {}, record: () => {}, recordLimit: () => {},
  });
}
beforeEach(() => {
  fixture.base = fs.mkdtempSync(path.join(os.tmpdir(), 'federation-local-work-')); fixture.deferDisk = false; fixture.deferred.clear();
  _setLocalWorkStoreForTesting(createLocalWorkStore());
});
afterEach(async () => {
  _resetHelperDeliveryForTesting();
  for (const runtime of runtimes.splice(0)) { await runtime.stop(); unregisterChatRuntime(runtime.agentId, runtime); }
  for (const stop of stops.splice(0)) stop();
  await _settleLocalWorkForTesting();
  _setLocalWorkStoreForTesting(); vi.restoreAllMocks(); fs.rmSync(fixture.base, { recursive: true, force: true });
});
describe('durable local delegation through real chat-runtime/ALS input', () => {
  it('keeps independent assignments independent when their task labels and result text repeat', async () => {
    const controller = desktop('controller'); const worker = desktop('worker'); await controller.start(); await worker.start();
    for (const depth of [6, 0]) {
      await withFederationInput(remote(depth, `independent-${depth}`), () => controller.runtime.sendMessage('Independent input', { source: 'mcp' })); await controller.turn();
      await withLocalCausalCall('controller', {}, () => worker.runtime.sendMessage('Same task text', { source: 'mcp', taskId: 'reused-label' })); await worker.turn();
      expect(Math.max(...federationTurnInputs('worker').map((r) => r.cause.depth))).toBe(depth);
      await controller.end(); await worker.end();
      await withLocalCausalCall('worker', {}, () => controller.runtime.sendMessage('Done', { source: 'mcp', taskId: 'reused-label' })); await controller.turn();
      expect(Math.max(...federationTurnInputs('controller').map((r) => r.cause.depth))).toBe(depth);
      await controller.end();
    }
  });
  it('evicts history at capacity without rejecting sends or losing an assigned result across restart', async () => {
    const controller = desktop('controller'); const worker = desktop('worker'); await controller.start(); await worker.start();
    await withFederationInput(remote(6), () => controller.runtime.sendMessage('Remote', { source: 'mcp' })); await controller.turn();
    await withLocalCausalCall('controller', {}, () => worker.runtime.sendMessage('Assigned', { source: 'mcp', taskId: 'assigned' })); await worker.turn();
    const ledger = createLocalWorkStore();
    await ledger.update((file) => {
      file.records.push({ id: 'oversized-history', sender: 'old', receiver: 'other', hash: 'x'.repeat(LOCAL_WORK_MAX_BYTES), expiresAt: Date.now() + 60_000, inputs: [remote(1)] });
    });
    expect(ledger.get().records.some((r) => r.id === 'oversized-history')).toBe(false);
    await ledger.update((file) => {
      for (let i = 0; i <= FEDERATED_REQUEST_LIMITS.records; i++) file.records.push({ id: `history-${i}`, sender: 'old', receiver: 'other', hash: `${i}`, expiresAt: Date.now() + 60_000, inputs: [remote(1, `history-cause-${i}`)] });
    });
    _setLocalWorkStoreForTesting(createLocalWorkStore());
    expect(createLocalWorkStore().get().records).toHaveLength(FEDERATED_REQUEST_LIMITS.records);
    expect((await localCausalInputs('worker', undefined, undefined, true))[0].cause.depth).toBe(6);
    expect(localOutputInputs('controller', 'worker')[0].cause.depth).toBe(6);
    await withLocalCausalCall('worker', { task_id: 'assigned' }, () => controller.runtime.sendMessage('Result after capacity', { source: 'mcp', taskId: 'assigned' }));
    expect(Buffer.byteLength(fs.readFileSync(path.join(fixture.base, 'dispatcher-federation-local-work.json')))).toBeLessThan(LOCAL_WORK_MAX_BYTES);
  });
  /** `trips` worker round trips in one lineage at realistic text size; the file on disk and a restart must hold the same. */
  async function roundTripsStaySlim(trips: number, deferDisk: boolean) {
    fixture.deferDisk = deferDisk;
    const controller = desktop('controller'); const worker = desktop('worker'); await controller.start(); await worker.start();
    const text = 'PRIVATE_REMOTE_TASK_'.padEnd(8_000, 'x');
    await withFederationInput({ ...remote(3), text }, () => controller.runtime.sendMessage(text, { source: 'mcp' })); await controller.turn();
    for (let i = 0; i < trips; i++) {
      const taskId = `round-${i}`;
      await withLocalCausalCall('controller', { task_id: taskId }, () => worker.runtime.sendMessage(text, { source: 'mcp', taskId })); await worker.turn();
      await controller.end(); await worker.end();
      await withLocalCausalCall('worker', { task_id: taskId }, () => controller.runtime.sendMessage(text, { source: 'mcp', taskId })); await controller.turn();
      expect(federationTurnInputs('controller')).toHaveLength(1);
      expect(federationTurnInputs('controller')[0].cause.depth).toBe(3);
    }
    await flushDeferredSaves(); fixture.deferDisk = false;
    const body = fs.readFileSync(path.join(fixture.base, 'dispatcher-federation-local-work.json'), 'utf8');
    expect(Buffer.byteLength(body)).toBeLessThan(LOCAL_WORK_MAX_BYTES);
    expect(Buffer.byteLength(body)).toBeLessThan(1_000_000);
    expect(body).not.toContain('PRIVATE_REMOTE_TASK_');
    const saved = createLocalWorkStore().get();
    expect(saved.records).toHaveLength(trips * 2);
    expect(saved.records.every((r) => r.inputs.length === 1 && r.inputs[0].localWorkIds?.length === 1 && !('text' in r.inputs[0]))).toBe(true);
    _setLocalWorkStoreForTesting(createLocalWorkStore());
    expect((await localCausalInputs('controller', undefined, undefined, true))[0].cause.depth).toBe(3);
    expect((await federation().offer('controller', 'other-desktop', 'remote-controller', 'long-session', 'Continue')).cause.depth).toBe(4);
  }
  it('keeps real-runtime round trips in one lineage slim and bounded at realistic text size, through every durable save', async () => {
    await roundTripsStaySlim(25, false);
  });
  it('keeps hundreds of real-runtime round trips in one lineage slim and bounded at realistic text size', async () => {
    // Writes the file once at the end instead of fsyncing every save, so a slow disk can't time the run out.
    await roundTripsStaySlim(300, true);
  }, 90_000);
  it('queues a human prompt racing an accepted remote prompt until its actual turn ends', async () => {
    const controller = desktop('controller'); await controller.start();
    await withFederationInput(remote(7), () => controller.runtime.sendMessage('Remote first', { source: 'mcp' }));
    expect((await controller.runtime.sendMessage('Human second', { source: 'user' })).delivery).toBe('queued');
    expect(controller.driver.last.sent).toHaveLength(1);
    await controller.turn();
    await expect(federation().offer('controller', 'other-desktop', 'remote-controller', 'racing', 'Still handling remote')).rejects.toThrow('depth limit');
    await controller.end(); await controller.turn();
    expect(controller.driver.last.sent).toHaveLength(2);
    expect(federationTurnInputs('controller')).toEqual([]);
  });
  it('preserves the deepest cause when a coalesced runtime dispatch exceeds the pending metadata bound', async () => {
    const controller = desktop('controller'); await controller.start();
    await withFederationInputs([remote(7, 'deep'), ...Array.from({ length: 40 }, (_, i) => remote(0, `shallow-${i}`))], () => controller.runtime.sendMessage('Coalesced results', { source: 'mcp' }));
    await controller.turn();
    expect(federationTurnInputs('controller')).toHaveLength(30);
    expect(federationTurnInputs('controller').some((r) => r.id === 'deep')).toBe(true);
    await expect(federation().offer('controller', 'other-desktop', 'remote-controller', 'coalesced', 'Continue results')).rejects.toThrow('depth limit');
  });
  it('delivers a delegated task through the real PTY paste/submit boundary and tracks its later result', async () => {
    const controller = desktop('controller'); await controller.start();
    const worker = new PtyAgentRuntime('terminal-worker'); stops.push(startFederationTurnTracking('terminal-worker'));
    await withFederationInput(remote(5), () => controller.runtime.sendMessage('Remote', { source: 'mcp' })); await controller.turn();
    terminal.submit.mockImplementationOnce(async () => {
      publishFromHookEvent('terminal-worker', { kind: 'pre_tool', rawName: 'UserPromptSubmit' });
      expect(federationTurnInputs('terminal-worker')[0].cause.depth).toBe(5);
    });
    await withLocalCausalCall('controller', { task_id: 'terminal-job' }, () => worker.sendMessage('Task\nWith details', { source: 'mcp', taskId: 'terminal-job' }));
    expect(terminal.paste).toHaveBeenCalledWith('terminal-worker', 'Task\nWith details', expect.any(Number), expect.any(Number), expect.any(Number));
    await controller.end(); publishFromHookEvent('terminal-worker', { kind: 'stop', rawName: 'Stop' });
    await withLocalCausalCall('terminal-worker', { task_id: 'terminal-job' }, () => controller.runtime.sendMessage('Terminal result', { source: 'mcp', taskId: 'terminal-job' })); await controller.turn();
    expect((await federation().offer('controller', 'other-desktop', 'remote-controller', 'terminal-followup', 'Continue')).cause.depth).toBe(6);
    forgetHookTurn('terminal-worker');
  });
  it('persists every steered assignment and preserves it across restart and unrelated steers', async () => {
    const controller = desktop('controller'); const worker = desktop('worker'); await controller.start(); await worker.start();
    await withFederationInput(remote(3, 'first'), () => controller.runtime.sendMessage('Remote', { source: 'mcp' })); await controller.turn();
    await withLocalCausalCall('controller', {}, () => worker.runtime.sendMessage('First task', { source: 'mcp', taskId: 'first' })); await worker.turn();
    await withFederationInput(remote(6, 'second'), () => controller.runtime.sendMessage('More remote work', { source: 'mcp' }));
    await withLocalCausalCall('controller', {}, () => worker.runtime.sendMessage('Second task', { source: 'mcp', taskId: 'second' }));
    await withFederationInputs([], () => worker.runtime.sendMessage('Human steer in the same turn', { source: 'user' }));
    await _settleLocalWorkForTesting();
    _setLocalWorkStoreForTesting(createLocalWorkStore());
    const restored = await localCausalInputs('worker', undefined, undefined, true);
    expect(new Set(restored.map((r) => r.id))).toEqual(new Set(['first', 'second']));
    expect(Math.max(...restored.map((r) => r.cause.depth))).toBe(6);
  });
  it('restores the previous durable assignment after a known refused delivery', async () => {
    const controller = desktop('controller'); const worker = desktop('worker'); await controller.start(); await worker.start();
    await withFederationInput(remote(3, 'first'), () => controller.runtime.sendMessage('Remote', { source: 'mcp' })); await controller.turn();
    await withLocalCausalCall('controller', {}, () => worker.runtime.sendMessage('Original', { source: 'mcp', taskId: 'original' })); await worker.turn(); await worker.end();
    await controller.end(); await withFederationInput(remote(6, 'failed'), () => controller.runtime.sendMessage('Higher', { source: 'mcp' })); await controller.turn();
    vi.spyOn(worker.driver.last, 'send').mockRejectedValueOnce(new Error('Never accepted'));
    await expect(withLocalCausalCall('controller', {}, () => worker.runtime.sendMessage('Failed', { source: 'mcp', taskId: 'failed' }))).rejects.toThrow('Never accepted');
    _setLocalWorkStoreForTesting(createLocalWorkStore());
    expect((await localCausalInputs('worker', undefined, undefined, true)).map((r) => r.id)).toEqual(['first']);
  });
  it('invalidates durable association for a genuine terminal human prompt, while Stop/tool continuation retains it', async () => {
    const controller = desktop('controller'); const worker = desktop('worker'); await controller.start(); await worker.start();
    await withFederationInput(remote(5), () => controller.runtime.sendMessage('Remote', { source: 'mcp' })); await controller.turn();
    await withLocalCausalCall('controller', {}, () => worker.runtime.sendMessage('Task', { source: 'mcp' })); await worker.turn(); await worker.end();
    forgetHookTurn('worker');
    publishFromHookEvent('worker', { kind: 'pre_tool', rawName: 'PreToolUse' });
    publishFromHookEvent('worker', { kind: 'stop', rawName: 'Stop' });
    publishFromHookEvent('worker', { kind: 'pre_tool', rawName: 'PreToolUse' });
    expect((await withLocalCausalCall('worker', {}, () => localCausalInputs('controller', undefined, 'Bound result')))[0].cause.depth).toBe(5);
    publishFromHookEvent('worker', { kind: 'pre_tool', rawName: 'UserPromptSubmit' });
    expect(await withLocalCausalCall('worker', {}, () => localCausalInputs('controller', undefined, 'Human work'))).toEqual([]);
    await activateLocalCausalInput('worker', []); // Await the serialized prompt-hook save before simulating restart.
    _setLocalWorkStoreForTesting(createLocalWorkStore());
    expect(await localCausalInputs('worker', undefined, undefined, true)).toEqual([]);
    forgetHookTurn('worker');
  });
  it('returns a worker result in a later turn with the original cause and increments only on the next remote hop', async () => {
    const controller = desktop('controller'); const worker = desktop('worker');
    await controller.start(); await worker.start();
    await withFederationInput(remote(3), () => controller.runtime.sendMessage('Remote input', { source: 'mcp' })); await controller.turn();
    await withLocalCausalCall('controller', { task_id: 'job' }, () => worker.runtime.sendMessage('Delegate job', { source: 'mcp', taskId: 'job' })); await worker.turn();
    expect(federationTurnInputs('worker')[0].cause.depth).toBe(3);
    await controller.end(); await worker.end();
    await withLocalCausalCall('worker', { task_id: 'job' }, () => controller.runtime.sendMessage('Job done', { source: 'mcp', taskId: 'job' })); await controller.turn();
    const sent = await federation().offer('controller', 'other-desktop', 'remote-controller', 'next', 'Follow up');
    expect(sent.cause).toEqual({ rootId: 'root', depth: 4, parentId: 'remote-request' });
  });
  it('trips a real multi-turn two-desktop loop through local workers at depth eight', async () => {
    const a = desktop('a'); const b = desktop('b'); const aw = desktop('a-worker'); const bw = desktop('b-worker');
    for (const agent of [a, b, aw, bw]) await agent.start();
    const peers = new Map<string, ReturnType<typeof createFederatedRequests>>();
    const make = (local: ReturnType<typeof desktop>, machine: string, other: string) => {
      let file: FederationRequestFile = { version: 1, requests: [], paused: {}, crossings: {} };
      const origin = { machineId: machine, machineName: machine, agentId: local.runtime.agentId, agentName: 'Dispatcher' };
      const api = createFederatedRequests({
        store: { get: () => structuredClone(file), update: async (change) => { const next = structuredClone(file); change(next); file = next; } },
        now: Date.now, inputs: federationTurnInputs, self: () => origin, authorized: () => true,
        epoch: () => ({ sender: 'local-pair', receiver: 'remote-pair' }), delivery: () => undefined, createLocal: async () => {}, record: () => {}, recordLimit: () => {},
        send: async (_caller, _to, _target, envelope, cause, key) => { await peers.get(other)!.receive(origin, other, cause, envelope); return { deliveryId: key }; },
        present: async (r, kind) => { if (kind === 'triage') await withFederationInput(r, () => local.runtime.sendMessage('Remote work', { source: 'mcp' })); },
      });
      peers.set(machine, api); return api;
    };
    const aa = make(a, 'a', 'b'); const bb = make(b, 'b', 'a');
    expect((await aa.offer('a', 'b', 'b', 'initial', 'Start loop')).cause.depth).toBe(0);
    for (let depth = 1; depth <= 8; depth++) {
      const controller = depth % 2 ? b : a; const worker = depth % 2 ? bw : aw;
      const api = depth % 2 ? bb : aa; const other = depth % 2 ? 'a' : 'b';
      await controller.turn();
      const task = `hop-${depth}`;
      await withLocalCausalCall(controller.runtime.agentId, { task_id: task }, () => worker.runtime.sendMessage('Delegate', { source: 'mcp', taskId: task }));
      await worker.turn(); await controller.end(); await worker.end();
      await withLocalCausalCall(worker.runtime.agentId, { task_id: task }, () => controller.runtime.sendMessage('Result', { source: 'mcp', taskId: task })); await controller.turn();
      const offered = api.offer(controller.runtime.agentId, other, other, task, 'Continue the actual result');
      if (depth === 8) await expect(offered).rejects.toThrow('depth limit');
      else expect((await offered).cause.depth).toBe(depth);
      await controller.end();
    }
  });
  it('reloads bound work across restart and sleep/wake, while unrelated local input and spoofed ownership cannot copy it', async () => {
    const controller = desktop('controller'); const worker = desktop('worker'); await controller.start(); await worker.start();
    await withFederationInput(remote(5), () => controller.runtime.sendMessage('Remote', { source: 'mcp' })); await controller.turn();
    await withLocalCausalCall('controller', { task_id: 'job' }, () => worker.runtime.sendMessage('Job', { source: 'mcp', taskId: 'job' })); await worker.turn(); await worker.end();
    await worker.runtime.stop(); worker.stopTracking(); unregisterChatRuntime('worker', worker.runtime);
    _setLocalWorkStoreForTesting(createLocalWorkStore()); // Reopen the exact on-disk records, as after restart.
    expect(await withLocalCausalCall('impostor', { task_id: 'job', cause: remote(0) }, () => localCausalInputs('controller', 'job', 'Spoof'))).toEqual([]);
    const resumed = desktop('worker');
    await withLocalCausalInput('worker', undefined, undefined, () => resumed.start(), true); await resumed.turn();
    expect(federationTurnInputs('worker')[0].cause.depth).toBe(5);
    const result = await withLocalCausalCall('worker', { task_id: 'job' }, () => localCausalInputs('controller', 'job', 'Done'));
    expect(result[0].cause.depth).toBe(5);
    await resumed.end();
    await withFederationInputs([], () => resumed.runtime.sendMessage('Unrelated human task', { source: 'user' })); await resumed.turn();
    expect(await withLocalCausalCall('worker', { task_id: 'job', localWorkIds: result[0].localWorkIds }, () => localCausalInputs('controller', 'job', 'Unrelated result'))).toEqual([]);
  });
  it('propagates through a sub-helper and restores each helper result through the real batched delivery path', async () => {
    const controller = desktop('controller'); const worker = desktop('worker'); const helper = desktop('helper');
    await controller.start(); await worker.start(); await helper.start();
    await withFederationInput(remote(4), () => controller.runtime.sendMessage('Remote', { source: 'mcp' })); await controller.turn();
    await withLocalCausalCall('controller', { task_id: 'job' }, () => worker.runtime.sendMessage('Job', { source: 'mcp', taskId: 'job' })); await worker.turn();
    await withLocalCausalCall('worker', {}, () => helper.runtime.sendMessage('Subtask', { source: 'mcp' })); await helper.turn();
    await controller.end(); await worker.end();
    await withLocalCausalCall('helper', {}, () => deliverHelperUpdate('worker', 'Subtask done', { sender: { agentId: 'helper', name: 'Helper' }, text: 'Done' })); await worker.turn();
    expect(federationTurnInputs('worker').every((r) => r.cause.depth === 4)).toBe(true);
    const pending = withLocalCausalCall('worker', {}, () => deliverHelperUpdate('controller', 'Job done', { sender: { agentId: 'worker', name: 'Worker' }, text: 'Done' }));
    await flush(); await flushHelperUpdates('controller'); await pending; await controller.turn();
    expect((await federation().offer('controller', 'other-desktop', 'remote-controller', 'after-helper', 'Continue')).cause.depth).toBe(5);
  });
  it('expires stored delegation lineage and merges a deeper input on an identical resend', async () => {
    const controller = desktop('controller'); const worker = desktop('worker'); await controller.start(); await worker.start();
    await withFederationInput(remote(1, 'low'), () => controller.runtime.sendMessage('Low', { source: 'mcp' })); await controller.turn();
    await withLocalCausalCall('controller', { task_id: 'job' }, () => worker.runtime.sendMessage('Job', { source: 'mcp', taskId: 'job' })); await worker.turn();
    await withLocalCausalCall('worker', { task_id: 'job' }, () => localCausalInputs('controller', 'job', 'Same result'));
    const high = remote(6, 'high');
    await withFederationInput({ ...high, targetId: 'worker' }, () => worker.runtime.sendMessage('Higher cause', { source: 'mcp' }));
    const resent = await withLocalCausalCall('worker', { task_id: 'job' }, () => localCausalInputs('controller', 'job', 'Same result'));
    expect(Math.max(...resent.map((r) => r.cause.depth))).toBe(6);
    expect(new Set(resent.map((r) => r.id))).toEqual(new Set(['low', 'high']));
    vi.spyOn(Date, 'now').mockReturnValue(high.expiresAt + 1);
    expect(await withLocalCausalCall('worker', { task_id: 'job' }, () => localCausalInputs('controller', 'job', 'Expired'))).toEqual([]);
    expect(createLocalWorkStore().get().records.length).toBeLessThanOrEqual(FEDERATED_REQUEST_LIMITS.records);
    await activateLocalCausalInput('worker', []);
  });
  it('expires each cause independently when one local task combines requests with different TTLs', async () => {
    const controller = desktop('controller'); const worker = desktop('worker'); await controller.start(); await worker.start();
    const now = Date.now(); const short = { ...remote(2, 'short'), expiresAt: now + 1_000 }; const long = { ...remote(6, 'long'), expiresAt: now + 10_000 };
    await withFederationInputs([short, long], () => controller.runtime.sendMessage('Combined work', { source: 'mcp' })); await controller.turn();
    await withLocalCausalCall('controller', {}, () => worker.runtime.sendMessage('Task', { source: 'mcp', taskId: 'combined' })); await worker.turn();
    vi.spyOn(Date, 'now').mockReturnValue(now + 2_000);
    _setLocalWorkStoreForTesting(createLocalWorkStore());
    expect((await localCausalInputs('worker', undefined, undefined, true)).map((r) => r.id)).toEqual(['long']);
    vi.spyOn(Date, 'now').mockReturnValue(now + 11_000);
    expect(await localCausalInputs('worker', undefined, undefined, true)).toEqual([]);
  });
});
