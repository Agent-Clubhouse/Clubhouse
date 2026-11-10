import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({ base: '' }));

vi.mock('../base-dir', () => ({ getBaseDirPath: () => h.base }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import type { ChatEvent, ChatEventDataMap } from '../../../shared/chat';
import {
  QUIET_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  REQUEST_TTL_MS,
  _resetDispatcherRequestsForTesting,
  _whenRequestsSavedForTesting,
  beginRequest,
  checkRequestTimeouts,
  getRequest,
  getRequests,
  getRequestsPath,
  matchRequest,
  noteAgentReached,
  noteHandedOff,
  noteWorkEvent,
  endWaitingRequests,
  onRequestsChanged,
  requestsUnderWay,
  setRequestEndedHandler,
  settleRequest,
  withdrawRequest,
  workTurnMark,
  type DispatcherRequest,
} from './dispatcher-requests';

const T0 = 1_700_000_000_000;
let now = T0;

h.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-requests-test-'));
afterAll(() => fs.rmSync(h.base, { recursive: true, force: true }));

function event<T extends keyof ChatEventDataMap>(type: T, data: ChatEventDataMap[T]): ChatEvent {
  return { v: 1, agentId: 'coordinator', sessionId: 's', seq: 1, ts: now, type, data } as unknown as ChatEvent;
}

const started = () => noteWorkEvent(event('turn_started', { trigger: 'prompt' }), now);
const ended = (stopReason: ChatEventDataMap['turn_ended']['stopReason'] = 'end_turn') => noteWorkEvent(event('turn_ended', { stopReason }), now);

/** A request handed off as `delivery`. Returns its id. */
function handOff(text: string, delivery: Parameters<typeof noteHandedOff>[1] = 'prompt'): string {
  const begun = beginRequest(text, now);
  if (begun.kind !== 'new' && begun.kind !== 'again') throw new Error(begun.kind);
  noteHandedOff(begun.request.id, delivery, workTurnMark(), now);
  return begun.request.id;
}

const ended$ = vi.fn();

beforeEach(async () => {
  await _resetDispatcherRequestsForTesting();
  fs.rmSync(getRequestsPath(), { force: true });
  now = T0;
  ended$.mockReset();
  setRequestEndedHandler(ended$);
});

function req(over: Partial<DispatcherRequest>): DispatcherRequest {
  return { id: 'r', text: 't', at: T0, handedOffAt: T0, status: 'under_way', turn: 'past', agents: [], ...over };
}

describe('matchRequest (#3204)', () => {
  it('takes the id the Dispatcher gives, whatever the request\'s state', () => {
    const done = req({ id: 'a', status: 'done' });
    expect(matchRequest([done, req({ id: 'b' })], { kind: 'answer', request: 'a' }, T0)).toBe(done);
  });

  it('keys an agent\'s news to the request that agent was reached for, and to nothing else', () => {
    const a = req({ id: 'a', agents: ['x'] });
    const b = req({ id: 'b', agents: ['y'], handedOffAt: T0 + 1 });
    expect(matchRequest([a, b], { kind: 'answer', fromAgentId: 'x', fromName: 'x-lead' }, T0 + 2)).toBe(a);
    expect(matchRequest([a, b], { kind: 'answer', fromAgentId: 'z', fromName: 'z-lead' }, T0 + 2)).toBeUndefined();
  });

  it('keys an agent\'s news only to an open request, so its progress after one closed isn\'t an answer', () => {
    for (const status of ['done', 'failed', 'cancelled', 'timed_out'] as const) {
      expect(matchRequest([req({ id: 'a', agents: ['x'], status })], { kind: 'answer', fromAgentId: 'x', fromName: 'x-lead' }, T0)).toBeUndefined();
    }
    const waiting = req({ id: 'b', agents: ['x'], status: 'waiting_user' });
    expect(matchRequest([req({ id: 'a', agents: ['x'], status: 'done', handedOffAt: T0 + 1 }), waiting], { kind: 'answer', fromAgentId: 'x', fromName: 'x-lead' }, T0 + 2)).toBe(waiting);
  });

  it('keys the Dispatcher\'s own words to the request its turn is reading, and nothing in any other turn', () => {
    const reading = req({ id: 'a', turn: 'in_turn' });
    const waiting = req({ id: 'b', agents: ['x'] });
    expect(matchRequest([waiting, reading], { kind: 'needs_user' }, T0)).toBe(reading);
    // A failed Action or a missing permission, reported in a turn of its own.
    expect(matchRequest([waiting], { kind: 'needs_user' }, T0)).toBeUndefined();
  });

  it('gives an answer to the one request under way when nothing else could be meant', () => {
    const only = req({ id: 'a' });
    expect(matchRequest([only], { kind: 'answer' }, T0)).toBe(only);
    expect(matchRequest([only], { kind: 'answer', fromName: 'release-lead' }, T0)).toBe(only);
    expect(matchRequest([only, req({ id: 'b' })], { kind: 'answer' }, T0)).toBeUndefined();
    expect(matchRequest([req({ id: 'c', agents: ['x'] })], { kind: 'answer', fromName: 'release-lead' }, T0)).toBeUndefined();
  });

  it('matches only answers and questions, and only requests from the last week', () => {
    expect(matchRequest([req({ id: 'a', turn: 'in_turn' })], { kind: 'routine' }, T0)).toBeUndefined();
    expect(matchRequest([req({ id: 'a' })], { kind: 'answer', request: 'a' }, T0 + REQUEST_TTL_MS)).toBeUndefined();
  });
});

describe('starting a request', () => {
  it('gives each one a stable id and counts it under way', () => {
    const changed = vi.fn();
    onRequestsChanged(changed);
    const begun = beginRequest('tag 1.0', now);
    expect(begun).toMatchObject({ kind: 'new', request: { id: expect.stringMatching(/^req_/), status: 'under_way', turn: 'sending' } });
    expect(requestsUnderWay()).toBe(1);
    expect(changed).toHaveBeenCalled();
  });

  it('doesn\'t start the same words twice while they are under way', () => {
    const id = handOff('Tag 1.0.');
    expect(beginRequest('tag 1.0', now)).toMatchObject({ kind: 'already', request: { id } });
  });

  it('retries a request that failed under its own id, by id or by the same words', () => {
    const id = handOff('tag 1.0');
    started();
    ended('error');
    expect(getRequest(id)?.status).toBe('failed');
    expect(beginRequest('Tag 1.0', now + 5)).toMatchObject({ kind: 'again', request: { id, status: 'under_way', handedOffAt: now + 5 } });
    expect(getRequests()).toHaveLength(1);
  });

  it('refuses an id it doesn\'t know', () => {
    expect(beginRequest('x', now, 'req_nope')).toEqual({ kind: 'unknown' });
  });

  it('withdraws a new request, and puts back one handed off again, when the hand-off fails', () => {
    const fresh = beginRequest('one', now);
    withdrawRequest(fresh, now);
    expect(getRequests()).toEqual([]);
    const id = handOff('two');
    started();
    ended('cancelled');
    const again = beginRequest('two', now, id);
    withdrawRequest(again, now);
    expect(getRequest(id)?.status).toBe('cancelled');
  });
});

describe('following the Dispatcher\'s turns (#3237)', () => {
  it('a request read in a turn that ends well stays under way until its outcome comes back', () => {
    const id = handOff('have api-lead fix lint');
    started();
    expect(getRequest(id)?.turn).toBe('in_turn');
    ended();
    expect(getRequest(id)).toMatchObject({ status: 'under_way', turn: 'past' });
    expect(ended$).not.toHaveBeenCalled();
  });

  it('a turn that fails after the hand-off was accepted ends the request, and says why', () => {
    const id = handOff('tag 1.0');
    started();
    noteWorkEvent(event('error', { code: 'provider_error', message: 'Rate limited', fatal: false } as ChatEventDataMap['error']), now);
    ended('error');
    expect(getRequest(id)).toMatchObject({ status: 'failed', endedAt: now });
    expect(ended$).toHaveBeenCalledWith(expect.objectContaining({ id }), 'failed', 'Rate limited');
    expect(requestsUnderWay()).toBe(0);
  });

  it('tells a stopped turn and one that ran out of time apart', () => {
    const stopped = handOff('one');
    started();
    ended('cancelled');
    const slow = handOff('two');
    started();
    ended('timeout');
    expect(getRequest(stopped)?.status).toBe('cancelled');
    expect(getRequest(slow)?.status).toBe('timed_out');
  });

  it('a later turn failing leaves a request past its turn alone', () => {
    const id = handOff('have api-lead fix lint');
    started();
    ended();
    started();
    ended('error');
    expect(getRequest(id)?.status).toBe('under_way');
  });

  it('a steer joins the running turn; a queued request waits for the next one', () => {
    started();
    const steered = handOff('one', 'steer');
    const queued = handOff('two', 'queued');
    expect(getRequest(steered)?.turn).toBe('in_turn');
    expect(getRequest(queued)?.turn).toBe('awaiting');
    ended('error');
    expect(getRequest(steered)?.status).toBe('failed');
    expect(getRequest(queued)?.status).toBe('under_way');
    started();
    expect(getRequest(queued)?.turn).toBe('in_turn');
  });

  it('catches a turn that started and failed while the hand-off was still going', () => {
    const begun = beginRequest('tag 1.0', now);
    const mark = workTurnMark();
    started();
    ended('error');
    expect(getRequest(begun.kind === 'new' ? begun.request.id : '')?.status).toBe('under_way');
    if (begun.kind !== 'new') throw new Error(begun.kind);
    noteHandedOff(begun.request.id, 'woke', mark, now);
    expect(getRequest(begun.request.id)?.status).toBe('failed');
  });

  it('ties a hand-off that waited behind another to the turn it started, not the other\'s (two at once)', () => {
    // B's mark is taken before A's delivery; deliveries are one at a time, so A's turn runs and fails first.
    const a = beginRequest('one', now);
    const b = beginRequest('two', now);
    if (a.kind !== 'new' || b.kind !== 'new') throw new Error('not new');
    const markA = workTurnMark();
    const markB = workTurnMark();
    started();
    ended('error');
    noteHandedOff(a.request.id, 'prompt', markA, now);
    // B's prompt starts the next turn, which is still running when its hand-off returns.
    started();
    noteHandedOff(b.request.id, 'prompt', markB, now);
    expect(getRequest(a.request.id)?.status).toBe('failed');
    expect(getRequest(b.request.id)).toMatchObject({ status: 'under_way', turn: 'in_turn' });
    noteAgentReached('a1', now);
    expect(getRequest(b.request.id)?.agents).toEqual(['a1']);
  });

  it('a steer into a turn that is still running reads in it, even after an earlier turn ended', () => {
    const b = beginRequest('two', now);
    if (b.kind !== 'new') throw new Error(b.kind);
    const mark = workTurnMark();
    started();
    ended();
    started();
    noteHandedOff(b.request.id, 'steer', mark, now);
    expect(getRequest(b.request.id)?.turn).toBe('in_turn');
  });

  it('ends what was waiting on a session that stopped or failed', () => {
    started();
    const stopped = handOff('one', 'queued');
    noteWorkEvent(event('session_ended', { reason: 'stopped' }), now);
    expect(getRequest(stopped)?.status).toBe('cancelled');
    const crashed = handOff('two');
    started();
    noteWorkEvent(event('session_ended', { reason: 'process_exit', message: 'exited with code 1' }), now);
    expect(getRequest(crashed)?.status).toBe('failed');
    expect(ended$).toHaveBeenLastCalledWith(expect.objectContaining({ id: crashed }), 'failed', 'exited with code 1');
  });

  it('notes the agents reached in the turn reading a request', () => {
    const id = handOff('have api-lead fix lint');
    noteAgentReached('a1', now);
    expect(getRequest(id)?.agents).toEqual([]);
    started();
    noteAgentReached('a1', now);
    noteAgentReached('a1', now);
    ended();
    noteAgentReached('a2', now);
    expect(getRequest(id)?.agents).toEqual(['a1']);
  });
});

describe('outcomes', () => {
  it('an answer closes a request; a question leaves it waiting on the user', () => {
    const id = handOff('release');
    const previous = settleRequest(id, 'needs_user', now);
    expect(previous?.status).toBe('under_way');
    expect(getRequest(id)?.status).toBe('waiting_user');
    expect(requestsUnderWay()).toBe(0);
    settleRequest(id, 'answer', now);
    expect(getRequest(id)?.status).toBe('done');
    expect(settleRequest(id, 'answer', now)).toBeNull();
  });

  it('times out a request with no outcome, sooner when nothing is left to wait on', () => {
    const delegated = handOff('have api-lead fix lint');
    started();
    noteAgentReached('a1', now);
    const quiet = handOff('make an action', 'steer');
    ended();
    checkRequestTimeouts(now + QUIET_TIMEOUT_MS);
    expect(getRequest(quiet)?.status).toBe('timed_out');
    expect(getRequest(delegated)?.status).toBe('under_way');
    checkRequestTimeouts(now + REQUEST_TIMEOUT_MS);
    expect(getRequest(delegated)?.status).toBe('timed_out');
    expect(ended$.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([[quiet, 'timed_out'], [delegated, 'timed_out']]);
  });
});

describe('the timeout timer', () => {
  it('runs only while someone tells the chat, and stops when tracking stops', () => {
    vi.useFakeTimers({ now: T0 });
    try {
      now = T0;
      const id = handOff('make an action');
      started();
      ended();
      setRequestEndedHandler(null);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(QUIET_TIMEOUT_MS + 1);
      expect(getRequest(id)?.status).toBe('under_way');
      setRequestEndedHandler(ended$);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(getRequest(id)?.status).toBe('timed_out');
      expect(ended$).toHaveBeenCalledWith(expect.objectContaining({ id }), 'timed_out', undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('saved state', () => {
  it('survives a restart, with nothing left waiting on a turn from the last run', async () => {
    now = Date.now();
    const reading = handOff('one');
    started();
    noteAgentReached('a1', now);
    const stale = handOff('two', 'queued');
    await _whenRequestsSavedForTesting();
    // The last run's turns are gone, so what waited on one gets a fresh quiet clock. One that ran out
    // while the app was closed is too stale to tell the chat about.
    const saved = JSON.parse(fs.readFileSync(getRequestsPath(), 'utf8')) as { requests: DispatcherRequest[] };
    Object.assign(saved.requests[1], { turn: 'past', turnEndedAt: now - QUIET_TIMEOUT_MS - 1 });
    fs.writeFileSync(getRequestsPath(), JSON.stringify(saved));
    await _resetDispatcherRequestsForTesting();
    setRequestEndedHandler(ended$);
    expect(getRequest(reading)).toMatchObject({ status: 'under_way', turn: 'past', agents: ['a1'] });
    expect(getRequest(stale)?.status).toBe('timed_out');
    expect(ended$).not.toHaveBeenCalled();
  });

  it('writes through a temporary file, leaving none behind', async () => {
    now = Date.now();
    handOff('one');
    await _whenRequestsSavedForTesting();
    expect(fs.readdirSync(h.base).filter((f) => f.startsWith('dispatcher-requests'))).toEqual(['dispatcher-requests.json']);
  });

  it('starts empty from a file it can\'t read', () => {
    fs.writeFileSync(getRequestsPath(), '{not json');
    expect(getRequests()).toEqual([]);
  });
});

describe('endWaitingRequests: Start fresh (#3240)', () => {
  it('ends requests waiting for a turn or read by the cut-short turn, and leaves the rest', () => {
    const reading = handOff('reading');
    started();
    const queued = handOff('queued', 'queued');
    const answered = handOff('answered', 'queued');
    settleRequest(answered, 'answer', now);
    expect(getRequest(reading)?.turn).toBe('in_turn');
    expect(getRequest(queued)?.turn).toBe('awaiting');

    expect(endWaitingRequests('cancelled', now)).toBe(2);

    expect(getRequest(reading)?.status).toBe('cancelled');
    expect(getRequest(queued)?.status).toBe('cancelled');
    expect(getRequest(answered)?.status).toBe('done');
    // The chat is told each one stopped.
    expect(ended$.mock.calls.map((c) => [c[0].id, c[1]]).sort()).toEqual([[queued, 'cancelled'], [reading, 'cancelled']].sort());
  });

  it('a request handed off after the fresh start reads the new conversation\'s first turn', () => {
    handOff('before');
    started();
    endWaitingRequests('cancelled', now);
    const after = handOff('after');
    started();
    expect(getRequest(after)).toMatchObject({ status: 'under_way', turn: 'in_turn' });
  });
});
