import * as fs from 'fs';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HandoffCoordinator } from './handoff-coordinator';
import { HandoffService } from './handoff-service';
import type { HandoffStorage } from './handoff-store';
import { parseHandoff, transitionHandoff, type Handoff } from '../../shared/handoffs';
import type { HandoffOffer } from '../../shared/handoffs';
const state = vi.hoisted(() => ({
  dir: '', machine: Array(16).fill('ab').join(':'), peer: Array(16).fill('cd').join(':'),
  allowed: true, connected: true, online: true, member: true, accepting: true, running: true,
  reverseReady: false, revision: 1, snapshot: true, server: true,
  grantRevision: 0, generation: 0,
  lookup: undefined as (() => Promise<void>) | undefined,
  beforeOperation: undefined as ((signal: AbortSignal) => Promise<void> | void) | undefined,
  connectionListeners: new Set<() => void>(), bindingListeners: new Set<(id: string) => void>(),
  unsubscribed: vi.fn(),
  bindings: [] as Array<{ targetKind: 'agent'; targetId: string; enabledTools: string[]; disabledTools: string[] }>,
  send: vi.fn(async (_text: string, _options?: unknown) => ({})), create: vi.fn(), extraAgent: undefined as { id: string; name: string } | undefined, participant: (_id: string): boolean => false, post: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));
// These cases own lifecycle admission; real transfer/apply is exercised by the worker/fixture-repo tests.
vi.mock('./handoff-worker', async (original) => ({ ...await original<typeof import('./handoff-worker')>(),
  HandoffWorker: class { async run() {} async flush() {} stop() {} },
}));
vi.mock('./handoff-transfer-transport', () => ({ readHandoffTransferManifest: async () => ({ repo: { remote: 'https://example.invalid/project.git', base: 'a'.repeat(40) } }), requestHandoffTransfer: vi.fn() }));
vi.mock('./handoff-snapshot', async (original) => ({ ...await original<typeof import('./handoff-snapshot')>(),
  openHandoffRepository: async () => ({ repo: { remote: 'https://example.invalid/project.git' }, read: async () => Buffer.from('commit') }),
}));
vi.mock('./handoff-preparations', () => ({ bindPreparedHandoff: async () => {}, settleHandoffPreparationBinding: () => {}, pruneHandoffPreparations: async () => {}, preparedSourceForRecord: async () => { throw new Error('No prepared bytes in authorization fixture'); } }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: state.machine }), getOrCreateIdentity: () => ({ fingerprint: state.machine }) }));
vi.mock('./annex-settings', () => ({ getSettings: () => ({ alias: 'this-computer', enableServer: state.server, networkEnabled: true, acceptHandoffs: state.accepting }), networkEnabled: () => true }));
vi.mock('./annex-peers', () => ({ listPeers: () => [{ fingerprint: state.peer, alias: 'other-computer', role: 'member', kind: 'desktop' }] }));
vi.mock('./annex-client', () => ({
  getSatellite: () => state.snapshot ? { snapshot: { dispatcher: { agent: { id: 'remote-dispatcher', name: 'Remote concierge' } } } } : undefined,
  isMachineConnected: () => state.online,
  getControllerReadObservation: () => ({ ready: state.reverseReady, revision: state.revision }),
  postToMachine: (...args: unknown[]) => state.post(...args), onSatelliteConnected: () => () => {},
}));
vi.mock('./annex-agent-calls', () => ({ isNetworkComputer: () => state.member }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: (): undefined => undefined } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => ({ isRunning: () => state.running, sendMessage: state.send }) }));
vi.mock('./agent-config', () => ({ agentConfigGeneration: () => state.generation, peekDurableConfigs: async () => [{ id: 'sender', name: 'Sender' }, { id: 'receiver', name: 'Receiver' }, ...(state.extraAgent ? [state.extraAgent] : [])] }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ id: 'project', name: 'Project', path: state.dir }] }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: () => ({ enabled: true, agentId: 'dispatcher', path: state.dir, config: { name: 'Dispatcher' } }), isDispatcherAgentId: (id: string) => id === 'dispatcher' }));
vi.mock('./agent-grants-store', () => ({ getAgentGrantChanges: () => state.grantRevision, getAgentGrantRevision: () => state.grantRevision }));
vi.mock('./agent-grants-service', () => ({ effectiveAgentGrants: async () => {
  await state.lookup?.();
  return state.allowed ? [{ action: 'handoff.offer', target: { kind: 'any' }, mode: 'allow' }, { action: 'handoff.accept', target: { kind: 'any' }, mode: 'allow' }, { action: 'agent.wake', target: { kind: 'any' }, mode: 'allow' }, { action: 'agent.message', target: { kind: 'any' }, mode: 'allow' }] : [];
} }));
vi.mock('./connection-grants-store', () => ({
  onConnectionGrantsChanged: (listener: () => void) => { state.connectionListeners.add(listener); return () => { state.unsubscribed('connection'); state.connectionListeners.delete(listener); }; },
  localConnectionWakeOn: () => true, getConnectionDirection: (from: { agentId: string }): { link: boolean; disabledTools: string[]; enabledTools: string[] } | undefined => state.connected || from.agentId === 'dispatcher' ? { link: true, disabledTools: [], enabledTools: ['wake_agent'] } : undefined,
}));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: {
  onChange: (listener: (id: string) => void) => { state.bindingListeners.add(listener); return () => { state.unsubscribed('binding'); state.bindingListeners.delete(listener); }; },
  getAllBindings: () => state.bindings, getBindingsForAgent: () => state.bindings,
} }));
vi.mock('./handoff-capacity', async (original) => {
  const actual = await original<typeof import('./handoff-capacity')>();
  return { ...actual, withCapacityDeadline: <T>(operation: (signal: AbortSignal) => Promise<T>) => actual.withCapacityDeadline(async (signal) => {
    await state.beforeOperation?.(signal);
    return operation(signal);
  }) };
});
vi.mock('./clubhouse-mcp/grant-check', () => ({ callerGrants: (): [] => [] }));
vi.mock('./clubhouse-mcp/tool-registry', () => ({ callTool: (...args: unknown[]) => state.create(...args), setHandoffParticipantCheck: (check: (id: string) => boolean) => { state.participant = check; } }));
vi.mock('./clubhouse-mcp/handoff-permissions', () => ({ handoffAgreementCallApproved: async () => state.allowed }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ defaultHelperTemplateId: async () => 'person-helper-template' }) }));
import { setFederationHandoffObserver } from './dispatcher-federation-policy';
import { prepareNewHandoffHelper, handoffHost, localHandoffAgent, receiveNetworkHandoff, resolveHandoffGrantTarget, resolveHandoffTarget, startHandoffs, stopHandoffs } from './handoff-host';
const offer = (): HandoffOffer => ({ to: localHandoffAgent('receiver'), task: { title: 'Continue task', brief: 'Goal and remaining checks.' }, mode: 'worktree' });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function reverse() { state.online = state.snapshot = false; state.reverseReady = true; }
function remoteOffer(): HandoffOffer { return { ...offer(), to: { machine: state.peer, via: 'dispatcher' } }; }
function acceptedCopy(record: Handoff): Handoff {
  const target = { agentId: 'remote-receiver', machine: state.peer };
  return transitionHandoff(record, { state: 'accepted', target, operationId: randomUUID(),
    at: record.updatedAt + 1, by: { kind: 'agent', address: 'agentId' in record.to ? record.to : { agentId: 'dispatcher', machine: state.peer } } }, record.version);
}
beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-host-'));
  state.allowed = state.connected = state.online = state.member = state.accepting = state.running = true;
  state.reverseReady = false; state.revision = 1; state.snapshot = state.server = true;
  state.grantRevision = state.generation = 0; state.lookup = state.beforeOperation = undefined;
  state.connectionListeners.clear(); state.bindingListeners.clear(); state.bindings = [];
  vi.clearAllMocks();
  state.extraAgent = undefined;
});
afterEach(async () => { await stopHandoffs(); fs.rmSync(state.dir, { recursive: true, force: true }); });

it('resolves named agents and computer Dispatcher targets, requiring a connection for normal receivers', async () => {
  expect(await resolveHandoffTarget('Receiver')).toEqual(localHandoffAgent('receiver'));
  expect(await resolveHandoffTarget('Remote concierge@other-computer')).toEqual({ machine: state.peer, via: 'dispatcher' });
  expect(await resolveHandoffTarget('machine:other-computer')).toEqual({ machine: state.peer, via: 'dispatcher' });
  expect(await resolveHandoffTarget('sender@this-computer')).toEqual(localHandoffAgent('sender'));
  state.connected = false;
  await expect(resolveHandoffGrantTarget('sender', { to: 'receiver' })).rejects.toThrow('existing connection');
  expect(await resolveHandoffGrantTarget('sender', { to: 'dispatcher' })).toMatchObject({ isDispatcher: true });
  expect(await resolveHandoffGrantTarget('sender', { to: 'machine:other-computer' })).toMatchObject({ remoteDispatcher: true, isDispatcher: true });
  await expect(resolveHandoffTarget('missing')).rejects.toThrow('unavailable');
});

it('checks metadata before asking for approval and refuses a secret before any durable write', async () => {
  await expect(resolveHandoffGrantTarget('sender', { to: 'receiver', brief: `ghp_${'a'.repeat(36)}` })).rejects.toThrow('secret rules');
  expect(fs.readdirSync(state.dir)).toEqual([]);
  state.allowed = false;
  await expect(handoffHost().coordinator.offer(offer(), localHandoffAgent('sender'))).rejects.toThrow('not authorized');
  expect(handoffHost().store.list()).toEqual([]);
});

it('retains query access after revocation and delivers each notice once across host restart', async () => {
  startHandoffs();
  const record = await handoffHost().coordinator.offer(offer(), localHandoffAgent('sender'));
  expect(state.send).toHaveBeenCalledTimes(1);
  expect(state.send.mock.calls[0][0]).toContain('Sender display name (untrusted): "Sender"');
  expect(state.send.mock.calls[0][0]).toContain('Computer: "this-computer"');
  expect(state.send.mock.calls[0][0]).toContain('Task title (untrusted): "Continue task"');
  expect(state.send.mock.calls[0][0]).not.toContain('From You');
  expect(state.participant('receiver')).toBe(true);
  expect(state.participant('stranger')).toBe(false);
  await stopHandoffs();
  state.allowed = false;
  startHandoffs();
  await vi.waitFor(() => expect(state.participant('receiver')).toBe(true));
  expect(handoffHost().coordinator.service.get(record.id, localHandoffAgent('receiver')).id).toBe(record.id);
  await expect(handoffHost().coordinator.respond(record.id, localHandoffAgent('receiver'), true)).rejects.toThrow('not authorized');
  expect(state.send).toHaveBeenCalledTimes(1);
});

it('blocks new incoming work while disabled but still synchronizes retained decisions and cancellation', async () => {
  const local = await handoffHost().coordinator.offer(offer(), localHandoffAgent('sender'));
  const remoteSender = { agentId: 'remote-sender', machine: state.peer };
  const remote = { ...local, id: randomUUID(), from: remoteSender, history: [{ ...local.history[0], operationId: randomUUID(), by: { kind: 'agent', address: remoteSender } }] };
  await receiveNetworkHandoff(state.peer, { op: 'offer', record: remote });
  state.accepting = false;
  expect(await receiveNetworkHandoff(state.peer, { op: 'offer', record: { ...remote, id: randomUUID() } })).toMatchObject({ kind: 'refused', record: { state: 'failed', failure: { code: 'refused' } } });
  expect(await receiveNetworkHandoff(state.peer, { op: 'offer', record: remote })).toMatchObject({ id: remote.id, state: 'offered' });
  const cancelled = await receiveNetworkHandoff(state.peer, { op: 'cancel', command: { id: remote.id, operationId: randomUUID(), from: remoteSender } });
  expect(cancelled).toMatchObject({ state: 'cancelled' });
  expect(await receiveNetworkHandoff(state.peer, { op: 'offer', record: remote })).toMatchObject({ id: remote.id, state: 'cancelled' });
  state.member = false;
  await expect(receiveNetworkHandoff(state.peer, { op: 'offer', record: remote })).rejects.toThrow('unavailable');
});

it('prepares one asleep managed helper using the normal creation boundary and reuses it after restart', async () => {
  const record = await handoffHost().coordinator.offer({ ...offer(), to: { machine: state.machine, via: 'dispatcher' } }, localHandoffAgent('sender'));
  state.create.mockImplementation(async (_actor, _tool, args) => {
    state.extraAgent = { id: 'new-agent', name: args.name };
    return { content: [{ type: 'text', text: JSON.stringify({ id: 'new-agent', name: args.name, agentStarted: false }) }] };
  });
  expect(await prepareNewHandoffHelper('dispatcher', record.id)).toEqual(localHandoffAgent('new-agent'));
  expect(state.create).toHaveBeenCalledWith('dispatcher', 'create_managed_agent', { name: `handoff-${record.id}`, project: state.dir, templateId: 'person-helper-template', connectToDispatcher: true });
  await stopHandoffs();
  expect(await prepareNewHandoffHelper('dispatcher', record.id)).toEqual(localHandoffAgent('new-agent'));
  expect(state.create).toHaveBeenCalledTimes(1);
  state.allowed = false;
  await expect(prepareNewHandoffHelper('dispatcher', record.id)).rejects.toThrow('not authorized');
  expect(state.create).toHaveBeenCalledTimes(1);
});


it.each(['Receiver', 'new_helper'])('routes machine:<name> to a remote Dispatcher that accepts with %s', async (choice) => {
  const localMachine = state.machine; const remoteMachine = state.peer;
  state.machine = remoteMachine; state.peer = localMachine;
  const to = await resolveHandoffTarget('machine:other-computer');
  state.machine = localMachine; state.peer = remoteMachine;
  expect(to).toEqual({ machine: localMachine, via: 'dispatcher' });
  const records = new Map<string, Handoff>();
  const store: HandoffStorage = { get: (id) => records.get(id), list: () => [...records.values()], transact: async (id, change) => { const next = parseHandoff(await change(records.get(id))); records.set(id, next); return next; } };
  const service = new HandoffService({ machine: remoteMachine, store, authorize: async () => true, isDispatcher: () => false });
  const sender = new HandoffCoordinator({ machine: remoteMachine, store, service, commands: { list: () => [], put: async () => {}, remove: async () => {} }, connected: () => true, authorizeOutgoing: async () => true,
    post: (_peer, body) => receiveNetworkHandoff(remoteMachine, body) });
  state.post.mockImplementation(async (_peer, _route, body) => ({ status: 200, body: await sender.receive(localMachine, body) }));
  state.connected = false; // The remote sender needs no direct connection to the addressed Dispatcher; local Dispatcher-to-target control is explicit.
  const record = await sender.offer({ ...offer(), to, senderName: 'Remote sender', manifest: { fileCount: 0, totalBytes: 0, sha256: '0'.repeat(64) } }, { agentId: 'remote-sender', machine: remoteMachine });
  expect(state.send.mock.calls[0][0]).toContain('Computer: "other-computer"');
  expect(await resolveHandoffGrantTarget('dispatcher', { id: record.id, accept: true })).toMatchObject({ relations: [] });
  state.create.mockImplementation(async (_actor, _tool, args) => {
    state.extraAgent = { id: 'new-agent', name: args.name };
    return { content: [{ type: 'text', text: JSON.stringify({ id: 'new-agent', agentStarted: false }) }] };
  });
  const target = choice === 'new_helper' ? await prepareNewHandoffHelper('dispatcher', record.id) : await resolveHandoffTarget(choice);
  if (!('agentId' in target)) throw new Error('Expected a local receiving agent');
  const accepted = await handoffHost().coordinator.respond(record.id, localHandoffAgent('dispatcher'), true, target);
  expect(accepted).toMatchObject({ state: 'accepted', acceptance: { by: { agentId: 'dispatcher' }, target: { agentId: choice === 'new_helper' ? 'new-agent' : 'receiver' } } });
  expect(store.get(record.id)).toEqual(accepted);
  await expect(handoffHost().coordinator.service.advance(record.id, { state: 'transferring', bytesDone: 0 }, accepted.version)).resolves.toMatchObject({ state: 'transferring' });
});

 it('publishes an outgoing Dispatcher agreement for local coordination without granting participant access or accepting it', async () => {
  const observe = vi.fn(async () => {});
  const stop = setFederationHandoffObserver(observe);
  state.connected = false;
  state.post.mockRejectedValue(new Error('offline'));
  try {
    const record = await handoffHost().coordinator.offer({ ...offer(), to: { machine: state.peer, via: 'dispatcher' } }, localHandoffAgent('sender'));
    expect(record.state).toBe('offered');
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ id: record.id, state: 'offered', from: localHandoffAgent('sender') }));
    expect(handoffHost().coordinator.service.get(record.id, localHandoffAgent('sender')).id).toBe(record.id);
    expect(() => handoffHost().coordinator.service.get(record.id, localHandoffAgent('dispatcher'))).toThrow();
    expect(state.create).not.toHaveBeenCalled();
  } finally { stop(); }
});

it('does not plant a cancelled offer, participant tools or its private brief for an unconnected local receiver', async () => {
  startHandoffs(); state.connected = false;
  const from = { machine: state.peer, agentId: 'remote-sender' }; const at = Date.now(); const id = randomUUID();
  const record = parseHandoff({ schemaVersion: 1, id, createdAt: at, updatedAt: at, version: 1, from, to: localHandoffAgent('receiver'),
    task: { title: 'Private task', brief: 'Private sender brief' }, mode: 'worktree', state: 'offered', history: [{ operationId: randomUUID(), at, by: { kind: 'agent', address: from }, state: 'offered' }] });
  expect(await receiveNetworkHandoff(state.peer, { op: 'cancel', record, command: { id, from, operationId: randomUUID() } })).toMatchObject({ kind: 'refused', record: { failure: { code: 'refused' } } });
  expect(handoffHost().store.list()).toEqual([]); expect(state.participant('receiver')).toBe(false); expect(state.send).not.toHaveBeenCalled();
  expect(() => handoffHost().coordinator.service.get(id, localHandoffAgent('receiver'))).toThrow('unavailable');
});
it('sends nothing when a never-attempted offer is cancelled after its grant or connection is revoked', async () => {
  state.online = false;
  const record = await handoffHost().coordinator.offer({ ...offer(), to: await resolveHandoffTarget('machine:other-computer') }, localHandoffAgent('sender'));
  expect(handoffHost().commands.isUndelivered(record.id)).toBe(true);
  state.allowed = state.connected = false;
  expect((await handoffHost().coordinator.cancel(record.id, localHandoffAgent('sender'))).state).toBe('cancelled');
  state.online = true; await handoffHost().coordinator.flush();
  expect(state.post).not.toHaveBeenCalled(); expect(handoffHost().commands.list()).toEqual([]);
});

it('synchronizes an offered agreement through the original host with reverse readiness but no direct connection or snapshot', async () => {
  state.online = state.connected = state.snapshot = state.server = state.accepting = false;
  state.reverseReady = true;
  state.post.mockImplementation(async (_peer, _route, body) => ({ status: 200, body: body.record }));
  const active = handoffHost();
  const record = await active.coordinator.offer({ ...offer(), to: { machine: state.peer, via: 'dispatcher' } }, localHandoffAgent('sender'));
  expect(state.post).toHaveBeenCalledTimes(1);
  expect(state.post.mock.calls[0]).toEqual([state.peer, '/api/v1/network/handoffs',
    { op: 'offer', record }, { signal: expect.any(AbortSignal), maxResponseBytes: 512 * 1024 }]);
  expect(active.commands.isUndelivered(record.id)).toBe(false);
  expect(active.store.get(record.id)).toEqual(record);
});

it.each([false, true])('preserves old no-control behavior and the existing direct route (direct=%s)', async (direct) => {
  state.online = direct; state.reverseReady = state.snapshot = false;
  state.post.mockImplementation(async (_peer, _route, body) => ({ status: 200, body: body.record }));
  const active = handoffHost(); const record = await active.coordinator.offer(remoteOffer(), localHandoffAgent('sender'));
  expect(state.post).toHaveBeenCalledTimes(direct ? 1 : 0);
  expect(active.commands.isUndelivered(record.id)).toBe(!direct);
  expect(active.reverseSyncs.size).toBe(0); expect(state.connectionListeners.size).toBe(0);
});

it.each(['grant-revision', 'configuration', 'connection-notification', 'binding-membership', 'binding-permissions', 'epoch', 'readiness', 'membership', 'direct-promotion', 'host-instance'] as const)(
  'retires the original reverse %s capture across the actual outgoing authorization await', async (change) => {
    reverse();
    const wire: (typeof state.bindings)[number] = { targetKind: 'agent', targetId: `receiver@${state.peer}`, enabledTools: [], disabledTools: [] };
    state.bindings = [wire];
    const entered = barrier(); const held = barrier();
    state.lookup = async () => { entered.release(); await held.promise; };
    const active = handoffHost();
    const offering = active.coordinator.offer({ ...offer(), to: { machine: state.peer, agentId: 'receiver' } }, localHandoffAgent('sender'));
    try {
      await entered.promise;
      if (change === 'grant-revision') state.grantRevision++;
      if (change === 'configuration') state.generation++;
      if (change === 'connection-notification') for (const listener of state.connectionListeners) listener();
      if (change === 'binding-membership' || change === 'binding-permissions') {
        state.bindings = change === 'binding-membership' ? [] : [{ ...wire, disabledTools: ['send_message'] }];
        for (const listener of state.bindingListeners) listener('sender');
        state.bindings = [wire];
      }
      if (change === 'epoch') state.revision++;
      if (change === 'readiness') state.reverseReady = false;
      if (change === 'membership') state.member = false;
      if (change === 'direct-promotion') state.online = true;
      if (change === 'host-instance') {
        const original = state.machine;
        try { state.machine = state.peer; expect(() => handoffHost()).toThrow('permissions or connection changed'); }
        finally { state.machine = original; }
      }
      held.release(); const record = await offering;
      expect(state.post).not.toHaveBeenCalled(); expect(active.commands.isUndelivered(record.id)).toBe(true);
      expect(active.store.get(record.id)).toEqual(record);
      expect(active.reverseSyncs.size).toBe(0); expect(state.connectionListeners.size).toBe(0); expect(state.bindingListeners.size).toBe(0);
    } finally { held.release(); await offering; }
  });

it('does not turn a valid reverse capture into a positive outgoing grant', async () => {
  reverse(); const entered = barrier(); const held = barrier();
  state.lookup = async () => { entered.release(); await held.promise; };
  const active = handoffHost(); const offering = active.coordinator.offer(remoteOffer(), localHandoffAgent('sender'));
  try {
    await entered.promise; state.allowed = false; held.release();
    const record = await offering;
    expect(state.post).not.toHaveBeenCalled(); expect(active.commands.isUndelivered(record.id)).toBe(true);
  } finally { held.release(); await offering; }
});

it('still refuses an unconnected ordinary outgoing target even when reverse is ready', async () => {
  reverse(); state.connected = false;
  await expect(handoffHost().coordinator.offer({ ...offer(), to: { machine: state.peer, agentId: 'receiver' } }, localHandoffAgent('sender'))).rejects.toThrow('not authorized');
  expect(state.post).not.toHaveBeenCalled(); expect(handoffHost().store.list()).toEqual([]);
});

it('keeps the durable attempted marker if retirement follows its real save but precedes POST', async () => {
  reverse(); const active = handoffHost(); const original = active.commands.markAttempted.bind(active.commands);
  vi.spyOn(active.commands, 'markAttempted').mockImplementation(async (id) => { await original(id); state.revision++; });
  const record = await active.coordinator.offer(remoteOffer(), localHandoffAgent('sender'));
  expect(state.post).not.toHaveBeenCalled(); expect(active.commands.isUndelivered(record.id)).toBe(false);
  expect(active.store.get(record.id)).toEqual(record);
});

it('checks the same capture inside the actual deadline microtask immediately before POST', async () => {
  reverse();
  state.beforeOperation = () => { state.revision++; };
  const active = handoffHost(); const record = await active.coordinator.offer(remoteOffer(), localHandoffAgent('sender'));
  expect(state.post).not.toHaveBeenCalled(); expect(active.commands.isUndelivered(record.id)).toBe(false);
  expect(state.connectionListeners.size).toBe(0); expect(state.bindingListeners.size).toBe(0);
});

it('retains the pending cancellation exception and original command ID after grant and connection revocation', async () => {
  reverse(); state.post.mockRejectedValueOnce(new Error('Uncertain attempted delivery'));
  const active = handoffHost(); const record = await active.coordinator.offer(remoteOffer(), localHandoffAgent('sender'));
  expect(active.commands.isUndelivered(record.id)).toBe(false);
  state.allowed = state.connected = state.accepting = state.server = false;
  const operations: string[] = [];
  state.post.mockImplementation(async (_peer, _route, body) => {
    expect(body.op).toBe('cancel'); operations.push(body.command.operationId);
    return { status: 200, body: transitionHandoff(body.record, { state: 'cancelled', operationId: body.command.operationId,
      at: body.record.updatedAt + 1, by: { kind: 'agent', address: body.command.from } }, body.record.version) };
  });
  const cancelled = await active.coordinator.cancel(record.id, localHandoffAgent('sender'));
  expect(cancelled.state).toBe('cancelled'); expect(operations).toEqual([cancelled.history[1].operationId]);
  expect(active.commands.list()).toEqual([]); expect(active.commands.acknowledged(record.id)).toBe(cancelled.version);
  expect(state.connectionListeners.size).toBe(0);
});

it('keeps authoritative receiver history queryable and ACK-able without fresh outgoing or incoming permission', async () => {
  reverse(); const active = handoffHost(); const at = Date.now();
  const from = { machine: state.peer, agentId: 'remote-sender' }, to = localHandoffAgent('receiver');
  const offered = parseHandoff({ schemaVersion: 1, id: randomUUID(), createdAt: at, updatedAt: at, version: 1, from, to,
    task: offer().task, mode: 'worktree', state: 'offered',
    history: [{ operationId: randomUUID(), at, state: 'offered', by: { kind: 'agent', address: from } }] });
  const declined = transitionHandoff(offered, { state: 'declined', operationId: randomUUID(), at: at + 1,
    by: { kind: 'agent', address: to } }, 1);
  await active.store.transact(declined.id, () => declined);
  state.allowed = state.connected = state.accepting = state.server = false;
  state.post.mockImplementation(async (_peer, _route, body) => ({ status: 200, body: body.record }));
  await active.coordinator.sync(declined.id);
  expect(state.post).toHaveBeenCalledTimes(1); expect(active.commands.acknowledged(declined.id)).toBe(declined.version);
  expect(active.coordinator.service.get(declined.id, to)).toEqual(declined); expect(state.connectionListeners.size).toBe(0);
});

it('drains an already-admitted real history save on stop before replacement and retains normal committed-history notices', async () => {
  reverse(); const active = handoffHost(); const entered = barrier(); const held = barrier(); const rename = fs.promises.rename;
  state.post.mockImplementation(async (_peer, _route, body) => ({ status: 200, body: acceptedCopy(body.record) }));
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === path.join(state.dir, 'handoffs.json') && JSON.parse(fs.readFileSync(String(from), 'utf8')).records[0]?.version === 2) {
      entered.release(); await held.promise;
    }
    return rename(from, to);
  });
  const offering = active.coordinator.offer({ ...offer(), to: { machine: state.peer, agentId: 'remote-receiver' } }, localHandoffAgent('sender'));
  try {
    await entered.promise;
    let stopped = false; const stopping = stopHandoffs().then(() => { stopped = true; });
    expect(stopped).toBe(false); expect(() => handoffHost()).toThrow('permissions or connection changed');
    expect(active.store.list()[0].version).toBe(1);
    held.release(); const accepted = await offering; await stopping;
    expect(accepted.state).toBe('accepted'); expect(active.store.get(accepted.id)).toEqual(accepted);
    expect(handoffHost().store.get(accepted.id)).toEqual(accepted);
    expect(state.send.mock.calls.some(([text]) => text.includes('State: accepted'))).toBe(true);
    expect(state.connectionListeners.size).toBe(0); expect(state.bindingListeners.size).toBe(0);
  } finally { held.release(); await offering; }
});

it.each(['posted-operation', 'scheduled-operation', 'posted-rejection'] as const)('keeps the actual %s lease after outer deadline until real settlement', async (phase) => {
  reverse(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const active = handoffHost(); const entered = barrier(); const held = barrier();
  let signal: AbortSignal | undefined; let late: Handoff | undefined;
  const unhandled = vi.fn(); process.on('unhandledRejection', unhandled);
  if (phase === 'scheduled-operation') state.beforeOperation = async (actual) => { signal = actual; entered.release(); await held.promise; };
  state.post.mockImplementation(async (_peer, _route, body, options) => {
    signal = options.signal; late = acceptedCopy(body.record);
    if (phase !== 'scheduled-operation') { entered.release(); await held.promise; }
    if (phase === 'posted-rejection') throw new Error('Actual late operation rejection');
    return { status: 200, body: late };
  });
  const offering = active.coordinator.offer(remoteOffer(), localHandoffAgent('sender'));
  try {
    await entered.promise; expect(state.connectionListeners.size).toBe(1); expect(state.bindingListeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); const record = await offering;
    expect(signal?.aborted).toBe(true); expect(active.reverseSyncs.size).toBe(0);
    expect(state.connectionListeners.size).toBe(1); expect(state.bindingListeners.size).toBe(1);
    await stopHandoffs(); expect(state.connectionListeners.size).toBe(1);
    held.release(); vi.useRealTimers();
    await vi.waitFor(() => { expect(state.connectionListeners.size).toBe(0); expect(state.bindingListeners.size).toBe(0); });
    expect(state.post).toHaveBeenCalledTimes(phase === 'scheduled-operation' ? 0 : 1);
    expect(state.unsubscribed.mock.calls).toEqual([['connection'], ['binding']]);
    expect(active.store.get(record.id)).toEqual(record); expect(record.version).toBe(1);
    expect(state.send.mock.calls.some(([text]) => text.includes('State: accepted'))).toBe(false);
    expect(unhandled).not.toHaveBeenCalled();
  } finally { held.release(); vi.useRealTimers(); process.removeListener('unhandledRejection', unhandled); await offering; }
});
