import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '../../../shared/chat';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-runtime', () => ({ getAgentRuntime: vi.fn(() => undefined) }));
vi.mock('./dispatcher-clear-chat', () => ({ startDispatcherFresh: vi.fn(async () => ({ work: 'now' })) }));
vi.mock('./dispatcher-service', () => ({ getDispatcherAgentId: () => 'work' }));

import { REPEATED_TURN_FAILURES } from '../agent-runtime/stale-session';
import { startDispatcherFresh } from './dispatcher-clear-chat';
import { _resetDispatcherWorkHealthForTesting, _whenRecoveredForTesting, noteWorkChatEvent, type WorkHealthDeps } from './dispatcher-work-health';

let seq = 0;
function ev(type: ChatEvent['type'], data: unknown, agentId = 'work'): ChatEvent {
  return { agentId, sessionId: 's', seq: ++seq, ts: seq, type, data } as ChatEvent;
}

let native = 'bad-native';
const startFresh = vi.fn(async () => undefined);
const deps: WorkHealthDeps = { nativeSessionId: () => native, startFresh };

/** One turn: started, an optional error, then ended. */
function turn(stopReason: string, error?: { code: string; willRetry?: boolean }, agentId = 'work'): void {
  noteWorkChatEvent(ev('turn_started', { trigger: 'immediate' }, agentId), deps);
  if (error) noteWorkChatEvent(ev('error', { code: error.code, message: 'failed', fatal: false, willRetry: error.willRetry }, agentId), deps);
  noteWorkChatEvent(ev('turn_ended', { stopReason }, agentId), deps);
}

beforeEach(() => {
  _resetDispatcherWorkHealthForTesting();
  vi.clearAllMocks();
  native = 'bad-native';
});

describe('Dispatcher work health (#3240)', () => {
  it('starts the work fresh once its conversation fails every turn', async () => {
    for (let i = 0; i < REPEATED_TURN_FAILURES - 1; i++) turn('error', { code: 'protocol_error' });
    expect(startFresh).not.toHaveBeenCalled();
    turn('error', { code: 'protocol_error' });
    expect(startFresh).toHaveBeenCalledTimes(1);
    await _whenRecoveredForTesting();
  });

  it('uses the real Start fresh, for the work only, saying it was repeated failures', async () => {
    for (let i = 0; i < REPEATED_TURN_FAILURES; i++) {
      noteWorkChatEvent(ev('turn_ended', { stopReason: 'error' }), { nativeSessionId: () => native });
    }
    await _whenRecoveredForTesting();
    expect(startDispatcherFresh).toHaveBeenCalledWith('work', {}, 'repeated_failures');
  });

  it('a turn that ends well resets the count', () => {
    turn('error', { code: 'protocol_error' });
    turn('error', { code: 'protocol_error' });
    turn('end_turn');
    turn('error', { code: 'protocol_error' });
    turn('error', { code: 'protocol_error' });
    expect(startFresh).not.toHaveBeenCalled();
  });

  it('never counts errors a fresh session would hit too, a provider outage or a missing model included', () => {
    for (let i = 0; i < REPEATED_TURN_FAILURES + 1; i++) turn('error', { code: 'service_unavailable' });
    for (let i = 0; i < REPEATED_TURN_FAILURES + 1; i++) turn('error', { code: 'model_not_found' });
    for (let i = 0; i < REPEATED_TURN_FAILURES + 2; i++) {
      turn('error', { code: ['auth_required', 'account_issue', 'rate_limited', 'rpc_timeout', 'service_unavailable', 'model_not_found'][i % 6] });
      turn('error', { code: 'protocol_error', willRetry: true });
    }
    expect(startFresh).not.toHaveBeenCalled();
  });

  it('counts per native session: a new one starts from zero', () => {
    turn('error', { code: 'protocol_error' });
    turn('error', { code: 'protocol_error' });
    native = 'fresh-native';
    turn('error', { code: 'protocol_error' });
    expect(startFresh).not.toHaveBeenCalled();
  });

  it('ignores every other agent, the visible chat included', () => {
    for (let i = 0; i < REPEATED_TURN_FAILURES + 1; i++) turn('error', { code: 'protocol_error' }, 'chat');
    expect(startFresh).not.toHaveBeenCalled();
  });

  it('starts fresh once while a fresh start is under way', async () => {
    let finish!: () => void;
    startFresh.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    for (let i = 0; i < REPEATED_TURN_FAILURES * 2; i++) turn('error', { code: 'protocol_error' });
    expect(startFresh).toHaveBeenCalledTimes(1);
    finish();
    await _whenRecoveredForTesting();
  });
});
