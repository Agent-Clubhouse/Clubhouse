import { describe, it, expect } from 'vitest';
import { parseSessionUpdate } from './acp-updates';
import { ACP_SESSION_UPDATE_KINDS } from './acp-schema';

const text = { type: 'text', text: 'hi' };

/** One minimal valid payload per v1 variant. */
const VALID: Record<string, Record<string, unknown>> = {
  user_message_chunk: { content: text },
  agent_message_chunk: { content: text, messageId: 'm1' },
  agent_thought_chunk: { content: text },
  tool_call: { toolCallId: 't1', title: 'Read file', kind: 'read', status: 'pending' },
  tool_call_update: { toolCallId: 't1', status: 'completed' },
  plan: { entries: [{ content: 'step', priority: 'high', status: 'pending' }] },
  available_commands_update: { availableCommands: [{ name: 'compact', description: 'Compact', input: null }] },
  current_mode_update: { currentModeId: 'plan' },
  config_option_update: { configOptions: [] },
  session_info_update: { title: 'Title' },
  usage_update: { used: 10, size: 100, cost: { amount: 0.01, currency: 'USD' } },
  notice: { severity: 'warning', title: 'Rate limited' },
  compaction_update: { compactionId: 'c1', status: 'in_progress' },
  compaction_summary_chunk: { compactionId: 'c1', content: text },
};

describe('parseSessionUpdate', () => {
  it.each([...ACP_SESSION_UPDATE_KINDS])('accepts a valid %s', (kind) => {
    const result = parseSessionUpdate({ sessionUpdate: kind, ...VALID[kind] });
    expect(result.result).toBe('valid');
  });

  it('reports an unknown variant without throwing', () => {
    const raw = { sessionUpdate: 'subagent_started', id: 'x' };
    expect(parseSessionUpdate(raw)).toEqual({ result: 'skipped', kind: 'subagent_started', reason: 'unknown sessionUpdate variant', raw });
  });

  it('reports a known variant missing required fields', () => {
    const result = parseSessionUpdate({ sessionUpdate: 'usage_update', used: 3 });
    expect(result).toMatchObject({ result: 'skipped', kind: 'usage_update', reason: expect.stringContaining('size') });
  });

  it('reports a payload with no discriminator', () => {
    expect(parseSessionUpdate({ content: text })).toMatchObject({ result: 'skipped', kind: '(missing)' });
    expect(parseSessionUpdate(null)).toMatchObject({ result: 'skipped' });
  });

  it('degrades unknown tool kinds to other and drops unknown statuses', () => {
    const result = parseSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', kind: 'teleport', status: 'queued' });
    expect(result.result).toBe('valid');
    if (result.result === 'valid' && result.update.sessionUpdate === 'tool_call') {
      expect(result.update.kind).toBe('other');
      expect(result.update.status).toBeUndefined();
    }
  });
});
