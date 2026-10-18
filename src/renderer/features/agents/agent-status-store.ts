import { useMemo } from 'react';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStatuses, useChatStore } from '../../stores/chatStore';
import { chatDetailedStatus, withChatStatus } from './agent-status';

/**
 * An agent's effective detailed status: its chat session's state while a chat
 * runtime runs it, otherwise its hook status (#2197, #2208). Every status
 * surface reads this, so they agree with the chat header. Hook status alone
 * reads Done mid-turn for a chat agent after 30s without a tool event.
 */

/** Effective status for every local agent, keyed by id. */
export function useAgentStatuses(): Record<string, AgentDetailedStatus> {
  const agents = useAgentStore((s) => s.agents);
  const hook = useAgentStore((s) => s.agentDetailedStatus);
  const chat = useChatStatuses();
  return useMemo(() => withChatStatus(agents, hook, chat), [agents, hook, chat]);
}

/** Effective status for one local agent. */
export function useAgentStatus(agent: Pick<Agent, 'id' | 'status'>): AgentDetailedStatus | undefined {
  const hook = useAgentStore((s) => s.agentDetailedStatus[agent.id]);
  const state = useChatStore((s) => s.agents[agent.id]?.state ?? null);
  const turnStartedAt = useChatStore((s) => s.agents[agent.id]?.turnStartedAt ?? null);
  const status = agent.status;
  return useMemo(
    () => chatDetailedStatus({ status }, hook, { state, turnStartedAt }),
    [status, hook, state, turnStartedAt],
  );
}

/** Effective status for one local agent, read once (for the plugin API). */
export function getAgentStatus(agentId: string): AgentDetailedStatus | undefined {
  const { agents, agentDetailedStatus } = useAgentStore.getState();
  const hook = agentDetailedStatus[agentId];
  const agent = agents[agentId];
  const chat = useChatStore.getState().agents[agentId];
  if (!agent || !chat) return hook;
  return chatDetailedStatus(agent, hook, { state: chat.state, turnStartedAt: chat.turnStartedAt });
}

/**
 * Calls `listener` when any chat session's state or turn start changes: the
 * chat inputs of getAgentStatus. Streamed chunks don't fire it.
 */
export function onChatStatusChange(listener: () => void): () => void {
  let prev = useChatStore.getState().agents;
  return useChatStore.subscribe((s) => {
    const next = s.agents;
    if (next === prev) return;
    const before = prev;
    prev = next;
    const ids = new Set([...Object.keys(before), ...Object.keys(next)]);
    for (const id of ids) {
      if (before[id]?.state !== next[id]?.state || before[id]?.turnStartedAt !== next[id]?.turnStartedAt) {
        listener();
        return;
      }
    }
  });
}
