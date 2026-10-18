import { useMemo } from 'react';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { liveChatAgent, useChatStatuses, useChatStore } from '../../stores/chatStore';
import { chatDetailedStatus, withChatStatus } from './agent-status';

/**
 * An agent's effective detailed status: its chat session's state while a chat
 * runtime runs it (chatStore `live`), otherwise its hook status (#2197, #2208).
 * Chat state left from an earlier session never overrides a terminal agent. Every status
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
  const state = useChatStore((s) => liveChatAgent(s, agent.id)?.state ?? null);
  const turnStartedAt = useChatStore((s) => liveChatAgent(s, agent.id)?.turnStartedAt ?? null);
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
  const chat = liveChatAgent(useChatStore.getState(), agentId);
  if (!agent || !chat) return hook;
  return chatDetailedStatus(agent, hook, { state: chat.state, turnStartedAt: chat.turnStartedAt });
}

/**
 * Calls `listener` when a live chat session's state or turn start changes, or
 * an agent starts or stops running in chat: the chat inputs of
 * getAgentStatus. Streamed chunks don't fire it.
 */
export function onChatStatusChange(listener: () => void): () => void {
  let prev = useChatStore.getState();
  return useChatStore.subscribe((next) => {
    if (next.agents === prev.agents && next.live === prev.live) return;
    const before = prev;
    prev = next;
    const ids = new Set([...Object.keys(before.agents), ...Object.keys(next.agents)]);
    for (const id of ids) {
      const a = liveChatAgent(before, id);
      const b = liveChatAgent(next, id);
      if (a?.state !== b?.state || a?.turnStartedAt !== b?.turnStartedAt) {
        listener();
        return;
      }
    }
  });
}
