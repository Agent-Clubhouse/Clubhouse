import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({ base: '' }));

vi.mock('../base-dir', () => ({ getBaseDirPath: () => h.base }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-config', () => ({
  updateSessionId: vi.fn(async () => undefined),
  quarantineSession: vi.fn(async () => true),
  getDurableConfig: vi.fn(async () => ({ id: 'work', lastSessionId: 'saved-native' })),
}));
vi.mock('../agent-runtime/stale-session', () => ({ noteNextStartNotice: vi.fn() }));
vi.mock('../agent-system', () => ({ isAgentRunning: vi.fn(() => false) }));
vi.mock('../agent-runtime', () => ({ getAgentRuntime: vi.fn(() => undefined) }));
vi.mock('./dispatcher-service', () => ({
  getDispatcherChatAgentId: () => 'chat',
  getDispatcherAgentId: () => 'work',
  prepareDispatcherSessionStart: vi.fn(async () => undefined),
  defaultDispatcherOrchestrator: () => 'claude-code',
  wakeDispatcherController: vi.fn(async () => undefined),
}));

import * as agentConfig from '../agent-config';
import { getAgentRuntime } from '../agent-runtime';
import { agentRegistry } from '../agent-registry';
import * as staleSession from '../agent-runtime/stale-session';
import { clearDispatcherChat, getClearChatGeneration, startDispatcherFresh, startDispatcherWorkFresh } from './dispatcher-clear-chat';
import { getDispatcherChatPath, getDispatcherMemoryPath, getDispatcherPath } from './dispatcher-paths';

h.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-clear-chat-test-'));
afterAll(() => fs.rmSync(h.base, { recursive: true, force: true }));

/** Every file under a folder with its content, to compare before and after. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = `${fs.statSync(full).mtimeMs}:${fs.readFileSync(full, 'utf8')}`;
    }
  };
  walk(dir);
  return out;
}

const memory = () => getDispatcherMemoryPath();
const newsFile = () => path.join(h.base, 'dispatcher-news.json');

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(memory(), { recursive: true, force: true });
  for (const sub of ['agents', 'timeline', 'topics']) fs.mkdirSync(path.join(memory(), sub), { recursive: true });
  fs.writeFileSync(path.join(memory(), 'index.md'), '# Index\n- agents/webapp-lead.md\n');
  fs.writeFileSync(path.join(memory(), 'agents', 'webapp-lead.md'), '## Card\nOwns checkout.\n');
  fs.writeFileSync(path.join(memory(), 'timeline', '2026-11-08.md'), '- 09:00 checkout fixed\n');
  fs.writeFileSync(path.join(memory(), 'topics', 'release.md'), 'Status: confirmed\n');
  fs.writeFileSync(newsFile(), JSON.stringify({ held: [{ text: 'Lint is green.', at: 1 }], shown: [] }));
});

describe('Clear chat', () => {
  it('starts a running chat\'s new conversation at once, with a fresh start, and leaves memory and held news alone', async () => {
    const before = snapshot(memory());
    const news = fs.readFileSync(newsFile(), 'utf8');
    const order: string[] = [];
    const result = await clearDispatcherChat({
      isRunning: () => true,
      prepareStart: async (dir, id) => { order.push(`prepare:${dir === getDispatcherChatPath()}:${id}`); },
      clearContext: async (id) => { order.push(`clear:${id}`); },
    });
    expect(result).toEqual({ cleared: 'now' });
    expect(order).toEqual(['prepare:true:chat', 'clear:chat']);
    expect(snapshot(memory())).toEqual(before);
    expect(fs.readFileSync(newsFile(), 'utf8')).toBe(news);
    expect(agentConfig.updateSessionId).not.toHaveBeenCalled();
  });

  it('makes a sleeping chat start fresh at its next wake, and leaves memory alone', async () => {
    const before = snapshot(memory());
    const result = await clearDispatcherChat();
    expect(result).toEqual({ cleared: 'next_start' });
    expect(agentConfig.updateSessionId).toHaveBeenCalledWith(getDispatcherChatPath(), 'chat', null);
    expect(snapshot(memory())).toEqual(before);
  });

  it('says so when a running chat has no runtime to clear', async () => {
    await expect(clearDispatcherChat({ isRunning: () => true, prepareStart: async () => undefined })).rejects.toThrow(/can't be cleared/);
  });

  it('counts every clear, running or sleeping, so a confirmation read before one goes stale (#3206)', async () => {
    const before = getClearChatGeneration();
    await clearDispatcherChat({ isRunning: () => false, forgetSession: async () => {} });
    await clearDispatcherChat({ isRunning: () => true, prepareStart: async () => {}, clearContext: async () => {} });
    expect(getClearChatGeneration()).toBe(before + 2);
  });
  it('refuses before the Dispatcher is set up', async () => {
    await expect(clearDispatcherChat({ chatAgentId: () => null })).rejects.toThrow(/not set up/);
  });
});

describe('the inspector session start (#3912)', () => {
  const runtimeClear = vi.fn(async () => undefined);

  function registeredAt(id: string, at: number): void {
    vi.setSystemTime(at);
    agentRegistry.register(id, { projectPath: id === 'chat' ? getDispatcherChatPath() : getDispatcherPath(), orchestrator: 'claude-code', runtime: 'chat' });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(getAgentRuntime).mockReturnValue({ clearContext: runtimeClear } as unknown as ReturnType<typeof getAgentRuntime>);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(getAgentRuntime).mockReturnValue(undefined);
    agentRegistry.untrack('chat');
    agentRegistry.untrack('work');
  });

  it('moves to the clear when a running chat is cleared in place', async () => {
    registeredAt('chat', 1_000);
    expect(agentRegistry.conversationStartedAt('chat')).toBe(1_000);
    vi.setSystemTime(9_000);
    await expect(clearDispatcherChat({ isRunning: () => true, prepareStart: async () => undefined, runningProvider: () => 'claude-code' }))
      .resolves.toEqual({ cleared: 'now' });
    expect(runtimeClear).toHaveBeenCalledTimes(1);
    expect(agentRegistry.conversationStartedAt('chat')).toBe(9_000);
  });

  it('moves to the clear when a running controller starts fresh in place', async () => {
    registeredAt('work', 2_000);
    vi.setSystemTime(7_000);
    await expect(startDispatcherWorkFresh('user', {
      isRunning: () => true, runningProvider: () => 'claude-code', workSessionId: async () => null,
      prepareStart: async () => undefined, takeWaiting: () => ({ ids: [], started: 0 }), endWaiting: () => undefined,
      addNotice: async () => undefined,
    })).resolves.toBe('now');
    expect(runtimeClear).toHaveBeenCalledTimes(1);
    expect(agentRegistry.conversationStartedAt('work')).toBe(7_000);
  });

  it('stays at the spawn when the clear fails', async () => {
    registeredAt('chat', 1_000);
    runtimeClear.mockRejectedValueOnce(new Error('busy'));
    vi.setSystemTime(9_000);
    await expect(clearDispatcherChat({ isRunning: () => true, prepareStart: async () => undefined, runningProvider: () => 'claude-code' })).rejects.toThrow('busy');
    expect(agentRegistry.conversationStartedAt('chat')).toBe(1_000);
  });
});

describe('Start fresh (#3240)', () => {
  it('quarantines a running controller conversation, starts a new one now, and says so in both conversations', async () => {
    const order: string[] = [];
    const notices: Array<[string, string]> = [];
    const chatMessages: string[] = [];
    const result = await startDispatcherFresh('work', {
      isRunning: () => true,
      workSessionId: async () => 'bad-native',
      quarantine: async (dir, id, sid) => { order.push(`quarantine:${dir === getDispatcherPath()}:${id}:${sid}`); },
      prepareStart: async (dir, id) => { order.push(`prepare:${dir === getDispatcherPath()}:${id}`); },
      clearContext: async (id) => { order.push(`clear:${id}`); },
      takeWaiting: () => { order.push('take-waiting'); return { ids: ['req_1'], started: 4 }; },
      endWaiting: (w) => { order.push(`end-waiting:${w.ids.join(',')}`); },
      addNotice: async (id, notice) => { notices.push([id, notice.code]); if (id === 'chat') chatMessages.push(notice.message); },
    });
    expect(result).toEqual({ work: 'now' });
    // Quarantined before the new conversation starts, so its end can't restore the old id;
    // the requests the old conversation would have read end once it is gone.
    // Requests are taken before the clear, so a hand-off that lands during it isn't among them.
    expect(order).toEqual(['quarantine:true:work:bad-native', 'prepare:true:work', 'take-waiting', 'clear:work', 'end-waiting:req_1']);
    expect(notices).toEqual([['work', 'started_fresh'], ['chat', 'dispatcher_work_started_fresh']]);
    expect(chatMessages.at(-1)).toContain('Dispatcher restarted.');
    // Work in progress in the old conversation is gone, so the chat says to ask again.
    expect(chatMessages.at(-1)).toContain('Ask again for anything that was in progress.');
  });

  it('quarantines a sleeping controller\'s saved session and tells its next start and the chat\'s', async () => {
    const endWaiting = vi.fn();
    const result = await startDispatcherWorkFresh('repeated_failures', { isRunning: () => false, endWaiting });
    // Nothing was running, so nothing was cut short.
    expect(endWaiting).not.toHaveBeenCalled();
    expect(result).toBe('next_start');
    expect(agentConfig.quarantineSession).toHaveBeenCalledWith(getDispatcherPath(), 'work', 'saved-native');
    expect(staleSession.noteNextStartNotice).toHaveBeenCalledWith('work', expect.objectContaining({
      code: 'started_fresh', level: 'warn',
      message: 'Started fresh. The previous controller conversation failed every turn, so Clubhouse stopped resuming it.',
    }));
  });

  it('forgets the resume id when there is no session to quarantine', async () => {
    const forget = vi.fn(async () => undefined);
    await startDispatcherWorkFresh('user', { isRunning: () => false, workSessionId: async () => null, forgetSession: forget });
    expect(forget).toHaveBeenCalledWith(getDispatcherPath(), 'work');
    expect(agentConfig.quarantineSession).not.toHaveBeenCalled();
  });

  it('starts both conversations fresh and leaves memory, held news and everything else on disk alone', async () => {
    const before = snapshot(h.base);
    const clearChat = vi.fn(async () => ({ cleared: 'next_start' as const }));
    const result = await startDispatcherFresh('both', { isRunning: () => false, workSessionId: async () => 'bad-native', clearChat });
    expect(result).toEqual({ work: 'next_start', chat: 'next_start' });
    expect(clearChat).toHaveBeenCalledTimes(1);
    expect(staleSession.noteNextStartNotice).toHaveBeenCalledWith('chat', expect.objectContaining({
      code: 'dispatcher_started_fresh', message: expect.stringContaining('Ask again for anything that was in progress.'),
    }));
    // Only the two conversations' resume ids change: agents, connections, Actions and settings are never written.
    expect(snapshot(h.base)).toEqual(before);
    expect(agentConfig.quarantineSession).toHaveBeenCalledTimes(1);
    expect(agentConfig.updateSessionId).not.toHaveBeenCalled();
  });

  it('refuses before the Dispatcher is set up', async () => {
    await expect(startDispatcherFresh('work', { workAgentId: () => null })).rejects.toThrow(/not set up/);
  });
});

describe('strict verification before Dispatcher lifecycle writes (#3686)', () => {
  it.each(['sleeping-chat', 'running-work', 'sleeping-work'] as const)('refuses %s before recovery, session changes or preparation', async (mode) => {
    const verifyPolicy = vi.fn().mockRejectedValue(new Error('Cannot verify the saved execution policy'));
    const workSessionId = vi.fn(async () => 'old-native');
    const quarantine = vi.fn();
    const forgetSession = vi.fn();
    const prepareStart = vi.fn();
    const deps = { verifyPolicy, workSessionId, quarantine, forgetSession, prepareStart, isRunning: () => mode === 'running-work' };
    await expect(mode === 'sleeping-chat' ? clearDispatcherChat(deps) : startDispatcherWorkFresh('user', deps)).rejects.toThrow('Cannot verify');
    expect(workSessionId).not.toHaveBeenCalled();
    expect(quarantine).not.toHaveBeenCalled();
    expect(forgetSession).not.toHaveBeenCalled();
    expect(prepareStart).not.toHaveBeenCalled();
  });
});

describe('a saved provider the running session isn\'t on (#3191)', () => {
  /** A Dispatcher whose agents run on Claude Code while their records name Codex. A stop really stops the agent. */
  function moved(order: string[] = []) {
    const running = new Set(['chat', 'work']);
    let holding = false;
    const deps = {
      runningProvider: (id: string) => (running.has(id) ? 'claude-code' : undefined),
      savedProvider: async () => 'codex-cli',
      isRunning: (id: string) => running.has(id),
      stopRunning: vi.fn(async (dir: string, id: string, provider: string) => {
        order.push(`stop:${dir === (id === 'chat' ? getDispatcherChatPath() : getDispatcherPath())}:${id}:${provider}${holding ? ':held' : ''}`);
        running.delete(id);
      }),
      holdDeliveries: async <T,>(_id: string, fn: () => Promise<T>): Promise<T> => {
        order.push('hold');
        holding = true;
        try { return await fn(); } finally { holding = false; order.push('release'); }
      },
      prepareStart: vi.fn(async (_dir: string, id: string) => { order.push(`prepare:${id}`); }),
      clearContext: vi.fn(async () => undefined),
      forgetSession: vi.fn(async (_dir: string, id: string) => { order.push(`forget:${id}`); }),
      quarantine: vi.fn(async (_dir: string, _id: string, sid: string) => { order.push(`quarantine:${sid}`); }),
      workSessionId: async () => 'old-native',
      takeWaiting: vi.fn(() => { order.push(`take${holding ? ':held' : ''}`); return { ids: ['req_1'], started: 2 }; }),
      endWaiting: vi.fn((w: { ids: string[] }) => { order.push(`end:${w.ids.join(',')}`); }),
      noteNextStart: vi.fn((id: string, notice: { code: string }) => { order.push(`note:${id}:${notice.code}`); }),
      wakeWork: vi.fn(async () => { order.push(`wake${holding ? ':held' : ''}`); }),
    };
    return { deps, running, order };
  }

  it('stops a running chat on its old provider instead of clearing it there, writing nothing before it has stopped', async () => {
    const { deps, order } = moved();
    const result = await clearDispatcherChat(deps);
    expect(result).toEqual({ cleared: 'next_start' });
    // Its next start prepares it, as any start does.
    expect(order).toEqual(['stop:true:chat:claude-code', 'forget:chat']);
    expect(deps.clearContext).not.toHaveBeenCalled();
  });

  it('leaves a chat whose stop fails as it was: nothing prepared, its resume id kept', async () => {
    const { deps } = moved();
    deps.stopRunning.mockRejectedValueOnce(new Error('Could not stop it.'));
    await expect(clearDispatcherChat(deps)).rejects.toThrow('Could not stop it.');
    expect(deps.prepareStart).not.toHaveBeenCalled();
    expect(deps.forgetSession).not.toHaveBeenCalled();
  });

  it('clears a running chat in place when it already runs on its saved provider', async () => {
    const { deps } = moved();
    const result = await clearDispatcherChat({ ...deps, savedProvider: async () => 'claude-code' });
    expect(result).toEqual({ cleared: 'now' });
    expect(deps.stopRunning).not.toHaveBeenCalled();
    expect(deps.clearContext).toHaveBeenCalledWith('chat');
  });

  it('stops the controller with hand-offs held, then sets its session aside, ends what it owed and starts it again idle', async () => {
    const { deps, order } = moved();
    const result = await startDispatcherWorkFresh('user', deps);
    expect(result).toBe('now');
    expect(order).toEqual([
      'hold', 'stop:true:work:claude-code:held', 'quarantine:old-native', 'take:held', 'end:req_1', 'note:work:started_fresh', 'release',
      // Started outside the hold: the start goes through the same delivery queue.
      'wake',
    ]);
    expect(deps.clearContext).not.toHaveBeenCalled();
    expect(deps.prepareStart).not.toHaveBeenCalled();
  });

  it('starts fresh in place, with no second restart, when a wake queued ahead of the hold already moved it to the saved provider', async () => {
    const { deps, order } = moved();
    let provider = 'claude-code';
    deps.runningProvider = () => provider;
    const hold = deps.holdDeliveries;
    // The queued wake runs first and restarts the idle controller on Codex.
    deps.holdDeliveries = async <T,>(id: string, fn: () => Promise<T>): Promise<T> => { provider = 'codex-cli'; return hold(id, fn); };
    const result = await startDispatcherWorkFresh('user', deps);
    expect(result).toBe('now');
    expect(deps.stopRunning).not.toHaveBeenCalled();
    expect(deps.wakeWork).not.toHaveBeenCalled();
    // Its new conversation is the one set aside and cleared.
    expect(order).toEqual(['hold', 'release', 'quarantine:old-native', 'prepare:work', 'take', 'end:req_1']);
    expect(deps.clearContext).toHaveBeenCalledWith('work');
  });

  it('ends a request the old conversation took during the stop, since the requests are read once it has stopped', async () => {
    const { deps, running } = moved();
    const owed = ['req_1'];
    // The old conversation takes one more hand-off as it stops.
    deps.stopRunning.mockImplementationOnce(async () => { owed.push('req_during_stop'); running.delete('work'); });
    // Whatever is under way when the requests are read.
    deps.takeWaiting.mockImplementation(() => ({ ids: [...owed], started: 3 }));
    await startDispatcherWorkFresh('user', deps);
    expect(deps.endWaiting).toHaveBeenCalledWith({ ids: ['req_1', 'req_during_stop'], started: 3 });
  });

  it('leaves the controller as it was when the stop fails: session, resume id and requests untouched, nothing started', async () => {
    const { deps } = moved();
    deps.stopRunning.mockRejectedValueOnce(new Error('Could not stop it.'));
    await expect(startDispatcherWorkFresh('user', deps)).rejects.toThrow('Could not stop it.');
    expect(deps.quarantine).not.toHaveBeenCalled();
    expect(deps.forgetSession).not.toHaveBeenCalled();
    expect(deps.prepareStart).not.toHaveBeenCalled();
    expect(deps.takeWaiting).not.toHaveBeenCalled();
    expect(deps.endWaiting).not.toHaveBeenCalled();
    expect(deps.noteNextStart).not.toHaveBeenCalled();
    expect(deps.wakeWork).not.toHaveBeenCalled();
  });

  it('treats a controller still running after its stop as a failed stop, and writes nothing', async () => {
    const { deps } = moved();
    deps.stopRunning.mockImplementationOnce(async () => undefined);
    await expect(startDispatcherWorkFresh('user', deps)).rejects.toThrow('still runs on its old provider');
    expect(deps.quarantine).not.toHaveBeenCalled();
    expect(deps.endWaiting).not.toHaveBeenCalled();
    expect(deps.wakeWork).not.toHaveBeenCalled();
  });

  it('reports a controller that stopped but did not start again as starting at its next message', async () => {
    const { deps } = moved();
    deps.wakeWork.mockRejectedValueOnce(new Error('No CLI.'));
    expect(await startDispatcherWorkFresh('user', deps)).toBe('next_start');
  });

  it('runs one restart per agent: a second request while one is under way joins it, failure included, and a later one runs again', async () => {
    const { deps, running } = moved();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    deps.stopRunning.mockImplementationOnce(async () => { await gate; running.delete('work'); });
    const first = startDispatcherWorkFresh('user', deps);
    const second = startDispatcherWorkFresh('user', deps);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['now', 'now']);
    expect(deps.stopRunning).toHaveBeenCalledTimes(1);
    expect(deps.wakeWork).toHaveBeenCalledTimes(1);
    running.add('work');
    deps.stopRunning.mockRejectedValueOnce(new Error('Could not stop it.'));
    const a = startDispatcherWorkFresh('user', deps);
    const b = startDispatcherWorkFresh('user', deps);
    await expect(a).rejects.toThrow('Could not stop it.');
    await expect(b).rejects.toThrow('Could not stop it.');
    expect(deps.stopRunning).toHaveBeenCalledTimes(2);
  });

  it('starts both fresh with the chat stopped too, and tells the chat at its next start', async () => {
    const { deps } = moved();
    const result = await startDispatcherFresh('both', deps);
    expect(result).toEqual({ work: 'now', chat: 'next_start' });
    expect(deps.stopRunning.mock.calls.map((c) => c[1])).toEqual(['work', 'chat']);
    expect(deps.noteNextStart).toHaveBeenCalledWith('chat', expect.objectContaining({ code: 'dispatcher_started_fresh' }));
  });
});
