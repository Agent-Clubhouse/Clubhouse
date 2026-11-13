import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HandoffOffer } from '../../shared/handoffs';
const state = vi.hoisted(() => ({
  dir: '', machine: Array(16).fill('ab').join(':'), peer: Array(16).fill('cd').join(':'),
  allowed: true, connected: true, member: true, accepting: true, running: true,
  send: vi.fn(async (_text: string, _options?: unknown) => ({})), create: vi.fn(), extraAgent: undefined as { id: string; name: string } | undefined, participant: (_id: string) => false, post: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: state.machine }), getOrCreateIdentity: () => ({ fingerprint: state.machine }) }));
vi.mock('./annex-settings', () => ({ getSettings: () => ({ alias: 'this-computer', enableServer: true, networkEnabled: true, acceptHandoffs: state.accepting }), networkEnabled: () => true }));
vi.mock('./annex-peers', () => ({ listPeers: () => [{ fingerprint: state.peer, alias: 'other-computer', role: 'member', kind: 'desktop' }] }));
vi.mock('./annex-client', () => ({ getSatellite: () => undefined, isMachineConnected: () => true, postToMachine: (...args: unknown[]) => state.post(...args), onSatelliteConnected: () => () => {} }));
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
  state.allowed = state.connected = state.member = state.accepting = state.running = true;
  vi.clearAllMocks();
  state.extraAgent = undefined;
});
afterEach(() => { stopHandoffs(); fs.rmSync(state.dir, { recursive: true, force: true }); });

it('resolves named agents and computer Dispatcher targets, requiring a connection for normal receivers', async () => {
  expect(await resolveHandoffTarget('Receiver')).toEqual(localHandoffAgent('receiver'));
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
  expect(state.send.mock.calls[0][0]).toContain(`From Sender on ${state.machine}`);
  expect(state.send.mock.calls[0][0]).not.toContain('From You');
  expect(state.participant('receiver')).toBe(true);
  expect(state.participant('stranger')).toBe(false);
  stopHandoffs();
  state.allowed = false;
  startHandoffs();
  await vi.waitFor(() => expect(state.participant('receiver')).toBe(true));
  expect(handoffHost().coordinator.service.get(record.id, localHandoffAgent('receiver')).id).toBe(record.id);
  await expect(handoffHost().coordinator.respond(record.id, localHandoffAgent('receiver'), true)).rejects.toThrow('not authorized');
  expect(state.send).toHaveBeenCalledTimes(1);
});

it('refuses peer synchronization when incoming handoffs are disabled or membership was removed', async () => {
  state.accepting = false;
  await expect(receiveNetworkHandoff(state.peer, {})).rejects.toThrow('unavailable');
  state.accepting = true;
  state.member = false;
  await expect(receiveNetworkHandoff(state.peer, {})).rejects.toThrow('unavailable');
  expect(handoffHost().store.list()).toEqual([]);
});

it('prepares one asleep managed helper using the normal creation boundary and reuses it after restart', async () => {
  const record = await handoffHost().coordinator.offer({ ...offer(), to: { machine: state.machine, via: 'dispatcher' } }, localHandoffAgent('sender'));
  state.create.mockImplementation(async (_actor, _tool, args) => {
    state.extraAgent = { id: 'new-agent', name: args.name };
    return { content: [{ type: 'text', text: JSON.stringify({ id: 'new-agent', name: args.name, agentStarted: false }) }] };
  });
  expect(await prepareNewHandoffHelper('dispatcher', record.id)).toEqual(localHandoffAgent('new-agent'));
  expect(state.create).toHaveBeenCalledWith('dispatcher', 'create_managed_agent', { name: `handoff-${record.id}`, project: state.dir, templateId: 'person-helper-template', connectToDispatcher: false });
  stopHandoffs();
  expect(await prepareNewHandoffHelper('dispatcher', record.id)).toEqual(localHandoffAgent('new-agent'));
  expect(state.create).toHaveBeenCalledTimes(1);
  state.allowed = false;
  await expect(prepareNewHandoffHelper('dispatcher', record.id)).rejects.toThrow('not authorized');
  expect(state.create).toHaveBeenCalledTimes(1);
});
