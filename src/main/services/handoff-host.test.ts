import * as fs from 'fs';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HandoffCoordinator } from './handoff-coordinator';
import { HandoffService } from './handoff-service';
import type { HandoffStorage } from './handoff-store';
import { parseHandoff, type Handoff } from '../../shared/handoffs';
import type { HandoffOffer } from '../../shared/handoffs';
const state = vi.hoisted(() => ({
  dir: '', machine: Array(16).fill('ab').join(':'), peer: Array(16).fill('cd').join(':'),
  allowed: true, connected: true, online: true, member: true, accepting: true, running: true,
  send: vi.fn(async (_text: string, _options?: unknown) => ({})), create: vi.fn(), extraAgent: undefined as { id: string; name: string } | undefined, participant: (_id: string) => false, post: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: state.machine }), getOrCreateIdentity: () => ({ fingerprint: state.machine }) }));
vi.mock('./annex-settings', () => ({ getSettings: () => ({ alias: 'this-computer', enableServer: true, networkEnabled: true, acceptHandoffs: state.accepting }), networkEnabled: () => true }));
vi.mock('./annex-peers', () => ({ listPeers: () => [{ fingerprint: state.peer, alias: 'other-computer', role: 'member', kind: 'desktop' }] }));
vi.mock('./annex-client', () => ({ getSatellite: () => ({ snapshot: { dispatcher: { agent: { id: 'remote-dispatcher', name: 'Remote concierge' } } } }), isMachineConnected: () => state.online, postToMachine: (...args: unknown[]) => state.post(...args), onSatelliteConnected: () => () => {} }));
vi.mock('./annex-agent-calls', () => ({ isNetworkComputer: () => state.member }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: () => undefined } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => ({ isRunning: () => state.running, sendMessage: state.send }) }));
vi.mock('./agent-config', () => ({ peekDurableConfigs: async () => [{ id: 'sender', name: 'Sender' }, { id: 'receiver', name: 'Receiver' }, ...(state.extraAgent ? [state.extraAgent] : [])] }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ id: 'project', name: 'Project', path: state.dir }] }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: () => ({ enabled: true, agentId: 'dispatcher', path: state.dir, config: { name: 'Dispatcher' } }), isDispatcherAgentId: (id: string) => id === 'dispatcher' }));
vi.mock('./agent-grants-service', () => ({ effectiveAgentGrants: async () => state.allowed ? [{ action: 'handoff.offer', target: { kind: 'any' }, mode: 'allow' }, { action: 'handoff.accept', target: { kind: 'any' }, mode: 'allow' }] : [] }));
vi.mock('./connection-grants-store', () => ({ getConnectionDirection: () => state.connected ? { link: true } : undefined }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: () => [], getBindingsForAgent: () => [] } }));
vi.mock('./clubhouse-mcp/grant-check', () => ({ callerGrants: () => [] }));
vi.mock('./clubhouse-mcp/tool-registry', () => ({ callTool: (...args: unknown[]) => state.create(...args), setHandoffParticipantCheck: (check: (id: string) => boolean) => { state.participant = check; } }));
vi.mock('./clubhouse-mcp/handoff-permissions', () => ({ handoffAgreementCallApproved: async () => state.allowed }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ defaultHelperTemplateId: async () => 'person-helper-template' }) }));
import { prepareNewHandoffHelper, handoffHost, localHandoffAgent, receiveNetworkHandoff, resolveHandoffGrantTarget, resolveHandoffTarget, startHandoffs, stopHandoffs } from './handoff-host';
const offer = (): HandoffOffer => ({ to: localHandoffAgent('receiver'), task: { title: 'Continue task', brief: 'Goal and remaining checks.' }, mode: 'worktree' });
beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-host-'));
  state.allowed = state.connected = state.online = state.member = state.accepting = state.running = true;
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
  expect(state.create).toHaveBeenCalledWith('dispatcher', 'create_managed_agent', { name: `handoff-${record.id}`, project: state.dir, templateId: 'person-helper-template', connectToDispatcher: false });
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
  state.connected = false; // The addressed Dispatcher is the explicit connection exception.
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
