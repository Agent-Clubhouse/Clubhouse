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
  it('quarantines a running work conversation, starts a new one now, and says so in both conversations', async () => {
    const order: string[] = [];
    const notices: Array<[string, string]> = [];
    const result = await startDispatcherFresh('work', {
      isRunning: () => true,
      workSessionId: async () => 'bad-native',
      quarantine: async (dir, id, sid) => { order.push(`quarantine:${dir === getDispatcherPath()}:${id}:${sid}`); },
      prepareStart: async (dir, id) => { order.push(`prepare:${dir === getDispatcherPath()}:${id}`); },
      clearContext: async (id) => { order.push(`clear:${id}`); },
      endWaiting: () => { order.push('end-waiting'); },
      addNotice: async (id, notice) => { notices.push([id, notice.code]); },
    });
    expect(result).toEqual({ work: 'now' });
    // Quarantined before the new conversation starts, so its end can't restore the old id;
    // the requests the old conversation would have read end once it is gone.
    expect(order).toEqual(['quarantine:true:work:bad-native', 'prepare:true:work', 'clear:work', 'end-waiting']);
    expect(notices).toEqual([['work', 'started_fresh'], ['chat', 'dispatcher_work_started_fresh']]);
  });

  it('quarantines a sleeping work agent\'s saved session and tells its next start and the chat\'s', async () => {
    const endWaiting = vi.fn();
    const result = await startDispatcherWorkFresh('repeated_failures', { isRunning: () => false, endWaiting });
    // Nothing was running, so nothing was cut short.
    expect(endWaiting).not.toHaveBeenCalled();
    expect(result).toBe('next_start');
    expect(agentConfig.quarantineSession).toHaveBeenCalledWith(getDispatcherPath(), 'work', 'saved-native');
    expect(staleSession.noteNextStartNotice).toHaveBeenCalledWith('work', expect.objectContaining({ code: 'started_fresh', level: 'warn' }));
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
    expect(staleSession.noteNextStartNotice).toHaveBeenCalledWith('chat', expect.objectContaining({ code: 'dispatcher_started_fresh' }));
    // Only the two conversations' resume ids change: agents, connections, Actions and settings are never written.
    expect(snapshot(h.base)).toEqual(before);
    expect(agentConfig.quarantineSession).toHaveBeenCalledTimes(1);
    expect(agentConfig.updateSessionId).not.toHaveBeenCalled();
  });

  it('refuses before the Dispatcher is set up', async () => {
    await expect(startDispatcherFresh('work', { workAgentId: () => null })).rejects.toThrow(/not set up/);
  });
});
