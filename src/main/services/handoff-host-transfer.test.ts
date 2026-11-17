import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { transitionHandoff } from '../../shared/handoffs';
import { setOrchestrationEnabled, _resetOrchestrationGateForTesting } from './clubhouse-mcp/orchestration-gate';
const state = vi.hoisted(() => ({
  dir: '', sender: '', receiver: '', asleep: true, wake: vi.fn(), onLocate: () => {}, targetMode: 'allow', wakeMode: 'allow', messageMode: 'allow', dispatcherConnected: true, disabledTools: [] as string[], enabledTools: ['wake_agent'] as string[] | undefined, savedDirection: true, bindingEnabled: ['wake_agent'] as string[] | undefined, bindingDisabled: [] as string[], grantEpoch: 0, configGeneration: 0, policyRevision: 0, onGrants: (_id: string) => {}, machine: Array(16).fill('ab').join(':'), peer: Array(16).fill('cd').join(':'),
  allowed: true, connected: true, online: true, member: true, accepting: true, running: true,
  send: vi.fn(async (_text: string, _options?: unknown) => ({})), create: vi.fn(), extraAgent: undefined as { id: string; name: string } | undefined, participant: (_id: string) => false, post: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => state.dir }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: state.machine }), getOrCreateIdentity: () => ({ fingerprint: state.machine }) }));
vi.mock('./annex-settings', () => ({ getSettings: () => ({ alias: 'this-computer', enableServer: true, networkEnabled: true, acceptHandoffs: state.accepting }), networkEnabled: () => true }));
vi.mock('./annex-peers', () => ({ listPeers: () => [{ fingerprint: state.peer, alias: 'other-computer', role: 'member', kind: 'desktop' }] }));
vi.mock('./annex-client', () => ({ getSatellite: () => ({ snapshot: { dispatcher: { agent: { id: 'remote-dispatcher', name: 'Remote concierge' } } } }), isMachineConnected: () => state.online, postToMachine: (...args: unknown[]) => state.post(...args), onSatelliteConnected: () => () => {} }));
vi.mock('./annex-agent-calls', () => ({ isNetworkComputer: () => state.member }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: () => undefined } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => ({ isRunning: () => state.running, sendMessage: state.send }) }));
vi.mock('./agent-config', () => ({ agentConfigGeneration: () => state.configGeneration, listDurable: async (project: string) => { state.onLocate(); return project === state.receiver ? [{ id: 'receiver', name: 'Receiver' }] : [{ id: 'sender', name: 'Sender' }]; }, peekDurableConfigs: async (project: string) => project === state.sender ? [{ id: 'sender', name: 'Sender' }] : [{ id: 'receiver', name: 'Receiver' }] }));
vi.mock('./project-store', () => ({ list: async () => [{ id: 'destination-project', path: state.receiver }], peekProjects: async () => [{ id: 'source-project', name: 'Source', path: state.sender }, { id: 'destination-project', name: 'Destination', path: state.receiver }] }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: () => ({ enabled: true, agentId: 'dispatcher', path: state.dir, config: { name: 'Dispatcher' } }), isDispatcherAgentId: (id: string) => id === 'dispatcher' }));
vi.mock('./agent-grants-store', () => ({ getAgentGrantRevision: () => String(state.grantEpoch), getAgentGrantChanges: () => ({ revision: state.policyRevision }) }));
vi.mock('./agent-grants-service', () => ({ effectiveAgentGrants: async (_project: string, id: string) => { const grants = state.allowed ? [{ action: 'handoff.offer', target: { kind: 'any' }, mode: 'allow' }, ...(id !== 'receiver' || state.targetMode !== 'off' ? [{ action: 'handoff.accept', target: { kind: 'any' }, mode: id === 'receiver' ? state.targetMode : 'allow' }] : []), { action: 'agent.wake', target: { kind: 'any' }, mode: state.wakeMode }, { action: 'agent.message', target: { kind: 'any' }, mode: state.messageMode }] : []; await Promise.resolve(); state.onGrants(id); return grants; } }));
vi.mock('./connection-grants-store', async () => { const { localWakeOn } = await import('../../shared/connection-grants'); return { onConnectionGrantsChanged: () => () => {}, localConnectionWakeOn: () => state.savedDirection ? localWakeOn({ disabledTools: state.disabledTools, enabledTools: state.enabledTools }) : localWakeOn(undefined, state.bindingEnabled) && !state.bindingDisabled.includes('wake_agent'), getConnectionDirection: (from: { agentId: string }, to: { agentId: string }) => state.connected && !(from.agentId === 'dispatcher' && (!state.savedDirection || to.agentId === 'receiver' && !state.dispatcherConnected)) ? { link: true, disabledTools: from.agentId === 'dispatcher' ? state.disabledTools : [], enabledTools: state.enabledTools } : undefined }; });
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { onChange: () => () => {}, getAllBindings: () => [], getBindingsForAgent: (id: string) => id === 'dispatcher' && !state.savedDirection ? [{ targetKind: 'agent', targetId: 'receiver', enabledTools: state.bindingEnabled, disabledTools: state.bindingDisabled }] : [] } }));
vi.mock('./clubhouse-mcp/grant-check', () => ({ callerGrants: () => [] }));
vi.mock('./clubhouse-mcp/tool-registry', () => ({ callTool: (...args: unknown[]) => state.create(...args), setHandoffParticipantCheck: (check: (id: string) => boolean) => { state.participant = check; } }));
vi.mock('./clubhouse-mcp/handoff-permissions', () => ({ handoffAgreementCallApproved: async () => state.allowed }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ defaultHelperTemplateId: async () => 'person-helper-template' }) }));
vi.mock('./agent-system', () => ({ isAgentRunning: () => !state.asleep, isAgentStopping: () => false, spawnAgent: (...args: unknown[]) => state.wake(...args) }));
vi.mock('./helper-index', () => ({ listHelpersEverywhere: async () => [] }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import { handoffHost, localHandoffAgent, stopHandoffs, defaultHandoffReceivingAgent } from './handoff-host';
import { prepareCallerHandoff, _resetHandoffPreparationsForTesting } from './handoff-preparations';
const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd });
beforeEach(async () => {
  state.dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-live-host-'))); state.sender = path.join(state.dir, 'source'); state.receiver = path.join(state.dir, 'destination'); state.asleep = true;
  const config = path.join(state.dir, 'empty-config'); fs.writeFileSync(config, ''); vi.stubEnv('GIT_CONFIG_GLOBAL', config); vi.stubEnv('GIT_CONFIG_SYSTEM', config); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  _resetHandoffPreparationsForTesting(); _resetOrchestrationGateForTesting(); vi.clearAllMocks();
  state.allowed = true;
  state.targetMode = state.wakeMode = state.messageMode = 'allow'; state.dispatcherConnected = true; state.disabledTools = []; state.enabledTools = ['wake_agent']; state.savedDirection = true; state.bindingEnabled = ['wake_agent']; state.bindingDisabled = []; state.policyRevision = 0; state.configGeneration = 0; state.grantEpoch = 0; state.onGrants = () => {}; state.onLocate = () => {};
  state.wake.mockImplementation(async () => { state.asleep = false; });
  fs.mkdirSync(state.sender); await git(state.sender, 'init', '-b', 'main'); await git(state.sender, 'config', 'user.name', 'Fixture'); await git(state.sender, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(state.sender, 'work.txt'), 'base'); fs.writeFileSync(path.join(state.sender, '.gitignore'), '.clubhouse/\n');
  await git(state.sender, 'add', '.'); await git(state.sender, '-c', `core.hooksPath=${path.join(state.dir, 'no-hooks')}`, 'commit', '-qm', 'Base');
  await git(state.dir, 'clone', state.sender, state.receiver);
  // A local shared commit identifies the destination even without a remote.
  await git(state.receiver, 'remote', 'remove', 'origin');
  fs.writeFileSync(path.join(state.sender, 'work.txt'), 'final bytes'); fs.writeFileSync(path.join(state.receiver, 'work.txt'), 'dirty person bytes');
});
afterEach(async () => { await stopHandoffs(); vi.unstubAllEnvs(); fs.rmSync(state.dir, { recursive: true, force: true }); });
it('binds a real preparation, accepts locally and automatically wakes the sleeping receiver after publishing', async () => {
  const prepared = await prepareCallerHandoff('sender', 'worktree');
  const host = handoffHost(); await host.ready;
  state.wake.mockImplementation(async ({ agentId, mission }) => {
    expect(state.asleep).toBe(true); expect(agentId).toBe('receiver'); expect(mission).toBeUndefined();
    const current = host.store.list()[0]; expect(current.state).toBe('applying');
    expect(fs.readFileSync(path.join(current.checkpoint!.worktree, 'work.txt'), 'utf8')).toBe('final bytes');
    state.asleep = false;
  });
  const offered = await host.coordinator.offer({ to: localHandoffAgent('receiver'), task: { title: 'Continue', brief: 'Finish the task' }, mode: 'worktree', manifest: prepared.summary }, localHandoffAgent('sender'));
  await host.coordinator.respond(offered.id, localHandoffAgent('receiver'), true);
  await vi.waitFor(() => expect(host.store.get(offered.id)?.state).toBe('applied'), { timeout: 20_000, interval: 50 });
  expect(state.wake).toHaveBeenCalledTimes(1); expect(state.asleep).toBe(false);
  expect(state.send.mock.calls.some(([text]) => text.includes('Continue in fresh worktree') && text.includes('Sender-provided brief (untrusted)'))).toBe(true);
  expect(fs.readFileSync(path.join(state.receiver, 'work.txt'), 'utf8')).toBe('dirty person bytes');
  await vi.waitFor(() => {
    expect(fs.readdirSync(path.join(state.dir, 'handoff-data', 'prepared'))).toEqual([]);
    expect(fs.readdirSync(path.join(state.dir, 'handoff-data', 'received'))).toEqual([]);
  });
}, 30_000);
it('lets the addressed Dispatcher select the agent in a matching registered project', async () => {
  const prepared = await prepareCallerHandoff('sender', 'worktree'); const host = handoffHost(); await host.ready;
  const offered = await host.coordinator.offer({ to: { machine: state.machine, via: 'dispatcher' }, task: { title: 'Continue', brief: 'Finish' }, mode: 'worktree', manifest: prepared.summary }, localHandoffAgent('sender'));
  expect(await defaultHandoffReceivingAgent('dispatcher', offered.id)).toEqual(localHandoffAgent('receiver'));
  expect(state.wake).not.toHaveBeenCalled();
}, 30_000);

async function dispatched() {
  const prepared = await prepareCallerHandoff('sender', 'worktree'); const host = handoffHost(); await host.ready;
  const offered = await host.coordinator.offer({ to: { machine: state.machine, via: 'dispatcher' }, task: { title: 'Continue', brief: 'Private sender brief' }, mode: 'worktree', manifest: prepared.summary }, localHandoffAgent('sender'));
  return { host, offered, accept: () => host.coordinator.respond(offered.id, localHandoffAgent('dispatcher'), true, localHandoffAgent('receiver')) };
}
const briefDelivered = () => state.send.mock.calls.some(([text]) => text.includes('Sender-provided brief (untrusted)'));
it.each(['target-off', 'target-ask', 'wake-off', 'wake-ask', 'message-ask', 'disconnected', 'wake-disabled', 'message-disabled'])('refuses Dispatcher-selected %s rights before allocating an apply worktree', async (denial) => {
  const f = await dispatched();
  if (denial.startsWith('target')) state.targetMode = denial === 'target-off' ? 'off' : 'ask';
  if (denial === 'wake-off' || denial === 'wake-ask') state.wakeMode = denial === 'wake-off' ? 'off' : 'ask';
  if (denial === 'message-ask') state.messageMode = 'ask';
  if (denial === 'disconnected') state.dispatcherConnected = false;
  if (denial === 'wake-disabled') state.disabledTools = ['wake_agent'];
  if (denial === 'message-disabled') state.disabledTools = ['send_message'];
  await expect(f.accept()).rejects.toThrow('not authorized');
  expect(f.host.store.get(f.offered.id)?.state).toBe('offered');
  expect(f.host.store.get(f.offered.id)?.acceptance).toBeUndefined();
  expect(() => f.host.coordinator.service.get(f.offered.id, localHandoffAgent('receiver'))).toThrow('unavailable');
  expect(f.host.store.get(f.offered.id)?.checkpoint).toBeUndefined(); expect(state.wake).not.toHaveBeenCalled(); expect(briefDelivered()).toBe(false);
}, 30_000);
it('rechecks target acceptance rights after verification and before applying', async () => {
  const f = await dispatched(); const advance = f.host.coordinator.advance.bind(f.host.coordinator);
  vi.spyOn(f.host.coordinator, 'advance').mockImplementation(async (...args) => { const record = await advance(...args); if (record.state === 'verifying') state.targetMode = 'off'; return record; });
  await f.accept(); await vi.waitFor(() => expect(f.host.store.get(f.offered.id)?.state).toBe('failed'), { timeout: 15_000 });
  expect(f.host.store.get(f.offered.id)?.checkpoint).toBeUndefined(); expect(state.wake).not.toHaveBeenCalled(); expect(briefDelivered()).toBe(false);
}, 30_000);
it.each(['target', 'connection', 'wake'])('rechecks revoked %s rights after real wake configuration lookup, before spawning', async (right) => {
  const f = await dispatched();
  state.onLocate = () => { if (right === 'target') state.targetMode = 'off'; if (right === 'connection') state.dispatcherConnected = false; if (right === 'wake') state.wakeMode = 'off'; };
  await f.accept(); await vi.waitFor(() => expect(f.host.store.get(f.offered.id)?.state).toBe('failed'), { timeout: 15_000 });
  expect(f.host.store.get(f.offered.id)?.checkpoint).toBeDefined(); expect(state.wake).not.toHaveBeenCalled(); expect(briefDelivered()).toBe(false);
}, 30_000);
it.each(['target', 'message'])('rechecks %s rights after wake preparation and never delivers the brief after revocation', async (right) => {
  const f = await dispatched(); state.wake.mockImplementation(async () => { state.asleep = false; if (right === 'target') state.targetMode = 'off'; else state.messageMode = 'off'; });
  await f.accept(); await vi.waitFor(() => expect(f.host.store.get(f.offered.id)?.state).toBe('failed'), { timeout: 15_000 });
  expect(state.wake).toHaveBeenCalledTimes(1); expect(briefDelivered()).toBe(false);
}, 30_000);
it('allows Dispatcher-selected targets only with their own acceptance and the Dispatcher wake/message grants', async () => {
  const f = await dispatched(); await f.accept();
  await vi.waitFor(() => expect(f.host.store.get(f.offered.id)?.state).toBe('applied'), { timeout: 15_000 });
  expect(state.wake).toHaveBeenCalledTimes(1); expect(briefDelivered()).toBe(true);
}, 30_000);

it.each(['absent', 'empty', 'fallback-absent', 'fallback-empty', 'fallback-message-off', 'fallback-wake-disabled'])('refuses a canonical local switch that is %s before acceptance', async (kind) => {
  const f = await dispatched();
  if (kind === 'absent') state.enabledTools = undefined;
  if (kind === 'empty') state.enabledTools = [];
  if (kind.startsWith('fallback')) { state.savedDirection = false; state.bindingEnabled = kind === 'fallback-absent' ? undefined : kind === 'fallback-empty' ? [] : ['wake_agent']; }
  if (kind === 'fallback-message-off') state.bindingDisabled = ['send_message'];
  if (kind === 'fallback-wake-disabled') { state.bindingEnabled = ['wake_agent']; state.bindingDisabled = ['wake_agent']; }
  await expect(f.accept()).rejects.toThrow('not authorized');
  expect(f.host.store.get(f.offered.id)?.acceptance).toBeUndefined(); expect(state.wake).not.toHaveBeenCalled(); expect(briefDelivered()).toBe(false);
}, 30_000);
it('uses the live binding starting switches when no direction is saved', async () => {
  const f = await dispatched(); state.savedDirection = false;
  await f.accept(); await vi.waitFor(() => expect(f.host.store.get(f.offered.id)?.state).toBe('applied'), { timeout: 15_000 });
  expect(briefDelivered()).toBe(true);
}, 30_000);
it.each(['message-switch', 'wake-switch', 'target-grant'])('rejects %s revoked during the final asynchronous Dispatcher grant lookup', async (right) => {
  const f = await dispatched();
  state.wake.mockImplementation(async () => {
    state.asleep = false;
    let lookups = 0;
    state.onGrants = (id) => {
      // First: the accepting Dispatcher's own handoff grant. Second: the
      // selected-target wake/message grant lookup, after the old switch check.
      if (id !== 'dispatcher' || ++lookups !== 2) return;
      if (right === 'message-switch') state.disabledTools = ['send_message'];
      if (right === 'wake-switch') state.enabledTools = [];
      if (right === 'target-grant') { state.targetMode = 'off'; state.policyRevision++; }
    };
  });
  await f.accept(); await vi.waitFor(() => expect(f.host.store.get(f.offered.id)?.state).toBe('failed'), { timeout: 15_000 });
  expect(state.wake).toHaveBeenCalledTimes(1); expect(briefDelivered()).toBe(false);
}, 30_000);

// Real host + real preparation/snapshot/descriptors; only the saved grant
// fixture is controlled. Revoke-and-restore must invalidate the old lease.
it.each(['grant-generation', 'agent-policy-generation', 'orchestration-off', 'orchestration-off-restored', 'cross-project-off-restored', 'grant-revoked'])('P6 host %s changed during a real stat prevents descriptor read', async (reason) => {
  setOrchestrationEnabled('sender', true, { crossProject: true });
  const prepared = await prepareCallerHandoff('sender', 'worktree');
  const host = handoffHost(); await host.ready;
  const offered = await host.coordinator.offer({ to: { machine: state.peer, agentId: 'remote' }, task: { title: 'Continue', brief: 'Finish' }, mode: 'worktree', manifest: prepared.summary }, localHandoffAgent('sender'));
  const receiver = { machine: state.peer, agentId: 'remote' };
  await host.store.transact(offered.id, (record) => transitionHandoff(record!, { state: 'accepted', by: { kind: 'agent', address: receiver }, target: receiver, at: Date.now(), operationId: randomUUID() }, record!.version));
  const handles: import('fs/promises').FileHandle[] = [];
  const open = fs.promises.open.bind(fs.promises);
  const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => { const handle = await open(...args); handles.push(handle); return handle; });
  const request = { op: 'read', id: offered.id, file: 0, offset: 0 };
  try {
    await host.transfer.receive(state.peer, request);
    const pinned = handles.at(-1)!;
    const stat = pinned.stat.bind(pinned);
    let release!: () => void; let enter!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { enter = r; });
    const statSpy = vi.spyOn(pinned, 'stat').mockImplementationOnce((async (...args: unknown[]) => {
      const result = await (stat as (...args: unknown[]) => Promise<unknown>)(...args); enter(); await gate; return result;
    }) as any);
    const read = vi.spyOn(pinned, 'read');
    const pending = host.transfer.receive(state.peer, request).catch((e) => e);
    await entered;
    if (reason === 'grant-generation') state.grantEpoch++;
    else if (reason === 'agent-policy-generation') state.configGeneration++;
    else if (reason === 'grant-revoked') { state.allowed = false; state.grantEpoch++; }
    else if (reason === 'cross-project-off-restored') {
      setOrchestrationEnabled('sender', true, { crossProject: false });
      setOrchestrationEnabled('sender', true, { crossProject: true });
    } else {
      setOrchestrationEnabled('sender', false);
      if (reason === 'orchestration-off-restored') setOrchestrationEnabled('sender', true, { crossProject: true });
    }
    release();
    expect((await pending) instanceof Error).toBe(true); expect(read).not.toHaveBeenCalled();
    statSpy.mockRestore(); read.mockRestore();
  } finally { openSpy.mockRestore(); }
}, 30_000);

it('P6 accepted handoff synchronizes during a real manifest stat, transfers a selected ignored file over 512 KiB, and publishes before wake', async () => {
  const { HandoffService } = await import('./handoff-service');
  const { HandoffWorker } = await import('./handoff-worker');
  const { readHandoffTransferManifest, requestHandoffTransfer } = await import('./handoff-transfer-transport');
  const { HANDOFF_TRANSFER_DEFAULTS } = await import('../../shared/handoff-manifest');
  const large = Buffer.alloc(600 * 1024, 17);
  fs.appendFileSync(path.join(state.sender, '.gitignore'), 'fixtures/\n');
  fs.mkdirSync(path.join(state.sender, 'fixtures'));
  fs.writeFileSync(path.join(state.sender, 'fixtures', 'selected.bin'), large);
  fs.writeFileSync(path.join(state.sender, 'fixtures', 'excluded.bin'), 'not selected');
  const prepared = await prepareCallerHandoff('sender', 'worktree', { include: { ignored: ['fixtures/selected.bin'] } });
  const host = handoffHost(); await host.ready;
  const receiver = { machine: state.peer, agentId: 'receiver' };
  const offered = await host.coordinator.offer({ to: receiver, task: { title: 'Continue', brief: 'Finish' }, mode: 'worktree', manifest: prepared.summary }, localHandoffAgent('sender'));
  // A separate machine owns its own store. Keep only that store in memory;
  // the services, preparation, verification, descriptors, receiver and apply are real.
  let remote: import('../../shared/handoffs').Handoff | undefined;
  const store: import('./handoff-store').HandoffStorage = {
    get: (id) => remote?.id === id ? structuredClone(remote) : undefined,
    list: () => remote ? [structuredClone(remote)] : [],
    transact: async (_id, change) => { remote = await change(remote && structuredClone(remote)); return structuredClone(remote); },
  };
  const service = new HandoffService({ machine: state.peer, store, authorize: async () => true, isDispatcher: () => false });
  await service.receiveOffer(offered, state.machine); await service.respond(offered.id, receiver, true, 1);
  const accepted = store.get(offered.id)!;
  const receive = vi.spyOn(host.transfer, 'receive'); // call through the real service
  const incoming = path.join(state.dir, 'independent-receiver'); fs.mkdirSync(incoming);
  const wake = vi.fn(async (_record, result, admission) => {
    expect(admission()).toBe(true); expect(remote?.state).toBe('applying');
    expect(fs.readFileSync(path.join(result.worktree, 'fixtures', 'selected.bin')).equals(large)).toBe(true);
    expect(fs.existsSync(path.join(result.worktree, 'fixtures', 'excluded.bin'))).toBe(false);
    expect(fs.readFileSync(path.join(state.receiver, 'work.txt'), 'utf8')).toBe('dirty person bytes');
  });
  const worker = new HandoffWorker({ machine: state.peer, records: () => store.list(),
    advance: async (record, update) => {
      const next = await service.advance(record.id, update, record.version);
      await host.coordinator.receive(state.peer, { op: 'snapshot', record: next }); return next;
    },
    authorize: async () => {}, sync: async () => {}, stagingRoot: async () => incoming,
    resolve: async (record) => {
      await readHandoffTransferManifest(record, HANDOFF_TRANSFER_DEFAULTS);
      return { projectId: 'destination-project', projectRoot: state.receiver, bounds: HANDOFF_TRANSFER_DEFAULTS };
    }, request: requestHandoffTransfer, wake,
  });
  const lstat = fs.promises.lstat.bind(fs.promises);
  let release!: () => void; let enter!: () => void; let paused = false;
  const gate = new Promise<void>((r) => { release = r; });
  const entered = new Promise<void>((r) => { enter = r; });
  const statSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (...args: unknown[]) => {
    const stat = await (lstat as (...args: unknown[]) => Promise<unknown>)(...args);
    if (!paused && String(args[0]).includes(`${path.sep}prepared${path.sep}`) && path.basename(String(args[0])) === 'selected.bin') {
      paused = true; enter(); await gate;
    }
    return stat;
  }) as any);
  try {
    const pending = worker.run(offered.id);
    await entered;
    // This is the real sender-side coordinator path that emits the generic
    // tool-list notification while the initial manifest request is in flight.
    await host.coordinator.receive(state.peer, { op: 'snapshot', record: accepted });
    release(); await pending;
    const result = store.get(offered.id)!;
    expect(result.state, JSON.stringify({ state: result.state, failure: result.failure, history: result.history.map((event) => event.state) })).toBe('applied');
    const selected = prepared.manifest.files.findIndex((file) => file.path === 'fixtures/selected.bin');
    const reads = receive.mock.calls.flatMap(([_peer, raw]) => {
      const request = raw as import('../../shared/handoff-transfer').HandoffTransferRequest;
      return request.op === 'read' && request.file === selected ? [request.offset] : [];
    });
    expect(reads).toEqual([0, 256 * 1024, 512 * 1024]); expect(wake).toHaveBeenCalledOnce();
  } finally { release(); statSpy.mockRestore(); receive.mockRestore(); await worker.stop(); }
}, 30_000);
