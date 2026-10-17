/**
 * Runtime-aware agent view for surfaces outside the main agent pane: the
 * popout window, canvas cards and plugins (`api.widgets.AgentView`). It shows
 * ChatView for an agent running in chat and its terminal otherwise
 * (docs/structured-chat-research.md §7, "Popout, canvas and plugin views").
 * Switching runtimes stays in the main pane.
 */

import type { Agent } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { AgentTerminal } from '../AgentTerminal';
import { AgentRuntimePane, useAgentRuntimeInfo, useChatFlag } from './AgentRuntimePane';

export interface AgentViewProps {
  agentId: string;
  focused?: boolean;
  zoneThemeId?: string;
}

export function AgentView({ agentId, focused, zoneThemeId }: AgentViewProps) {
  const agent = useAgentStore((s) => s.agents[agentId]);
  const terminal = <AgentTerminal agentId={agentId} focused={focused} zoneThemeId={zoneThemeId} />;
  // Agents this window doesn't know (remote agents) only run in a terminal.
  if (!agent) return terminal;
  return <AgentRuntimePane key={agentId} agent={agent} terminal={terminal} canSwitch={false} />;
}

/** True when the agent is running in chat, for hosts that lay out around the view. */
export function useAgentInChat(agent: Agent): boolean {
  return useAgentRuntimeInfo(agent, useChatFlag()).chat;
}
