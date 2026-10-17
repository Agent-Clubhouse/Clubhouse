import { describe, it, expect } from 'vitest';
import { cardDot } from './canvas-card-status';
import { DOT_LABEL } from '../../../features/agents/agent-status';
import type { AgentInfo, PluginAgentDetailedStatus } from '../../../../shared/plugin-types';
import type { CanvasViewAttention } from './canvas-types';

const detailed = (state: PluginAgentDetailedStatus['state'], message = ''): PluginAgentDetailedStatus => ({ state, message });
const attention = (level: CanvasViewAttention['level']): CanvasViewAttention => ({ level, message: '', viewId: 'v1' });

describe('cardDot', () => {
  it.each<[string, AgentInfo['status'], PluginAgentDetailedStatus | null, CanvasViewAttention | null, string]>([
    // Attention wins over the agent's own state.
    ['error attention on a working agent', 'running', detailed('working'), attention('error'), 'Error'],
    ['warning attention on a working agent', 'running', detailed('working'), attention('warning'), 'Needs you'],
    ['warning attention on a sleeping agent', 'sleeping', null, attention('warning'), 'Needs you'],
    // Otherwise the app's one status vocabulary.
    ['an idle agent between turns', 'running', detailed('idle'), null, 'Done'],
    ['a running agent with no hook status', 'running', null, null, 'Done'],
    ['mid-turn Thinking between tool calls', 'running', detailed('idle', 'Thinking'), null, 'Working'],
    ['a working agent', 'running', detailed('working'), null, 'Working'],
    ['a permission prompt', 'running', detailed('needs_permission'), null, 'Needs you'],
    ['a tool error', 'running', detailed('tool_error'), null, 'Error'],
    ['an errored agent', 'error', null, null, 'Error'],
    ['a sleeping agent', 'sleeping', null, null, 'Sleeping'],
    ['a waking agent', 'waking', null, null, 'Starting'],
  ])('%s', (_name, status, det, att, word) => {
    expect(DOT_LABEL[cardDot({ status }, det, att)]).toBe(word);
  });
});
