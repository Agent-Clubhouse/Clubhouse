import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  dir: '', sender: '', receiver: '', asleep: true, wake: vi.fn(), onLocate: () => {}, targetMode: 'allow', wakeMode: 'allow', messageMode: 'allow', dispatcherConnected: true, disabledTools: [] as string[], enabledTools: ['wake_agent'] as string[] | undefined, savedDirection: true, bindingEnabled: ['wake_agent'] as string[] | undefined, bindingDisabled: [] as string[], policyRevision: 0, onGrants: (_id: string) => {}, machine: Array(16).fill('ab').join(':'), peer: Array(16).fill('cd').join(':'),
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
vi.mock('./agent-config', () => ({ listDurable: async (project: string) => { state.onLocate(); return project === state.receiver ? [{ id: 'receiver', name: 'Receiver' }] : [{ id: 'sender', name: 'Sender' }]; }, peekDurableConfigs: async (project: string) => project === state.sender ? [{ id: 'sender', name: 'Sender' }] : [{ id: 'receiver', name: 'Receiver' }] }));
vi.mock('./project-store', () => ({ list: async () => [{ id: 'destination-project', path: state.receiver }], peekProjects: async () => [{ id: 'source-project', name: 'Source', path: state.sender }, { id: 'destination-project', name: 'Destination', path: state.receiver }] }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: () => ({ enabled: true, agentId: 'dispatcher', path: state.dir, config: { name: 'Dispatcher' } }), isDispatcherAgentId: (id: string) => id === 'dispatcher' }));
vi.mock('./agent-grants-store', () => ({ getAgentGrantChanges: () => ({ revision: state.policyRevision }) }));
vi.mock('./agent-grants-service', () => ({ effectiveAgentGrants: async (_project: string, id: string) => { const grants = state.allowed ? [{ action: 'handoff.offer', target: { kind: 'any' }, mode: 'allow' }, ...(id !== 'receiver' || state.targetMode !== 'off' ? [{ action: 'handoff.accept', target: { kind: 'any' }, mode: id === 'receiver' ? state.targetMode : 'allow' }] : []), { action: 'agent.wake', target: { kind: 'any' }, mode: state.wakeMode }, { action: 'agent.message', target: { kind: 'any' }, mode: state.messageMode }] : []; await Promise.resolve(); state.onGrants(id); return grants; } }));
vi.mock('./connection-grants-store', async () => { const { localWakeOn } = await import('../../shared/connection-grants'); return { localConnectionWakeOn: () => state.savedDirection ? localWakeOn({ disabledTools: state.disabledTools, enabledTools: state.enabledTools }) : localWakeOn(undefined, state.bindingEnabled) && !state.bindingDisabled.includes('wake_agent'), getConnectionDirection: (from: { agentId: string }, to: { agentId: string }) => state.connected && !(from.agentId === 'dispatcher' && (!state.savedDirection || to.agentId === 'receiver' && !state.dispatcherConnected)) ? { link: true, disabledTools: from.agentId === 'dispatcher' ? state.disabledTools : [], enabledTools: state.enabledTools } : undefined }; });
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: () => [], getBindingsForAgent: (id: string) => id === 'dispatcher' && !state.savedDirection ? [{ targetKind: 'agent', targetId: 'receiver', enabledTools: state.bindingEnabled, disabledTools: state.bindingDisabled }] : [] } }));
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
  _resetHandoffPreparationsForTesting(); vi.clearAllMocks();
  state.targetMode = state.wakeMode = state.messageMode = 'allow'; state.dispatcherConnected = true; state.disabledTools = []; state.enabledTools = ['wake_agent']; state.savedDirection = true; state.bindingEnabled = ['wake_agent']; state.bindingDisabled = []; state.policyRevision = 0; state.onGrants = () => {}; state.onLocate = () => {};
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
