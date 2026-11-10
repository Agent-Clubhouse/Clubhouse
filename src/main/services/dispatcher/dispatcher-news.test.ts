import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({
  base: '',
  delivery: null as null | ((report: unknown) => unknown),
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
}));

import {
  _resetDispatcherNewsForTesting, _whenNewsSavedForTesting, createGroupChatDelivery, getNewsStatePath, heldNews, installGroupChat, isChatHold,
  type ChatDecision, type ChatMessage, type GroupChatDeps,
} from './dispatcher-news';
import { recordAgentMessage } from './dispatcher-news-inbox';
import {
  _resetDispatcherRequestsForTesting, beginRequest, getRequest, getRequests, getRequestsPath, noteAgentReached, noteHandedOff, noteWorkEvent, workTurnMark,
} from './dispatcher-requests';
import type { ChatEvent } from '../../../shared/chat';
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

/** One of the Dispatcher's turns starting or ending. */
function turn(type: 'turn_started' | 'turn_ended'): void {
  const data = type === 'turn_started' ? { trigger: 'prompt' } : { stopReason: 'end_turn' };
  noteWorkEvent({ v: 1, agentId: 'coordinator', sessionId: 's', seq: 1, ts: now, type, data } as unknown as ChatEvent, now);
}

/** The user hands a request off, and the Dispatcher's turn reading it starts. Returns its id. */
function handOff(text = `request ${Math.random()}`): string {
  const begun = beginRequest(text, now);
  if (begun.kind !== 'new' && begun.kind !== 'again') throw new Error(`not handed off: ${begun.kind}`);
  noteHandedOff(begun.request.id, 'prompt', workTurnMark(), now);
  turn('turn_started');
  return begun.request.id;
}

function shown(decision: ChatDecision): ChatMessage {
  if (isChatHold(decision)) throw new Error(`held: ${decision.reason}`);
  return decision;
}

beforeEach(async () => {
  await _resetDispatcherNewsForTesting();
  await _resetDispatcherRequestsForTesting();
  fs.rmSync(getNewsStatePath(), { force: true });
  fs.rmSync(getRequestsPath(), { force: true });
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
    installGroupChat(deps().deps);
    handOff();
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

describe('news that names an agent Clubhouse can\'t find (#3193)', () => {
  it('is still that agent\'s news, under the name given, and doesn\'t answer the user\'s request', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    handOff();
    const message = shown(await deliver({ message: 'Should I tag from main?', from: 'release-lead', kind: 'needs_user' }));
    expect(message.text).toContain('release-lead needs the user');
    // The request is still open, so the Dispatcher's own answer to it shows.
    expect(isChatHold(await deliver({ message: 'Tagged 1.0.', kind: 'answer' }))).toBe(false);
  });
});

describe('news that never reached the chat (#3193)', () => {
  it('can be sent again, and reopens the request it answered', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    handOff();
    const first = shown(await deliver({ message: 'Tagged 1.0.', from: 'api-lead', kind: 'answer' }));
    expect(getRequests()[0].status).toBe('done');
    first.notDelivered!();
    expect(getRequests()[0].status).toBe('under_way');
    // Not a repeat, and the request is open again.
    const again = shown(await deliver({ message: 'Tagged 1.0.', from: 'api-lead', kind: 'answer' }));
    // Delivered this time: now it is a repeat, and the request is closed.
    expect(await deliver({ message: 'Tagged 1.0.', from: 'api-lead', kind: 'answer' })).toEqual({ hold: 'never', reason: 'The user was already told this.' });
    expect(again.text).toContain('Tagged 1.0.');
    expect(isChatHold(await deliver({ message: 'Tagged 1.0.1.', from: 'api-lead', kind: 'answer' }))).toBe(true);
  });

  it('holds again what a check-in took', async () => {
    const deliver = createGroupChatDelivery(deps().deps);
    await deliver({ message: 'Lint is green.', from: 'api-lead', kind: 'routine' });
    const checkIn = shown(await deliver({ message: 'One thing changed.', kind: 'check_in' }));
    expect(heldNews()).toEqual([]);
    checkIn.notDelivered!();
    expect(heldNews().map((n) => n.text)).toEqual(['Lint is green.']);
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
    const first = handOff();
    shown(await deliver({ message: 'Which project should that go in?', kind: 'needs_user' }));
    expect(getRequest(first)?.status).toBe('waiting_user');
    turn('turn_ended');
    const second = handOff();
    shown(await deliver({ message: 'Scheduled for 8:24 PM.', kind: 'answer' }));
    expect(getRequest(second)?.status).toBe('done');
    turn('turn_ended');
    expect(await deliver({ message: 'I confirmed why the tool was missing.', from: 'api-lead', kind: 'answer' }))
      .toEqual({ hold: 'later', reason: expect.stringContaining('answers no request') });
  });

  it('still shows an agent\'s answer to a request the Dispatcher passed on', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    const id = handOff();
    noteAgentReached('a2', now);
    turn('turn_ended');
    expect(isChatHold(await deliver({ message: 'Tagged 1.0.', from: 'api-lead', kind: 'answer' }))).toBe(false);
    expect(getRequest(id)?.status).toBe('done');
  });

  it('an agent\'s question doesn\'t answer the user\'s request', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    const id = handOff();
    noteAgentReached('a2', now);
    shown(await deliver({ message: 'Should I tag from main?', from: 'api-lead', kind: 'needs_user' }));
    expect(getRequest(id)?.status).toBe('waiting_user');
    expect(isChatHold(await deliver({ message: 'Tagged 1.0.', from: 'api-lead', kind: 'answer' }))).toBe(false);
    expect(getRequest(id)?.status).toBe('done');
  });
});

describe('requests keyed to their id and the agents reached for them (#3204)', () => {
  it('an unrelated question from the Dispatcher, such as a failed Action, doesn\'t close a request passed to an agent', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    const id = handOff('have api-lead tag 1.0');
    noteAgentReached('a2', now);
    turn('turn_ended');
    // A later turn of the Dispatcher's own, for a nightly Action that failed.
    turn('turn_started');
    shown(await deliver({ message: 'The nightly Action failed: a permission is missing.', kind: 'needs_user' }));
    turn('turn_ended');
    expect(getRequest(id)?.status).toBe('under_way');
    // The agent's real answer still shows right away, and closes it.
    const answer = shown(await deliver({ message: 'Tagged 1.0.', from: 'api-lead', kind: 'answer' }));
    expect(answer.text).toContain(`request ${id}`);
    expect(getRequest(id)?.status).toBe('done');
  });

  it('an agent reached for no request doesn\'t take another\'s answer', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    const id = handOff('have webapp-lead fix checkout');
    noteAgentReached('a1', now);
    turn('turn_ended');
    expect(await deliver({ message: 'Lint is fixed.', from: 'api-lead', kind: 'answer' })).toMatchObject({ hold: 'later' });
    expect(getRequest(id)?.status).toBe('under_way');
  });

  it('sends the user\'s answer to a passed-on question back under the same request', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    const id = handOff('have api-lead release');
    noteAgentReached('a2', now);
    turn('turn_ended');
    const question = shown(await deliver({ message: 'Release from main or from the release branch?', from: 'api-lead', kind: 'needs_user' }));
    expect(question.text).toContain(`start_work and request_id ${id}`);
    expect(getRequest(id)?.status).toBe('waiting_user');
    expect(beginRequest('From main.', now, id)).toMatchObject({ kind: 'again', request: { id, status: 'under_way' } });
  });

  it('takes the id the Dispatcher gives over any guess', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    const first = handOff('one');
    turn('turn_ended');
    const second = handOff('two');
    turn('turn_ended');
    // Two under way and no turn reading either: an answer without an id is for neither.
    expect(isChatHold(await deliver({ message: 'One is done.', kind: 'answer' }))).toBe(true);
    shown(await deliver({ message: 'The first one is done.', kind: 'answer', request: first }));
    expect(getRequest(first)?.status).toBe('done');
    expect(getRequest(second)?.status).toBe('under_way');
  });
});

describe('who did the work is named (#3241)', () => {
  it('credits an answer in the Dispatcher\'s own words to the one agent that did the request', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    const id = handOff('clone acme/web');
    noteAgentReached('a1', now);
    turn('turn_ended');
    now += 1000;
    recordAgentMessage('a1', 'webapp-lead', now);
    const message = shown(await deliver({ message: 'Cloned acme/web into ~/src/web.', kind: 'answer', request: id }));
    expect(message.text).toContain('News from webapp-lead that answers what the user asked');
    expect(message.note).toBe('Shown as webapp-lead\'s news, since it did this work. Set from yourself next time.');
  });

  it('keeps its own words, with a reminder, when it can\'t be sure who did it', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    // Two agents reached.
    const two = handOff('one');
    noteAgentReached('a1', now);
    noteAgentReached('a2', now);
    turn('turn_ended');
    recordAgentMessage('a1', 'webapp-lead', now + 1);
    const first = shown(await deliver({ message: 'Both are done.', kind: 'answer', request: two }));
    expect(first.text).toContain('News for the user');
    expect(first.note).toBe('If an agent did this work, set from to it, so the user knows who did it.');
    // One agent, whose last message came before the hand-off.
    recordAgentMessage('a3', 'docs-lead', now);
    now += 1000;
    const stale = handOff('two');
    noteAgentReached('a3', now);
    turn('turn_ended');
    const second = shown(await deliver({ message: 'The docs are done.', kind: 'answer', request: stale }));
    expect(second.text).toContain('News for the user');
  });

  it('leaves the Dispatcher\'s own work its own, with nothing to remind', async () => {
    installGroupChat(deps().deps);
    const deliver = h.delivery as (report: unknown) => Promise<ChatDecision>;
    const id = handOff('check git is installed');
    const message = shown(await deliver({ message: 'git 2.47 is installed.', kind: 'answer', request: id }));
    expect(message.text).toContain('News for the user');
    expect(message.note).toBeUndefined();
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
    handOff();
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
    await _resetDispatcherNewsForTesting();
    expect(h.delivery).toBeNull();
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
