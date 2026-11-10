import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// #3240 with #3260: the same failing turns that make the work start fresh end
// the requests they were reading as failed, so none is left waiting on a
// conversation that is gone.

const h = vi.hoisted(() => ({ base: '' }));
vi.mock('../base-dir', () => ({ getBaseDirPath: () => h.base }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-runtime', () => ({ getAgentRuntime: vi.fn(() => undefined) }));
vi.mock('./dispatcher-clear-chat', () => ({ startDispatcherFresh: vi.fn(async () => ({ work: 'now' })) }));
vi.mock('./dispatcher-service', () => ({ getDispatcherAgentId: () => 'coordinator' }));

import type { ChatEvent, ChatEventDataMap } from '../../../shared/chat';
import { REPEATED_TURN_FAILURES } from '../agent-runtime/stale-session';
import {
  _resetDispatcherRequestsForTesting,
  beginRequest,
  getRequest,
  getRequestsPath,
  noteHandedOff,
  noteWorkEvent,
  setRequestEndedHandler,
  workTurnMark,
} from './dispatcher-requests';
import { _resetDispatcherWorkHealthForTesting, _whenRecoveredForTesting, noteWorkChatEvent } from './dispatcher-work-health';

h.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-work-recovery-test-'));
afterAll(() => fs.rmSync(h.base, { recursive: true, force: true }));

const now = 1_700_000_000_000;
const startFresh = vi.fn(async () => undefined);
const ended = vi.fn();

function event<T extends keyof ChatEventDataMap>(type: T, data: ChatEventDataMap[T]): ChatEvent {
  return { v: 1, agentId: 'coordinator', sessionId: 's', seq: 1, ts: now, type, data } as unknown as ChatEvent;
}

/** Both listeners see every work event, as they do in the app. */
function emit(e: ChatEvent): void {
  noteWorkEvent(e, now);
  noteWorkChatEvent(e, { nativeSessionId: () => 'bad-native', startFresh });
}

function handOff(text: string): string {
  const begun = beginRequest(text, now);
  if (begun.kind !== 'new') throw new Error(begun.kind);
  noteHandedOff(begun.request.id, 'prompt', workTurnMark(), now);
  return begun.request.id;
}

function failedTurn(code: ChatEventDataMap['error']['code']): void {
  emit(event('turn_started', { trigger: 'prompt' }));
  emit(event('error', { code, message: 'Request failed', fatal: false }));
  emit(event('turn_ended', { stopReason: 'error' }));
}

beforeEach(async () => {
  await _resetDispatcherRequestsForTesting();
  fs.rmSync(getRequestsPath(), { force: true });
  _resetDispatcherWorkHealthForTesting();
  vi.clearAllMocks();
  setRequestEndedHandler(ended);
});

describe('Dispatcher work recovery with the request ledger (#3240, #3260)', () => {
  it('ends each failed turn\'s request as failed, and starts the work fresh on the last failure', async () => {
    const ids: string[] = [];
    for (let i = 0; i < REPEATED_TURN_FAILURES; i++) {
      ids.push(handOff(`request ${i}`));
      failedTurn('protocol_error');
    }
    expect(ids.map((id) => getRequest(id)?.status)).toEqual(ids.map(() => 'failed'));
    expect(ended).toHaveBeenCalledTimes(REPEATED_TURN_FAILURES);
    expect(startFresh).toHaveBeenCalledTimes(1);
    await _whenRecoveredForTesting();
  });

  it('a provider outage fails its requests but never starts the work fresh', () => {
    const ids: string[] = [];
    for (let i = 0; i < REPEATED_TURN_FAILURES + 1; i++) {
      ids.push(handOff(`request ${i}`));
      failedTurn('service_unavailable');
    }
    expect(ids.every((id) => getRequest(id)?.status === 'failed')).toBe(true);
    expect(startFresh).not.toHaveBeenCalled();
  });
});
