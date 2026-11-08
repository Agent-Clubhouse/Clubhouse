import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

// The agent system as the real wake path (agent-lifecycle) uses it.
const system = vi.hoisted(() => ({
  isAgentRunning: vi.fn(),
  isAgentStopping: vi.fn(),
  waitForAgentStopped: vi.fn(),
  killAgent: vi.fn(),
  spawnAgent: vi.fn(),
}));
vi.mock('../../agent-system', () => system);

const mocks = vi.hoisted(() => ({
  registryGet: vi.fn(),
  getAgentRuntime: vi.fn(),
  sendMessage: vi.fn(),
  deliverNow: vi.fn(),
  getDurableConfig: vi.fn(),
  listProjects: vi.fn(),
  broadcast: vi.fn(),
  decideGrant: vi.fn(),
  askFirst: vi.fn(),
  dispatcherEnabled: true,
}));
vi.mock('../../agent-registry', () => ({ agentRegistry: { get: mocks.registryGet } }));
vi.mock('../../agent-runtime', () => ({ getAgentRuntime: mocks.getAgentRuntime }));
vi.mock('../../agent-runtime/checkpoint-tracker', () => ({ BUSY_STATES: new Set(['running']) }));
vi.mock('./helper-delivery', () => ({ deliverNow: mocks.deliverNow }));
vi.mock('../../helper-index', () => ({ listHelpersEverywhere: vi.fn(async () => []) }));
vi.mock('../../agent-config', () => ({ getDurableConfig: mocks.getDurableConfig, listDurable: vi.fn(async () => []) }));
vi.mock('../../project-store', () => ({ list: mocks.listProjects }));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: mocks.broadcast }));
vi.mock('../binding-manager', () => ({ bindingManager: { getBindingsForAgent: () => [] } }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../grant-check', () => ({ decideGrant: mocks.decideGrant }));
vi.mock('../ask-first', () => ({ askFirst: mocks.askFirst }));
vi.mock('../../dispatcher/dispatcher-service', () => ({
  getDispatcherAgentId: () => 'disp',
  getDispatcherPath: () => '/home/.clubhouse/dispatcher',
  isDispatcherAgentId: (id: string) => id === 'disp',
  isDispatcherEnabled: () => mocks.dispatcherEnabled,
}));

import { IPC } from '../../../../shared/ipc-channels';
import {
  deliverToDispatcher, dispatcherInboxId, isDispatcherTarget, sleepingDispatcherHint, _resetDispatcherDeliveryForTesting,
  type DispatcherDeliveryRequest,
} from './dispatcher-delivery';

const DISPATCHER_PATH = '/home/.clubhouse/dispatcher';

function request(overrides: Partial<DispatcherDeliveryRequest> = {}): DispatcherDeliveryRequest {
  return {
    senderId: 'sender', targetId: 'disp', targetName: 'Dispatcher',
    text: '[TASK:t1] [FROM:webapp-lead@shop] checkout is fixed',
    routed: [{ sender: { agentId: 'sender', name: 'webapp-lead' }, text: 'checkout is fixed' }],
    taskId: 't1', submit: true, toolName: 'clubhouse__dispatcher_send_message', args: { message: 'checkout is fixed' },
    ...overrides,
  };
}

describe('messages to the Dispatcher (#3037)', () => {
  /** Whether the Dispatcher has a live session. */
  let running: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetDispatcherDeliveryForTesting();
    mocks.dispatcherEnabled = true;
    running = false;
    system.isAgentRunning.mockImplementation((id: string) => id === 'disp' && running);
    system.isAgentStopping.mockReturnValue(false);
    system.waitForAgentStopped.mockResolvedValue(true);
    system.spawnAgent.mockImplementation(async () => { running = true; });
    mocks.registryGet.mockImplementation((id: string) => (id === 'disp' && running ? { projectPath: DISPATCHER_PATH, runtime: 'chat' } : undefined));
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.getAgentRuntime.mockReturnValue({ kind: 'chat', sendMessage: mocks.sendMessage, isRunning: () => true });
    mocks.deliverNow.mockResolvedValue('delivered');
    mocks.listProjects.mockResolvedValue([]);
    mocks.getDurableConfig.mockImplementation(async (dir: string, id: string) => (dir === DISPATCHER_PATH && id === 'disp'
      ? { id: 'disp', name: 'Dispatcher', model: 'sonnet', orchestrator: 'claude-code', freeAgentMode: true, lastSessionId: 's-1' }
      : null));
    mocks.decideGrant.mockReturnValue({ outcome: 'allow' });
  });

  it('knows the Dispatcher, and delivers to the Dispatcher agent itself today', () => {
    expect(isDispatcherTarget('disp')).toBe(true);
    expect(isDispatcherTarget('peer')).toBe(false);
    expect(dispatcherInboxId('disp')).toBe('disp');
  });

  it('delivers to a running Dispatcher without waking it', async () => {
    running = true;
    const req = request({ submit: false });
    await expect(deliverToDispatcher(req)).resolves.toEqual({ delivered: true, woke: false });
    expect(mocks.sendMessage).toHaveBeenCalledWith(req.text, { source: 'mcp', taskId: 't1', submit: false, routed: req.routed });
    expect(system.spawnAgent).not.toHaveBeenCalled();
    expect(mocks.decideGrant).not.toHaveBeenCalled();
  });

  it('wakes a sleeping Dispatcher from its own folder, resuming its session, with the message as its first prompt', async () => {
    const req = request();
    await expect(deliverToDispatcher(req)).resolves.toEqual({ delivered: true, woke: true });
    expect(mocks.decideGrant).toHaveBeenCalledWith('sender', 'agent.wake', { kind: 'agent', relations: ['connected'], isDispatcher: true });
    expect(mocks.getDurableConfig).toHaveBeenCalledWith(DISPATCHER_PATH, 'disp');
    expect(mocks.listProjects).not.toHaveBeenCalled();
    expect(system.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'disp', projectPath: DISPATCHER_PATH, cwd: DISPATCHER_PATH, kind: 'durable',
      mission: req.text, missionRouted: req.routed, resume: true, sessionId: 's-1', orchestrator: 'claude-code', freeAgentMode: true,
    }));
    expect(mocks.broadcast).toHaveBeenCalledWith(IPC.AGENT.AGENT_WAKING, 'disp');
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('tells the sender clearly when the Dispatcher fails to start', async () => {
    system.spawnAgent.mockRejectedValue(new Error('claude CLI not found'));
    const result = await deliverToDispatcher(request());
    expect(result.delivered).toBe(false);
    if (result.delivered) return;
    expect(result.text).toContain('Dispatcher is asleep and could not be started, so the message was not delivered.');
    expect(result.text).toContain('claude CLI not found');
    expect(mocks.broadcast).toHaveBeenCalledWith(IPC.AGENT.AGENT_WAKE_FAILED, 'disp', 'claude CLI not found');
  });

  it('says so when the Dispatcher\'s record is missing', async () => {
    mocks.getDurableConfig.mockResolvedValue(null);
    const result = await deliverToDispatcher(request());
    expect(result).toMatchObject({ delivered: false });
    if (!result.delivered) expect(result.text).toContain('could not be started');
  });

  it('wakes nothing for a sender whose permission to wake it is off', async () => {
    mocks.decideGrant.mockReturnValue({ outcome: 'refuse', reason: 'no_grant' });
    const result = await deliverToDispatcher(request());
    expect(result).toMatchObject({ delivered: false });
    if (!result.delivered) expect(result.text).toContain('you don\'t have the Clubhouse permission to wake it (agent.wake on the Dispatcher)');
    expect(system.spawnAgent).not.toHaveBeenCalled();
  });

  it('asks the user first when the permission is Ask first, and wakes once they allow the call', async () => {
    mocks.decideGrant.mockReturnValue({ outcome: 'ask', grant: { action: 'agent.wake', target: { kind: 'connected', onlyDispatcher: true }, mode: 'ask' } });
    mocks.askFirst.mockResolvedValueOnce({ kind: 'asked', text: 'Not done yet: this needs the user\'s approval.' });
    const req = request();
    const asked = await deliverToDispatcher(req);
    expect(asked).toEqual({ delivered: false, text: 'Dispatcher is asleep, so the message was not delivered. Not done yet: this needs the user\'s approval.' });
    expect(mocks.askFirst).toHaveBeenCalledWith('sender', req.toolName, req.args, [{ action: 'agent.wake', where: 'the Dispatcher' }]);
    expect(system.spawnAgent).not.toHaveBeenCalled();

    mocks.askFirst.mockResolvedValueOnce({ kind: 'approved' });
    await expect(deliverToDispatcher(req)).resolves.toEqual({ delivered: true, woke: true });
    expect(system.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it('wakes nothing while the Dispatcher is turned off', async () => {
    mocks.dispatcherEnabled = false;
    const result = await deliverToDispatcher(request());
    expect(result).toMatchObject({ delivered: false });
    if (!result.delivered) expect(result.text).toContain('turned off');
    expect(system.spawnAgent).not.toHaveBeenCalled();
  });

  it('waits for a Dispatcher that is shutting down, then wakes a new session for the message', async () => {
    running = true;
    system.isAgentStopping.mockImplementation(() => running);
    system.waitForAgentStopped.mockImplementation(async () => { running = false; return true; });
    await expect(deliverToDispatcher(request())).resolves.toEqual({ delivered: true, woke: true });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(system.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it('reports a Dispatcher still shutting down as undelivered', async () => {
    running = true;
    system.isAgentStopping.mockReturnValue(true);
    system.waitForAgentStopped.mockResolvedValue(false);
    const result = await deliverToDispatcher(request());
    expect(result).toMatchObject({ delivered: false });
    if (!result.delivered) expect(result.text).toContain('shutting down right now');
  });

  it('delivers a second message that arrives during the wake to the woken session', async () => {
    let finishSpawn!: () => void;
    system.spawnAgent.mockImplementation(() => new Promise<void>((resolve) => { finishSpawn = () => { running = true; resolve(); }; }));
    const first = deliverToDispatcher(request());
    const second = deliverToDispatcher(request({ taskId: 't2', text: 'second' }));
    await vi.waitFor(() => expect(system.spawnAgent).toHaveBeenCalled());
    finishSpawn();
    await expect(first).resolves.toEqual({ delivered: true, woke: true });
    await expect(second).resolves.toEqual({ delivered: true, woke: false });
    expect(system.spawnAgent).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith('second', expect.objectContaining({ taskId: 't2' }));
  });

  it('a failed delivery doesn\'t hold up the next one', async () => {
    running = true;
    mocks.sendMessage.mockRejectedValueOnce(new Error('pipe closed'));
    await expect(deliverToDispatcher(request())).rejects.toThrow('pipe closed');
    await expect(deliverToDispatcher(request())).resolves.toEqual({ delivered: true, woke: false });
  });

  it('get_status tells each sender what a message would do', () => {
    mocks.decideGrant.mockReturnValue({ outcome: 'allow' });
    expect(sleepingDispatcherHint('sender')).toContain('send_message wakes it');
    mocks.decideGrant.mockReturnValue({ outcome: 'ask' });
    expect(sleepingDispatcherHint('sender')).toContain('asks the user');
    mocks.decideGrant.mockReturnValue({ outcome: 'refuse' });
    expect(sleepingDispatcherHint('sender')).toContain('don\'t have the Clubhouse permission to wake it');
  });
});
