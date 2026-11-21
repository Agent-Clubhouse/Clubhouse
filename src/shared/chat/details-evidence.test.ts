import { describe, expect, it } from 'vitest';
import { isChatDetailsEvidence, type ChatDetailsEvidence } from './details-evidence';
import { isRemoteAgentDetails, REMOTE_DETAILS_CARD_IDS } from '../remote-agent-details';
const evidence = (): ChatDetailsEvidence => ({ version: 1, runId: 'display-runtime', agentId: 'a', sessionId: 's', nativeSessionId: 'n', providerId: 'claude-code', driver: 'claude_agent_sdk', startedAt: 100, startSeq: 1, readAt: 200, lastSeq: 10, completeFromStart: true, values: { model: null, mcpServers: [] }, observedAt: { model: 100, mcpServers: 200 }, omitted: {} });
describe('current provider display contract', () => {
  it('accepts explicit empty reports and unknown absent fields with observation times', () => {
    expect(isChatDetailsEvidence(evidence())).toBe(true);
    expect(isChatDetailsEvidence({ ...evidence(), values: {}, observedAt: {} })).toBe(true);
    expect(isChatDetailsEvidence({ ...evidence(), values: { model: 'm' }, observedAt: {} })).toBe(false);
  });
  it('rejects raw/unbounded/config-shaped payloads and malformed nested reports without throwing', () => {
    for (const patch of [{ runId: '' }, { startSeq: 0 }, { values: { model: 'x'.repeat(513) } }, { values: { mcpServers: {} } }, { values: { inventory: { rawConfig: {} } } }, { values: { subagents: [{ rawInput: 'PRIVATE' }] } }, { values: { credentials: 'PRIVATE' } }, { observedAt: { model: Infinity } }, { omitted: { model: -1 } }, { values: { model: 'm' }, rawEvents: [] }]) expect(isChatDetailsEvidence({ ...evidence(), ...patch })).toBe(false);
  });
  it('requires the exact selected agent/provider/app/native identity and a live Details result', () => {
    const value = { version: 1, readOnly: true, agentId: 'a', readAt: 200, providerId: 'claude-code', running: true, status: 'running', spawnedAt: 100, sessionId: 's', nativeSessionId: 'n', settings: null, providerEvidence: evidence(), cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: '', rows: [], notes: [], omitted: 0, observedAt: 200 })) };
    expect(isRemoteAgentDetails(value, 'a')).toBe(true);
    for (const patch of [{ agentId: 'other' }, { providerId: 'other' }, { sessionId: 'other' }, { nativeSessionId: 'other' }]) expect(isRemoteAgentDetails({ ...value, providerEvidence: { ...evidence(), ...patch } }, 'a')).toBe(false);
    expect(isRemoteAgentDetails({ ...value, running: false }, 'a')).toBe(false);
    expect(isRemoteAgentDetails({ ...value, providerEvidenceState: 'unavailable' }, 'a')).toBe(false);
    expect(isRemoteAgentDetails({ ...value, providerEvidence: undefined, providerEvidenceState: 'current' }, 'a')).toBe(false);
  });
});
