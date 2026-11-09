import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('./dispatcher-service', () => ({
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
import { groupChatMessage } from '../../../shared/dispatcher-group-chat';
import { captureEvents, type EventCapture } from '../../telemetry/__test-utils__/event-capture';

const T0 = 1_700_000_000_000;
let now = T0;

h.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-news-test-'));
afterAll(() => fs.rmSync(h.base, { recursive: true, force: true }));

function deps(overrides: Partial<GroupChatDeps> = {}) {
  return {
    deps: {
      now: () => now,
      findAgent: (from: string) => (from === 'api-lead' ? { agentId: 'a2', name: 'api-lead' } : null),
      ...overrides,
    } satisfies GroupChatDeps,
  };
}

/** What the user sees of a message the chat receives, before the chat's own reply: nothing, for news (#3193). */
function seenInChat(message: ChatMessage) {
  return groupChatMessage({ source: 'mcp', text: message.text, routed: message.routed }, { ownAgentIds: new Set(['coordinator', 'chat']) });
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

describe('agent news shown now (#3193)', () => {
  it('reaches the chat to say in its own voice, naming the agent, and shows no row of its own', async () => {
    recordAgentMessage('a1', 'webapp-lead', now);
    const deliver = createGroupChatDelivery(deps().deps);
    const message = shown(await deliver({ message: 'Can I merge #412 now, or wait for the release?', from: 'webapp-lead', kind: 'needs_user' }));
    expect(message.text.startsWith('[FROM:Clubhouse]')).toBe(true);
    expect(message.text).toContain('webapp-lead needs the user');
    expect(message.text).toContain('Can I merge #412 now, or wait for the release?');
    // The user answers in the chat, never by replying to the agent.
    expect(message.text).toContain('They answer here');
    expect(message.text).toContain('start_work');
    // Nothing shows until the chat says it, so its reply is the only time the user reads it.
    expect(message.routed).toEqual([{ fromClubhouse: true, text: 'Can I merge #412 now, or wait for the release?' }]);
    expect(seenInChat(message)).toBeNull();
  });

  it('asks for no acknowledgment turn: the chat\'s reply is the news', async () => {
    const deliver = createGroupChatDelivery(deps().deps);
    h.handOff = null;
    installGroupChat(deps().deps);
    h.handOff!();
    const answer = shown(await (h.delivery as (r: unknown) => Promise<ChatDecision>)({ message: 'Checkout is fixed in #412.', from: 'api-lead', kind: 'answer' }));
    const question = shown(await deliver({ message: 'Which branch should I release from?', from: 'api-lead', kind: 'needs_user' }));
    for (const message of [answer, question]) {
      expect(message.text).toContain('no acknowledgment');
      expect(message.text).not.toContain('already read');
      expect(seenInChat(message)).toBeNull();
    }
    expect(answer.text).toContain('News from api-lead that answers what the user asked');
  });

  it('keeps the whole question, cleaned of tool noise but not cut to two sentences', async () => {
    const message = 'For Dispatcher model settings (#3191), should I add (A) separate choices, (B) rows on the presets page, or (C) one choice? '
      + 'The device issue is narrowed down. A phone check is pending (task_id=t_1abcdef).';
    const decision = shown(await createGroupChatDelivery(deps().deps)({ message, from: 'api-lead', kind: 'needs_user' }));
    expect(decision.routed[0].text).toContain('A phone check is pending.');
    expect(decision.text).not.toContain('task_id');
  });

  it('shows a question that needs the user once', async () => {
    const deliver = createGroupChatDelivery(deps().deps);
    shown(await deliver({ message: 'Should deletion be on by default?', from: 'api-lead', kind: 'needs_user' }));
    expect(await deliver({ message: 'should deletion be on by default', from: 'api-lead', kind: 'needs_user' }))
      .toEqual({ hold: 'never', reason: 'The user was already told this.' });
  });

  it('finds an agent that hasn\'t messaged lately among the agents wired to the Dispatcher', async () => {
    const message = shown(await createGroupChatDelivery(deps().deps)({ message: 'Deploy is blocked on a key.', from: 'api-lead', kind: 'needs_user' }));
    expect(message.text).toContain('api-lead needs the user');
  });

  it('keeps reports in the order they were made', async () => {
    const order: string[] = [];
    const deliver = createGroupChatDelivery(deps().deps);
    const first = deliver({ message: 'First.', from: 'api-lead', kind: 'needs_user' }).then(() => order.push('first'));
    const second = deliver({ message: 'Second.', kind: 'needs_user' }).then(() => order.push('second'));
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });
});

describe('an agent\'s routine traffic stays out of the chat (#3193)', () => {
  it('holds routine progress for the check-in', async () => {
    const deliver = createGroupChatDelivery(deps().deps);
    expect(await deliver({ message: 'Five helpers are running.', from: 'api-lead', kind: 'routine' }))
      .toEqual({ hold: 'later', reason: 'Held for the next check-in summary.' });
  });

  it('holds an agent\'s later "answer" once the Dispatcher has replied to each request', async () => {
    // As on 2026-11-08: the user's requests got replies that weren't answers (questions back, problems),
    // so they stayed open, and an orchestrator's progress, called an answer, showed in the chat.
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    h.handOff!();
    shown(await deliver({ message: 'Which project should that go in?', kind: 'needs_user' }));
    h.handOff!();
    shown(await deliver({ message: 'Scheduled for 8:24 PM.', kind: 'answer' }));
    expect(await deliver({ message: 'I confirmed why the tool was missing.', from: 'api-lead', kind: 'answer' }))
      .toEqual({ hold: 'later', reason: expect.stringContaining('no open request') });
  });

  it('still shows an agent\'s answer to a request the Dispatcher passed on', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    h.handOff!();
    expect(isChatHold(await deliver({ message: 'Tagged 1.0.', from: 'api-lead', kind: 'answer' }))).toBe(false);
  });

  it('an agent\'s question doesn\'t answer the user\'s request', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    h.handOff!();
    shown(await deliver({ message: 'Should I tag from main?', from: 'api-lead', kind: 'needs_user' }));
    expect(isChatHold(await deliver({ message: 'Tagged 1.0.', from: 'api-lead', kind: 'answer' }))).toBe(false);
  });
});

describe('the Dispatcher\'s own words', () => {
  it('reach the chat as a Clubhouse update, which the group chat doesn\'t show by name', async () => {
    const { deps: d } = deps();
    const message = shown(await createGroupChatDelivery(d)({ message: 'release-lead is asleep. Want me to wake it?' }));
    expect(message.routed).toEqual([{ fromClubhouse: true, text: 'release-lead is asleep. Want me to wake it?' }]);
    expect(message.text).toContain('News for the user.');
  });

  it('are its own even when it names one of its own agents', async () => {
    recordAgentMessage('chat', 'Conversation', now);
    const { deps: d } = deps({ findAgent: () => ({ agentId: 'coordinator', name: 'Dispatcher' }) });
    const message = shown(await createGroupChatDelivery(d)({ message: 'All done.', from: 'Dispatcher', kind: 'needs_user' }));
    expect(message.routed[0].fromClubhouse).toBe(true);
    expect(message.text).toContain('News for the user.');
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
    const { deps: d } = deps();
    const deliver = createGroupChatDelivery(d);
    expect(await deliver({ message: 'Nothing new.', kind: 'check_in' })).toEqual({ hold: 'never', reason: expect.stringContaining('Nothing changed') });

    recordAgentMessage('a1', 'webapp-lead', now);
    expect(await deliver({ message: 'Lint is green again.', from: 'a1', kind: 'routine' })).toEqual({ hold: 'later', reason: 'Held for the next check-in summary.' });
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
    // An agent's news is a repeat whether the Dispatcher names it by id or by name.
    recordAgentMessage('a1', 'webapp-lead', now);
    shown(await deliver({ message: 'Checkout is fixed.', from: 'a1', kind: 'needs_user' }));
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

describe('triage telemetry (#3052)', () => {
  let capture: EventCapture | null = null;
  afterEach(() => { capture?.stop(); capture = null; });

  const outcomes = () => capture!.named('clubhouse.dispatcher.news_triage').map((e) => e.attrs);

  it('records each outcome while telemetry is on, with no names or text', async () => {
    capture = captureEvents();
    recordAgentMessage('a1', 'acme-webapp-lead', now);
    const { deps: d } = deps();
    const deliver = createGroupChatDelivery(d);
    await deliver({ message: 'Acme checkout is fixed.', from: 'a1', kind: 'needs_user' });
    await deliver({ message: 'Acme nightly build passed.', from: 'api-lead', kind: 'routine' });
    await deliver({ message: 'Acme nightly build passed.', from: 'api-lead', kind: 'routine' });
    await deliver({ message: 'Acme answer nobody asked for.', kind: 'answer' });
    await deliver({ message: 'Here is what happened at Acme.', kind: 'check_in' });
    await deliver({ message: 'Nothing new at Acme.', kind: 'check_in' });
    await deliver({ message: 'Acme release-lead is asleep.' });

    const base = { 'clubhouse.dispatcher.news.rewrite': 'none', 'clubhouse.dispatcher.news.rewrite_reason': 'none' };
    expect(outcomes()).toEqual([
      {
        'clubhouse.dispatcher.news.kind': 'needs_user', 'clubhouse.dispatcher.news.show': 'now', 'clubhouse.dispatcher.news.reason': 'needs_user',
        'clubhouse.dispatcher.news.from_agent': true, ...base,
      },
      { 'clubhouse.dispatcher.news.kind': 'routine', 'clubhouse.dispatcher.news.show': 'later', 'clubhouse.dispatcher.news.reason': 'routine', 'clubhouse.dispatcher.news.from_agent': true, ...base },
      { 'clubhouse.dispatcher.news.kind': 'routine', 'clubhouse.dispatcher.news.show': 'never', 'clubhouse.dispatcher.news.reason': 'duplicate', 'clubhouse.dispatcher.news.from_agent': true, ...base },
      { 'clubhouse.dispatcher.news.kind': 'answer', 'clubhouse.dispatcher.news.show': 'later', 'clubhouse.dispatcher.news.reason': 'nothing_asked', 'clubhouse.dispatcher.news.from_agent': false, ...base },
      {
        'clubhouse.dispatcher.news.kind': 'check_in', 'clubhouse.dispatcher.news.show': 'check_in', 'clubhouse.dispatcher.news.reason': 'none',
        'clubhouse.dispatcher.news.from_agent': false, 'clubhouse.dispatcher.news.held': 2, ...base,
      },
      { 'clubhouse.dispatcher.news.kind': 'check_in', 'clubhouse.dispatcher.news.show': 'never', 'clubhouse.dispatcher.news.reason': 'nothing_changed', 'clubhouse.dispatcher.news.from_agent': false, ...base },
      { 'clubhouse.dispatcher.news.kind': 'needs_user', 'clubhouse.dispatcher.news.show': 'now', 'clubhouse.dispatcher.news.reason': 'needs_user', 'clubhouse.dispatcher.news.from_agent': false, ...base },
    ]);
    expect(JSON.stringify(capture.events)).not.toMatch(/acme|alice|example\.com|\/Users|api-lead|a1|a2/i);
  });

  it('records nothing while telemetry is off, and the chat works the same', async () => {
    const { deps: d } = deps();
    shown(await createGroupChatDelivery(d)({ message: 'Deploy is blocked on a key.', from: 'api-lead', kind: 'needs_user' }));
    capture = captureEvents();
    expect(capture.events).toEqual([]);
  });
});
