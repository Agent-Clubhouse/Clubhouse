import type { AgentInfo, PluginAgentDetailedStatus } from '../../../../shared/plugin-types';
import { agentDot, type AgentDot } from '../../../features/agents/agent-status';
import type { CanvasViewAttention } from './canvas-types';

// Shared by the card title bar (CanvasView) and the agent picker
// (AgentCanvasView), which CanvasView renders; kept apart so the two
// components don't import each other.

/**
 * The status dot on an agent card: attention wins, then the agent's own
 * state, from the app's one status vocabulary (features/agents/agent-status).
 */
export function cardDot(
  agent: Pick<AgentInfo, 'status'>,
  detailed: PluginAgentDetailedStatus | null | undefined,
  attention: CanvasViewAttention | null | undefined,
): AgentDot {
  if (attention) return attention.level === 'error' ? 'error' : 'needs';
  return agentDot(agent, detailed ?? undefined);
}
