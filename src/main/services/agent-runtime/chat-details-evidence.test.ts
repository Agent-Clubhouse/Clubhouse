import { describe, expect, it } from 'vitest';
import type { ChatEvent, ChatEventDraft } from '../../../shared/chat';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../shared/chat';
import { CHAT_DETAILS_LIST_LIMIT, isChatDetailsEvidence } from '../../../shared/chat/details-evidence';
import { ChatDetailsRecorder } from './chat-details-evidence';

function recorder(runId = 'run-a') {
  const recorder = new ChatDetailsRecorder(runId); let seq = 0;
  const emit = (draft: ChatEventDraft, extra = {}) => recorder.observe({ v: 2, agentId: 'a', sessionId: 'app-s', seq: ++seq, ts: seq * 1000, ...draft, ...extra } as ChatEvent);
  emit({ type: 'session_started', data: { provider: 'claude-code', driver: 'claude_agent_sdk', nativeSessionId: 'native-s', resumed: true, cwd: '/PRIVATE_FOLDER', capabilities: { ...MINIMAL_CHAT_CAPABILITIES, subagents: 'full', usage: 'cost', limits: true }, level: 'ask' } });
  return { emit, read: () => recorder.read(999_999) };
}
describe('passive current-runtime display recorder', () => {
  it('keeps initial facts beyond 2000 unrelated events without retaining private content', () => {
    const { emit, read } = recorder();
    emit({ type: 'session_info', data: { nativeSessionId: 'native-s', cliVersion: '1.2.3', model: 'initial-model', mcpServers: [{ name: 'tickets', status: 'connected' }], providerSkills: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'native-s', names: ['review'] }, contextLimits: { effectiveTokens: 200_000, compactAtTokens: 160_000, reservedTokens: null } } });
    emit({ type: 'model_changed', data: { modelId: 'initial-model', effort: 'high', effortIsDefault: true } });
    emit({ type: 'subagent', data: { subagentId: 'sub-1', name: 'Reviewer', description: 'Review tests', status: 'completed', toolCount: 3, usage: { total: 42 } } });
    emit({ type: 'usage', data: { scope: 'session', costUsd: 0, tokens: { input: 20, output: 10 }, context: { used: 30, size: 200_000 }, limits: [{ window: '5h', utilization: 0.2 }] } });
    for (let i = 0; i < 2100; i++) emit({ type: 'agent_message', data: { messageId: `m${i}`, text: `PRIVATE_PROMPT_${i} apiKey=PRIVATE_CREDENTIAL` } });
    const evidence = read()!;
    expect(isChatDetailsEvidence(evidence)).toBe(true);
    expect(evidence).toMatchObject({ runId: 'run-a', agentId: 'a', sessionId: 'app-s', nativeSessionId: 'native-s', completeFromStart: true,
      values: { cliVersion: '1.2.3', model: 'initial-model', effort: { value: 'high', isDefault: true }, mcpServers: [{ name: 'tickets', status: 'connected' }], skills: { names: ['review'], reportedAt: 2000 }, subagents: [{ subagentId: 'sub-1', toolCount: 3 }], sessionUsage: { costUsd: 0 }, context: { used: 30 } }, observedAt: { cliVersion: 2000, model: 3000, subagents: 4000, sessionUsage: 5000 } });
    expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE_|events|cwd|rawInput|prompt/);
    // Callers cannot mutate the runtime's retained evidence.
    evidence.values.mcpServers![0].name = 'changed';
    expect(read()!.values.mcpServers![0].name).toBe('tickets');
  });
  it('drops earlier native-session facts instead of promoting them after replacement', () => {
    const { emit, read } = recorder();
    emit({ type: 'session_info', data: { cliVersion: 'OLD_VERSION', model: 'OLD_MODEL', mcpServers: [{ name: 'OLD_MCP', status: 'connected' }] } });
    emit({ type: 'session_info', data: { nativeSessionId: 'native-new', model: null } });
    expect(read()).toMatchObject({ nativeSessionId: 'native-new', completeFromStart: false, values: { model: null } });
    expect(JSON.stringify(read())).not.toContain('OLD_');
    expect(read()!.observedAt).toEqual({ model: 3000 });
    emit({ type: 'session_info', data: { nativeSessionId: 'native-new', providerSkills: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'native-s', names: ['stale-skill'] } } });
    expect(read()!.values.skills).toBeUndefined();
  });
  it('preserves missing versus explicitly empty and bounded omitted reports', () => {
    const { emit, read } = recorder();
    expect(read()!.values.mcpServers).toBeUndefined();
    expect(read()!.values.skills).toBeUndefined();
    expect(read()!.values.subagents).toBeUndefined();
    emit({ type: 'session_info', data: { nativeSessionId: 'native-s', mcpServers: [], providerSkills: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'native-s', names: [] } } });
    expect(read()!.values).toMatchObject({ mcpServers: [], skills: { names: [] } });
    emit({ type: 'session_info', data: { mcpServers: Array.from({ length: 70 }, (_, i) => ({ name: `mcp-${i}`, status: 'connected' })) } });
    for (let i = 0; i < 70; i++) emit({ type: 'subagent', data: { subagentId: `sub-${i}`, name: `Worker ${i}`, status: 'running' } });
    const result = read()!;
    expect(result.values.mcpServers).toHaveLength(CHAT_DETAILS_LIST_LIMIT);
    expect(result.values.subagents).toHaveLength(CHAT_DETAILS_LIST_LIMIT);
    expect(result.omitted).toMatchObject({ mcpServers: 6, subagents: 6 });
    expect(isChatDetailsEvidence(result)).toBe(true);
  });
  it('keeps partial inventory field times and omissions instead of making earlier tool names newly reported', () => {
    const { emit, read } = recorder();
    emit({ type: 'session_info', data: { nativeSessionId: 'native-s', providerInventory: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'native-s', skills: ['review'], mcpTools: Array.from({ length: 70 }, (_, i) => `mcp__tickets__tool${i}`) } } });
    emit({ type: 'session_info', data: { providerInventory: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'native-s', skills: [] } } });
    expect(read()!.values.inventory).toMatchObject({ skills: [], skillsReportedAt: 3000, mcpToolsReportedAt: 2000, reportedAt: 3000 });
    expect(read()!.values.inventory!.mcpTools).toHaveLength(64);
    expect(read()!.omitted.inventory).toBe(6);
  });
  it('keeps initial unbound-native facts on first identity learning but clears them on actual native replacement', () => {
    const r = new ChatDetailsRecorder('before-native');
    r.observe({ v: 2, agentId: 'a', sessionId: 's', seq: 1, ts: 1, type: 'session_started', data: { provider: 'claude-code', driver: 'claude_agent_sdk', resumed: false, cwd: '/host', level: 'ask', capabilities: MINIMAL_CHAT_CAPABILITIES } });
    r.replaceNativeSession('n1', 'learned-native');
    expect(r.read(2)).toMatchObject({ runId: 'learned-native', nativeSessionId: 'n1', completeFromStart: true, values: { level: 'ask' } });
    r.replaceNativeSession('n2', 'replacement-native');
    r.observe({ v: 2, agentId: 'a', sessionId: 's', seq: 2, ts: 2, type: 'session_info', data: { nativeSessionId: 'n2', cliVersion: 'NEW_VERSION' } });
    expect(r.read(3)).toMatchObject({ runId: 'replacement-native', nativeSessionId: 'n2', startSeq: 2, completeFromStart: false, values: { cliVersion: 'NEW_VERSION' } });
    expect(r.read(3)!.values.level).toBeUndefined();
  });
  it('aggregates turn tokens without adding child usage to the main total or double-counting a turn report', () => {
    const { emit, read } = recorder();
    emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    emit({ type: 'usage', data: { scope: 'turn', tokens: { input: 10, cachedInput: 5, output: 2 } } });
    emit({ type: 'usage', data: { scope: 'session', subagentId: 'child', tokens: { total: 9999 }, costUsd: 999 } });
    emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    emit({ type: 'turn_ended', data: { stopReason: 'end_turn', usage: { total: 3 }, costUsd: 0 } });
    expect(read()!.values).toMatchObject({ turnTotal: { input: 10, cachedInput: 5, output: 2, total: 15 }, turnUsage: { costUsd: 0, tokens: { total: 3 } } });
    expect(read()!.values.sessionUsage).toBeUndefined();
  });
  it('rejects malformed fields independently and ignores another app/agent session', () => {
    const { emit, read } = recorder();
    emit({ type: 'session_info', data: { cliVersion: 'safe-version', contextLimits: { effectiveTokens: -1, compactAtTokens: null, reservedTokens: null } } });
    emit({ type: 'model_changed', data: { modelId: 'wrong-agent' } }, { agentId: 'other' });
    emit({ type: 'model_changed', data: { modelId: 'wrong-session' } }, { sessionId: 'other' });
    expect(read()!.values.cliVersion).toBe('safe-version');
    expect(read()!.values.contextLimits).toBeUndefined();
    expect(read()!.omitted.contextLimits).toBe(1);
    expect(read()!.values.model).toBeUndefined();
  });
});
