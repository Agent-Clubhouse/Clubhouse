import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({
  base: '',
  delivery: null as null | ((report: unknown) => unknown),
  handOff: null as null | (() => void),
}));

vi.mock('../base-dir', () => ({ getBaseDirPath: () => h.base }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: () => [] } }));
vi.mock('../agent-config', () => ({ getDurableConfig: vi.fn(async () => null) }));
vi.mock('./dispatcher-service', () => ({
  defaultDispatcherOrchestrator: () => 'claude-code',
  getDispatcherAgentId: () => 'coordinator',
  isDispatcherIdentityAgentId: (id: string) => id === 'coordinator' || id === 'chat',
}));
vi.mock('./dispatcher-channel', () => ({
  CHAT_UPDATE_TAG: '[FROM:Clubhouse]',
  setChatDelivery: (d: ((report: unknown) => unknown) | null) => { h.delivery = d; },
  onHandOff: (listener: () => void) => { h.handOff = listener; return () => { h.handOff = null; }; },
}));

import {
  _resetDispatcherNewsForTesting, _whenNewsSavedForTesting, createGroupChatDelivery, getNewsStatePath, heldNews, installGroupChat, isChatHold,
  type ChatDecision, type ChatMessage, type GroupChatDeps,
} from './dispatcher-news';
import { recordAgentMessage } from './dispatcher-news-inbox';
import type { RewriteRequest, RewriteResult } from './dispatcher-rewrite';

const T0 = 1_700_000_000_000;
let now = T0;

h.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-news-test-'));
afterAll(() => fs.rmSync(h.base, { recursive: true, force: true }));

function deps(overrides: Partial<GroupChatDeps> = {}) {
  const rewrite = vi.fn(async (req: RewriteRequest): Promise<RewriteResult> => ({ text: `Rewritten: ${req.raw ?? req.fallback}`.slice(0, 80), by: 'rewrite' }));
  return {
    rewrite,
    deps: {
      now: () => now,
      provider: async () => 'claude-code',
      findAgent: (from: string) => (from === 'api-lead' ? { agentId: 'a2', name: 'api-lead' } : null),
      rewrite,
      ...overrides,
    } satisfies GroupChatDeps,
  };
}

function shown(decision: ChatDecision): ChatMessage {
  if (isChatHold(decision)) throw new Error(`held: ${decision.reason}`);
  return decision;
}

beforeEach(async () => {
  await _resetDispatcherNewsForTesting();
  fs.rmSync(getNewsStatePath(), { force: true });
  now = T0;
});

describe('agent news shown now', () => {
  it('shows under the agent\'s name, rewritten from what it sent, on the Dispatcher\'s provider', async () => {
    recordAgentMessage('a1', 'webapp-lead', 'TASK_RESULT:t_1abcdef: Fixed Safari checkout in #412, 41 tests pass.', now);
    const { deps: d, rewrite } = deps();
    const deliver = createGroupChatDelivery(d);
    const message = shown(await deliver({ message: 'Checkout is fixed.', from: 'webapp-lead', kind: 'needs_user' }));
    expect(rewrite).toHaveBeenCalledWith({
      provider: 'claude-code', agentName: 'webapp-lead', raw: 'TASK_RESULT:t_1abcdef: Fixed Safari checkout in #412, 41 tests pass.', fallback: 'Checkout is fixed.',
    });
    expect(message.routed).toEqual([{ sender: { agentId: 'a1', name: 'webapp-lead' }, text: expect.stringMatching(/^Rewritten: /) }]);
    // The chat is told the person has read it, so it doesn't repeat it.
    expect(message.text.startsWith('[FROM:Clubhouse]')).toBe(true);
    expect(message.text).toContain('has already read it');
  });

  it('takes the raw message once: the next news from that agent has none of it', async () => {
    recordAgentMessage('a1', 'webapp-lead', 'First report.', now);
    const { deps: d, rewrite } = deps();
    const deliver = createGroupChatDelivery(d);
    await deliver({ message: 'First.', from: 'a1', kind: 'needs_user' });
    await deliver({ message: 'Second thing needs you.', from: 'webapp-lead', kind: 'needs_user' });
    // Not in the inbox any more, so the name is found among the wired agents, or not at all.
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('finds an agent that hasn\'t messaged lately among the agents wired to the Dispatcher', async () => {
    const { deps: d, rewrite } = deps();
    const message = shown(await createGroupChatDelivery(d)({ message: 'Deploy is blocked on a key.', from: 'api-lead', kind: 'needs_user' }));
    expect(rewrite.mock.calls[0][0]).toMatchObject({ agentName: 'api-lead', raw: undefined, fallback: 'Deploy is blocked on a key.' });
    expect(message.routed[0].sender).toEqual({ agentId: 'a2', name: 'api-lead' });
  });

  it('uses the Dispatcher\'s version when the rewrite fails outright', async () => {
    recordAgentMessage('a1', 'webapp-lead', 'raw', now);
    const { deps: d } = deps({ rewrite: async () => { throw new Error('boom'); } });
    const message = shown(await createGroupChatDelivery(d)({ message: 'Checkout is fixed (task_id=t_1abcdef).', from: 'a1', kind: 'needs_user' }));
    expect(message.routed[0].text).toBe('Checkout is fixed.');
  });

  it('keeps reports in the order they were made, even when a rewrite is slow', async () => {
    recordAgentMessage('a1', 'webapp-lead', 'slow one', now);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const { deps: d } = deps({
      rewrite: async (req) => { if (req.raw === 'slow one') await gate; return { text: req.fallback, by: 'fallback' }; },
    });
    const deliver = createGroupChatDelivery(d);
    const first = deliver({ message: 'First.', from: 'a1', kind: 'needs_user' }).then(() => order.push('first'));
    const second = deliver({ message: 'Second.', kind: 'needs_user' }).then(() => order.push('second'));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });
});

describe('the Dispatcher\'s own words', () => {
  it('reach the chat as a Clubhouse update, which the group chat doesn\'t show by name', async () => {
    const { deps: d, rewrite } = deps();
    const message = shown(await createGroupChatDelivery(d)({ message: 'release-lead is asleep. Want me to wake it?' }));
    expect(message.routed).toEqual([{ fromClubhouse: true, text: 'release-lead is asleep. Want me to wake it?' }]);
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('are its own even when it names one of its own agents', async () => {
    recordAgentMessage('chat', 'Conversation', 'x', now);
    const { deps: d, rewrite } = deps({ findAgent: () => ({ agentId: 'coordinator', name: 'Dispatcher' }) });
    const message = shown(await createGroupChatDelivery(d)({ message: 'All done.', from: 'Dispatcher', kind: 'needs_user' }));
    expect(message.routed[0].fromClubhouse).toBe(true);
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('never shows tool noise', async () => {
    const { deps: d } = deps();
    const message = shown(await createGroupChatDelivery(d)({ message: 'Done.\n```json\n{"ok":true}\n```\n---\nReply to x via tool "send_message" with task_id="t_1abcdef".' }));
    expect(message.routed[0].text).toBe('Done.');
    expect(message.text).not.toMatch(/json|task_id|send_message/);
  });
});

describe('news held for a check-in', () => {
  it('holds routine news, then shows it with the next check-in, and only then', async () => {
    const { deps: d, rewrite } = deps();
    const deliver = createGroupChatDelivery(d);
    expect(await deliver({ message: 'Nothing new.', kind: 'check_in' })).toEqual({ hold: 'never', reason: expect.stringContaining('Nothing changed') });

    recordAgentMessage('a1', 'webapp-lead', 'lint fixed', now);
    expect(await deliver({ message: 'Lint is green again.', from: 'a1', kind: 'routine' })).toEqual({ hold: 'later', reason: 'Held for the next check-in summary.' });
    expect(rewrite).not.toHaveBeenCalled();
    expect(heldNews()).toEqual([{ text: 'Lint is green again.', fromAgentId: 'a1', fromName: 'webapp-lead', at: T0 }]);

    const checkIn = shown(await deliver({ message: 'webapp-lead fixed lint.', kind: 'check_in' }));
    expect(checkIn.text).toContain('- webapp-lead: Lint is green again.');
    expect(checkIn.text).toContain('webapp-lead fixed lint.');
    expect(checkIn.routed).toEqual([{ fromClubhouse: true, text: 'webapp-lead fixed lint.' }]);
    expect(heldNews()).toEqual([]);
    expect(isChatHold(await deliver({ message: 'webapp-lead fixed lint.', kind: 'check_in' }))).toBe(true);
  });

  it('holds an answer to nothing the person asked, and shows one to a request they made', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    expect(isChatHold(await deliver({ message: 'Tagged 1.0.', kind: 'answer' }))).toBe(true);
    h.handOff!();
    expect(isChatHold(await deliver({ message: 'Tagged 1.0.1.', kind: 'answer' }))).toBe(false);
    // That answer closed the request.
    expect(isChatHold(await deliver({ message: 'Tagged 1.0.2.', kind: 'answer' }))).toBe(true);
  });

  it('never shows the same news twice', async () => {
    const { deps: d } = deps();
    const deliver = createGroupChatDelivery(d);
    shown(await deliver({ message: 'Can I merge #412?', kind: 'needs_user' }));
    expect(await deliver({ message: 'can I merge #412', kind: 'needs_user' })).toEqual({ hold: 'never', reason: 'The user was already told this.' });
    // An agent's news is a repeat by what the Dispatcher wrote, whatever the rewrite made of it.
    recordAgentMessage('a1', 'webapp-lead', 'raw words', now);
    shown(await deliver({ message: 'Checkout is fixed.', from: 'a1', kind: 'needs_user' }));
    recordAgentMessage('a1', 'webapp-lead', 'raw again', now);
    expect(await deliver({ message: 'Checkout is fixed', from: 'webapp-lead', kind: 'needs_user' })).toEqual({ hold: 'never', reason: 'The user was already told this.' });
  });
});

describe('state', () => {
  it('is saved beside the Dispatcher\'s folders and survives a restart', async () => {
    const { deps: d } = deps();
    await createGroupChatDelivery(d)({ message: 'Lint is green.', kind: 'routine' });
    await _whenNewsSavedForTesting();
    expect(getNewsStatePath()).toBe(path.join(h.base, 'dispatcher-news.json'));
    expect(JSON.parse(fs.readFileSync(getNewsStatePath(), 'utf8')).held).toHaveLength(1);
    await _resetDispatcherNewsForTesting();
    expect(heldNews()).toEqual([{ text: 'Lint is green.', at: T0 }]);
  });

  it('starts empty from a file it can\'t read', async () => {
    fs.writeFileSync(getNewsStatePath(), '{not json');
    expect(heldNews()).toEqual([]);
  });

  it('installs and uninstalls the group chat step', async () => {
    installGroupChat(deps().deps);
    expect(h.delivery).toBeTypeOf('function');
    expect(h.handOff).toBeTypeOf('function');
    await _resetDispatcherNewsForTesting();
    expect(h.delivery).toBeNull();
    expect(h.handOff).toBeNull();
  });
});
