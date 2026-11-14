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
  chatMode: true,
}));
vi.mock('../../chat-runtime-settings', () => ({ resolveRuntimeMode: () => ({ mode: mocks.chatMode ? 'chat' : 'terminal' }) }));
vi.mock('../../agent-runtime/chat-drivers', () => ({ resolveChatDriver: () => ({}) }));
vi.mock('../../agent-registry', () => ({ agentRegistry: { get: mocks.registryGet, setUserLaunchAccess: vi.fn(), reportLaunchAccess: vi.fn() } }));
vi.mock('../../agent-runtime', () => ({ getAgentRuntime: mocks.getAgentRuntime }));
vi.mock('../../agent-runtime/chat-transcript', () => ({ appendChatEvent: vi.fn(async () => {}), readChatTranscript: vi.fn(async () => []) }));
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
  dispatcherDisplayName: () => 'Dispatcher',
  getDispatcherPath: () => '/home/.clubhouse/dispatcher',
  isDispatcherAgentId: (id: string) => id === 'disp',
  isDispatcherIdentityAgentId: (id: string) => id === 'disp' || id === 'disp-chat',
  isDispatcherEnabled: () => mocks.dispatcherEnabled,
}));

import { IPC } from '../../../../shared/ipc-channels';
import { registerAgentTools } from './agent-tools';
import { mcpAdapter } from '../mcp-adapter';
import {
  wakeDispatcher, deliverToDispatcher, dispatcherInboxId, isDispatcherTarget, sleepingDispatcherHint, _resetDispatcherDeliveryForTesting,
  type DispatcherDeliveryRequest,
} from './dispatcher-delivery';
import { clearAgentMessages, findInInbox } from '../../dispatcher/dispatcher-news-inbox';
import { ChatAgentRuntime } from '../../agent-runtime/chat-runtime';
import { FakeChatDriver } from '../../agent-runtime/fake-chat-driver';

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
    clearAgentMessages();
    mocks.dispatcherEnabled = true;
    mocks.chatMode = true;
    running = false;
    system.isAgentRunning.mockImplementation((id: string) => id === 'disp' && running);
    system.isAgentStopping.mockReturnValue(false);
    system.waitForAgentStopped.mockResolvedValue(true);
    system.spawnAgent.mockImplementation(async () => { running = true; });
    mocks.registryGet.mockImplementation((id: string) => (id === 'disp' && running ? { projectPath: DISPATCHER_PATH, runtime: 'chat' } : undefined));
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.getAgentRuntime.mockReturnValue({ kind: 'chat', sendMessage: mocks.sendMessage, isRunning: () => true, getState: () => 'idle', hasPendingWork: () => false, hasReceivedInput: () => false });
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

  it('passes Action queue and steer policies through the shared Dispatcher delivery path', async () => {
    running = true;
    const actionQueue = { actionId: 'a', latestOnly: true, maxWaitMs: 60000, onSettled: vi.fn() };
    const req = request({ fromAction: true, messageOptions: { actionQueue } });
    await deliverToDispatcher(req);
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(req.text, expect.objectContaining({ source: 'action', delivery: 'queued', actionQueue }));
    await deliverToDispatcher({ ...req, messageOptions: { delivery: 'auto', actionQueue } });
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(req.text, expect.objectContaining({ source: 'action', delivery: 'auto', actionQueue }));
  });

  it('notes the agent that sent it, so the group chat can name it (#3043)', async () => {
    running = true;
    await deliverToDispatcher(request());
    expect(findInInbox('webapp-lead')).toEqual({ agentId: 'sender', name: 'webapp-lead' });
    expect(findInInbox('sender')).toEqual({ agentId: 'sender', name: 'webapp-lead' });
  });

  it('notes nothing from the Dispatcher\'s own chat, or from a message that wasn\'t delivered', async () => {
    running = true;
    await deliverToDispatcher(request({ senderId: 'disp-chat', routed: [{ sender: { agentId: 'disp-chat', name: 'Conversation' }, text: 'wake it' }] }));
    expect(findInInbox('disp-chat')).toBeNull();
    mocks.dispatcherEnabled = false;
    running = false;
    await deliverToDispatcher(request());
    expect(findInInbox('sender')).toBeNull();
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

  it('an agent send_message command wakes the sleeping controller and delivers its tagged message (#3465)', async () => {
    const commands = vi.spyOn(mcpAdapter, 'registerMcpCommand').mockImplementation(() => {});
    registerAgentTools();
    const sendMessage = commands.mock.calls.find(([command]) => command.id === 'agent.sendMessage')![0];
    mocks.getDurableConfig.mockResolvedValue({ id: 'disp', name: 'Dispatcher', orchestrator: 'claude-code', freeAgentMode: true });
    const result = await sendMessage.handler('disp', 'sender', { message: 'cold launch message', task_id: 'cold1' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('was asleep and was woken to take it') });
    expect(system.spawnAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentId: 'disp', projectPath: DISPATCHER_PATH, resume: false,
      mission: '[TASK:cold1] [FROM:sender] cold launch message',
      missionRouted: [{ sender: { agentId: 'sender', name: 'sender' }, text: 'cold launch message' }],
    }));
    expect(mocks.listProjects).not.toHaveBeenCalled();
  });

  it('an explicit idle wake uses its own folder and serializes a message arriving during startup (#3465)', async () => {
    let finish!: () => void;
    system.spawnAgent.mockImplementation(() => new Promise<void>((resolve) => { finish = () => { running = true; resolve(); }; }));
    const waking = wakeDispatcher({ callerId: 'sender', targetId: 'disp', targetName: 'Dispatcher' });
    const delivery = deliverToDispatcher(request());
    await vi.waitFor(() => expect(system.spawnAgent).toHaveBeenCalled());
    expect(system.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ projectPath: DISPATCHER_PATH, mission: undefined }));
    finish();
    expect((await waking).isError).toBeFalsy();
    await expect(delivery).resolves.toEqual({ delivered: true, woke: false });
    expect(mocks.sendMessage).toHaveBeenCalledWith(request().text, expect.objectContaining({ routed: request().routed }));
    expect(system.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it('explicit wake respects Dispatcher Off (#3465)', async () => {
    mocks.dispatcherEnabled = false;
    expect((await wakeDispatcher({ callerId: 'sender', targetId: 'disp', targetName: 'Dispatcher' })).isError).toBe(true);
    expect(system.spawnAgent).not.toHaveBeenCalled();
  });

  it.each([false, true])('moves an untouched idle controller when Chat changes from %s without a prompt', async (initialChat) => {
    mocks.chatMode = initialChat;
    let registration: { projectPath: string; orchestrator: string; runtime: string } | undefined;
    mocks.registryGet.mockImplementation(() => registration);
    system.spawnAgent.mockImplementation(async () => {
      running = true;
      registration = { projectPath: DISPATCHER_PATH, orchestrator: 'claude-code', runtime: mocks.chatMode ? 'chat' : 'pty' };
    });
    system.killAgent.mockImplementation(async () => { running = false; registration = undefined; });
    const req = { callerId: 'disp', targetId: 'disp', targetName: 'Dispatcher' };
    await wakeDispatcher(req);
    mocks.chatMode = !initialChat;
    await wakeDispatcher(req, { refreshRuntime: true });
    expect(system.killAgent).toHaveBeenCalledExactlyOnceWith('disp', DISPATCHER_PATH, 'claude-code', 'user', { waitForExit: true, throwOnFailure: true, beforeStop: expect.any(Function) });
    expect(registration?.runtime).toBe(initialChat ? 'pty' : 'chat');
    expect(system.spawnAgent).toHaveBeenCalledTimes(2);
    for (const [params] of system.spawnAgent.mock.calls) expect(params.mission).toBeUndefined();
    // Other flag changes leave this session alone.
    await wakeDispatcher(req, { refreshRuntime: true });
    expect(system.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it('does not restart a controller that has accepted work when Chat changes', async () => {
    const registration = { projectPath: DISPATCHER_PATH, orchestrator: 'claude-code', runtime: 'pty' };
    mocks.registryGet.mockImplementation(() => running ? registration : undefined);
    const req = { callerId: 'disp', targetId: 'disp', targetName: 'Dispatcher' };
    await wakeDispatcher(req);
    await deliverToDispatcher(request());
    await wakeDispatcher(req, { refreshRuntime: true });
    expect(system.killAgent).not.toHaveBeenCalled();
    expect(system.spawnAgent).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('holds a message until the idle controller has moved into Chat', async () => {
    let registration: { projectPath: string; orchestrator: string; runtime: string } | undefined;
    mocks.chatMode = false;
    mocks.registryGet.mockImplementation(() => registration);
    system.spawnAgent.mockImplementation(async () => {
      running = true;
      registration = { projectPath: DISPATCHER_PATH, orchestrator: 'claude-code', runtime: mocks.chatMode ? 'chat' : 'pty' };
    });
    const req = { callerId: 'disp', targetId: 'disp', targetName: 'Dispatcher' };
    await wakeDispatcher(req);
    let finishStop!: () => void;
    system.killAgent.mockImplementation(() => new Promise<void>((resolve) => {
      finishStop = () => { running = false; registration = undefined; resolve(); };
    }));
    mocks.chatMode = true;
    const refresh = wakeDispatcher(req, { refreshRuntime: true });
    await vi.waitFor(() => expect(system.killAgent).toHaveBeenCalled());
    const delivery = deliverToDispatcher(request());
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    finishStop();
    await refresh;
    await expect(delivery).resolves.toEqual({ delivered: true, woke: false });
    expect(registration?.runtime).toBe('chat');
    expect(system.spawnAgent).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith(request().text, expect.objectContaining({ routed: request().routed }));
  });

  it('does not churn an untouched controller after a terminal fallback', async () => {
    const registration = { projectPath: DISPATCHER_PATH, orchestrator: 'claude-code', runtime: 'pty' };
    mocks.registryGet.mockImplementation(() => running ? registration : undefined);
    const req = { callerId: 'disp', targetId: 'disp', targetName: 'Dispatcher' };
    await wakeDispatcher(req); // Chat requested, terminal actually chosen.
    await wakeDispatcher(req, { refreshRuntime: true });
    await wakeDispatcher(req, { refreshRuntime: true });
    expect(system.killAgent).not.toHaveBeenCalled();
    expect(system.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves direct real-runtime handoff input (arrives during stop preparation: %s)', async (duringStop) => {
    const driver = new FakeChatDriver();
    const runtime = new ChatAgentRuntime({ agentId: 'disp', provider: 'claude-code', driverId: driver.id, cwd: DISPATCHER_PATH, level: 'ask', idleTimeoutMs: 0,
      startSession: () => driver.start({ agentId: 'disp', provider: 'claude-code', cwd: DISPATCHER_PATH, binaryPath: '/fake', level: 'ask' }),
    });
    const registration = { projectPath: DISPATCHER_PATH, orchestrator: 'claude-code', runtime: 'chat' };
    mocks.registryGet.mockImplementation(() => running ? registration : undefined);
    mocks.getAgentRuntime.mockReturnValue(runtime);
    system.spawnAgent.mockImplementation(async () => { running = true; await runtime.start(); });
    const req = { callerId: 'disp', targetId: 'disp', targetName: 'Dispatcher' };
    try {
      await wakeDispatcher(req);
      expect(runtime.hasReceivedInput()).toBe(false);
      // handoff-host/Annex bypass deliverToDispatcher and call this directly.
      if (duringStop) {
        system.killAgent.mockImplementation(async (_id, _dir, _provider, _trigger, opts) => {
          await runtime.sendMessage('handoff offer', { source: 'mcp' });
          opts.beforeStop();
          throw new Error('A touched controller must never reach the stop side effect');
        });
      } else {
        await runtime.sendMessage('handoff offer', { source: 'mcp' });
      }
      mocks.chatMode = false;
      await wakeDispatcher(req, { refreshRuntime: true });
      expect(driver.last.sent).toHaveLength(1);
      expect(system.killAgent).toHaveBeenCalledTimes(duringStop ? 1 : 0);
      expect(system.spawnAgent).toHaveBeenCalledTimes(1);
      expect(driver.last.closed).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  it('keeps the idle marker when stopping fails so a later setting change can retry', async () => {
    mocks.chatMode = false;
    const registration = { projectPath: DISPATCHER_PATH, orchestrator: 'claude-code', runtime: 'pty' };
    mocks.registryGet.mockImplementation(() => running ? registration : undefined);
    const req = { callerId: 'disp', targetId: 'disp', targetName: 'Dispatcher' };
    await wakeDispatcher(req);
    mocks.chatMode = true;
    system.killAgent.mockRejectedValueOnce(new Error('stop failed'));
    await expect(wakeDispatcher(req, { refreshRuntime: true })).rejects.toThrow('stop failed');
    system.killAgent.mockImplementation(async () => { running = false; });
    await wakeDispatcher(req, { refreshRuntime: true });
    expect(system.killAgent).toHaveBeenCalledTimes(2);
    expect(system.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it('an action (#3042): the Dispatcher’s own subscription wakes it with no grant check', async () => {
    const req = request({ senderId: 'disp', fromAction: true, toolName: 'action', args: { actionId: 'act-1' } });
    await expect(deliverToDispatcher(req)).resolves.toEqual({ delivered: true, woke: true });
    expect(mocks.decideGrant).not.toHaveBeenCalled();
    expect(system.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'disp', mission: req.text }));
  });

  it('an action (#3042): an agent’s action follows that agent’s wake grant, and never parks an Ask first request', async () => {
    mocks.decideGrant.mockReturnValue({ outcome: 'ask' });
    const asked = await deliverToDispatcher(request({ senderId: 'lead', fromAction: true, toolName: 'action', args: { actionId: 'act-1' } }));
    expect(mocks.decideGrant).toHaveBeenCalledWith('lead', 'agent.wake', expect.anything());
    expect(asked).toMatchObject({ delivered: false });
    if (!asked.delivered) expect(asked.text).toContain('waking it asks the user first');
    expect(mocks.askFirst).not.toHaveBeenCalled();
    expect(system.spawnAgent).not.toHaveBeenCalled();
    mocks.decideGrant.mockReturnValue({ outcome: 'refuse' });
    expect(await deliverToDispatcher(request({ senderId: 'lead', fromAction: true }))).toMatchObject({ delivered: false });
    expect(system.spawnAgent).not.toHaveBeenCalled();
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
