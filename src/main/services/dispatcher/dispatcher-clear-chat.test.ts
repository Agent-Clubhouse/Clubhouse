import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const moved = { runningProvider: () => 'claude-code', savedProvider: async () => 'codex-cli' };

  it('stops a running chat on its old provider instead of clearing it there, so its next message starts on the saved one', async () => {
    const order: string[] = [];
    const clearContext = vi.fn(async () => undefined);
    const result = await clearDispatcherChat({
      ...moved,
      isRunning: () => true,
      prepareStart: async (_dir, id) => { order.push(`prepare:${id}`); },
      stopRunning: async (dir, id, provider) => { order.push(`stop:${dir === getDispatcherChatPath()}:${id}:${provider}`); },
      forgetSession: async (_dir, id) => { order.push(`forget:${id}`); },
      clearContext,
    });
    expect(result).toEqual({ cleared: 'next_start' });
    expect(order).toEqual(['prepare:chat', 'stop:true:chat:claude-code', 'forget:chat']);
    expect(clearContext).not.toHaveBeenCalled();
  });

  it('clears a running chat in place when it already runs on its saved provider', async () => {
    const stopRunning = vi.fn(async () => undefined);
    const clearContext = vi.fn(async () => undefined);
    const result = await clearDispatcherChat({
      runningProvider: () => 'codex-cli', savedProvider: async () => 'codex-cli',
      isRunning: () => true, prepareStart: async () => undefined, stopRunning, clearContext,
    });
    expect(result).toEqual({ cleared: 'now' });
    expect(stopRunning).not.toHaveBeenCalled();
    expect(clearContext).toHaveBeenCalledWith('chat');
  });

  it('stops the controller before starting it again idle on the saved provider, ending what the old conversation owed', async () => {
    const order: string[] = [];
    const clearContext = vi.fn(async () => undefined);
    const result = await startDispatcherWorkFresh('user', {
      ...moved,
      isRunning: () => true,
      workSessionId: async () => 'old-native',
      quarantine: async (_dir, _id, sid) => { order.push(`quarantine:${sid}`); },
      prepareStart: async () => { order.push('prepare'); },
      takeWaiting: () => { order.push('take-waiting'); return { ids: ['req_1'], started: 2 }; },
      stopRunning: async (dir, id, provider) => { order.push(`stop:${dir === getDispatcherPath()}:${id}:${provider}`); },
      endWaiting: (w) => { order.push(`end-waiting:${w.ids.join(',')}`); },
      noteNextStart: (id, notice) => { order.push(`note:${id}:${notice.code}`); },
      wakeWork: async () => { order.push('wake'); },
      clearContext,
    });
    expect(result).toBe('now');
    expect(order).toEqual(['quarantine:old-native', 'prepare', 'take-waiting', 'stop:true:work:claude-code', 'end-waiting:req_1', 'note:work:started_fresh', 'wake']);
    expect(clearContext).not.toHaveBeenCalled();
  });

  it('leaves the controller running and its requests under way when the stop fails, and starts nothing', async () => {
    const endWaiting = vi.fn();
    const wakeWork = vi.fn(async () => undefined);
    await expect(startDispatcherWorkFresh('user', {
      ...moved,
      isRunning: () => true, workSessionId: async () => null, forgetSession: async () => undefined, prepareStart: async () => undefined,
      takeWaiting: () => ({ ids: ['req_1'], started: 1 }),
      stopRunning: async () => { throw new Error('Could not stop it.'); },
      endWaiting, wakeWork,
    })).rejects.toThrow('Could not stop it.');
    expect(endWaiting).not.toHaveBeenCalled();
    expect(wakeWork).not.toHaveBeenCalled();
  });

  it('reports a controller that stopped but did not start again as starting at its next message', async () => {
    const result = await startDispatcherWorkFresh('user', {
      ...moved,
      isRunning: () => true, workSessionId: async () => null, forgetSession: async () => undefined, prepareStart: async () => undefined,
      takeWaiting: () => ({ ids: [], started: 0 }), endWaiting: () => undefined, noteNextStart: () => undefined,
      stopRunning: async () => undefined,
      wakeWork: async () => { throw new Error('No CLI.'); },
    });
    expect(result).toBe('next_start');
  });

  it('runs one restart per agent: a second request while one is under way joins it rather than stopping or starting again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stopRunning = vi.fn(async () => { await gate; });
    const wakeWork = vi.fn(async () => undefined);
    const deps = {
      ...moved,
      isRunning: () => true, workSessionId: async () => null, forgetSession: async () => undefined, prepareStart: async () => undefined,
      takeWaiting: () => ({ ids: [], started: 0 }), endWaiting: () => undefined, noteNextStart: () => undefined,
      stopRunning, wakeWork,
    };
    const first = startDispatcherWorkFresh('user', deps);
    const second = startDispatcherWorkFresh('user', deps);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['now', 'now']);
    expect(stopRunning).toHaveBeenCalledTimes(1);
    expect(wakeWork).toHaveBeenCalledTimes(1);
    // Once it's done, a later request runs again.
    await startDispatcherWorkFresh('user', deps);
    expect(stopRunning).toHaveBeenCalledTimes(2);
  });

  it('starts both fresh with the chat stopped too, and tells the chat at its next start', async () => {
    let chatRunning = true;
    const stopRunning = vi.fn(async (_dir: string, id: string) => { if (id === 'chat') chatRunning = false; });
    const noteNextStart = vi.fn();
    const result = await startDispatcherFresh('both', {
      ...moved,
      isRunning: (id) => (id === 'chat' ? chatRunning : true),
      workSessionId: async () => null, forgetSession: async () => undefined, prepareStart: async () => undefined,
      takeWaiting: () => ({ ids: [], started: 0 }), endWaiting: () => undefined,
      stopRunning, noteNextStart, wakeWork: async () => undefined,
    });
    expect(result).toEqual({ work: 'now', chat: 'next_start' });
    expect(stopRunning.mock.calls.map((c) => c[1])).toEqual(['work', 'chat']);
    expect(noteNextStart).toHaveBeenCalledWith('chat', expect.objectContaining({ code: 'dispatcher_started_fresh' }));
  });
});
