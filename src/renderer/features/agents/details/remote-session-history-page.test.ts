import { expect, it } from 'vitest';
import { isRemoteSessionHistoryBinding, type RemoteSessionHistoryBinding } from '../../../../shared/remote-session-history';
import { remoteSessionHistoryPage } from './remote-session-history-page';
const binding: RemoteSessionHistoryBinding = { version: 1, projectId: 'p1', agentId: 'a1', sessionId: 's1', providerId: 'claude-code', driver: 'claude_agent_sdk', nativeSessionId: 'n1', displayRunId: 'run-a', startSeq: 10, subagents: 'full' };
const event = (seq: number) => ({ v: 2, agentId: 'a1', sessionId: 's1', seq, ts: seq, type: 'subagent', data: { subagentId: 'child', name: 'Child', status: 'completed' } });
const page = (extra = {}) => ({ agentId: 'a1', sessionId: 's1', currentSessionId: 's1', readOnly: false, state: 'idle', displayRunId: 'run-a', historyBinding: binding, truncated: true, nextBeforeSeq: 50, events: [event(50)], ...extra });
it('accepts a bound descending cursor and stops at the selected runtime floor without importing prior runs', () => {
  expect(remoteSessionHistoryPage(page(), binding, 100)?.nextBeforeSeq).toBe(50);
  expect(remoteSessionHistoryPage(page({ events: [event(1), event(10)], nextBeforeSeq: 1 }), binding, 50)).toMatchObject({ events: [event(10)], nextBeforeSeq: null, atRunStart: true });
  expect(remoteSessionHistoryPage(page({ events: [], truncated: false, nextBeforeSeq: null }), binding, 50)).toMatchObject({ events: [], atRunStart: true });
});
it.each(['projectId', 'agentId', 'sessionId', 'providerId', 'driver', 'nativeSessionId', 'displayRunId', 'startSeq', 'subagents'] as const)('rejects mismatched %s on every page', (field) => {
  expect(remoteSessionHistoryPage(page({ historyBinding: { ...binding, [field]: field === 'startSeq' ? 11 : 'other' } }), binding, 100)).toBeNull();
});
it('rejects missing old-host bindings, malformed cursors, cross-session events and same-native reopened generation', () => {
  for (const extra of [{ historyBinding: undefined }, { nextBeforeSeq: undefined }, { nextBeforeSeq: 100 }, { nextBeforeSeq: -1 }, { nextBeforeSeq: 1.5 }, { truncated: false },
    { events: [event(60), event(50)] }, { events: [{ ...event(50), sessionId: 'other' }] }, { events: [{ ...event(50), agentId: 'other' }] },
    { historyBinding: { ...binding, displayRunId: 'run-b' } }, { readOnly: true }, { state: 'sleeping' }, { currentSessionId: 'replacement' }]) expect(remoteSessionHistoryPage(page(extra), binding, 100)).toBeNull();
  expect(isRemoteSessionHistoryBinding({ ...binding, rawPath: '/private' })).toBe(false);
  expect(isRemoteSessionHistoryBinding({ ...binding, startSeq: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
});
