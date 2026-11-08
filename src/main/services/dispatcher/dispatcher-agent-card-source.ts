/**
 * Where an agent's Dispatcher card in Details (#3049) reads and saves the
 * agent's card. The cards themselves are kept by the agent-card service
 * (#3041), which registers itself here with setAgentCardSource; this module
 * is the seam between it and the IPC handlers, so Details doesn't depend on
 * how cards are asked for or stored.
 *
 * With no source registered, every agent reads as having no card and a save
 * is refused with a plain message.
 */

import type { AgentCardFields, AgentCardView } from '../../../shared/dispatcher-agent-card';

export interface AgentCardSource {
  /** The agent's card, or null when Clubhouse has never asked it for one. */
  status(agentId: string): Promise<AgentCardView | null>;
  /** The user's edit: it replaces what the agent wrote. Fields left out keep what the card said. */
  saveUserCard(agentId: string, fields: Partial<AgentCardFields>): Promise<AgentCardView>;
}

export const AGENT_CARDS_UNAVAILABLE = 'Agent descriptions aren\'t available yet.';

let source: AgentCardSource | null = null;
const listeners = new Set<(agentId: string) => void>();

/** Register the service that keeps the cards. Null takes it away (tests). */
export function setAgentCardSource(next: AgentCardSource | null): void {
  source = next;
}

/** Tell Details an agent's card changed: the agent answered, or the user saved an edit. */
export function notifyAgentCardChanged(agentId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(agentId);
    } catch {
      // telemetry-exempt: one listener's failure doesn't stop the others; Details re-reads on its next change
    }
  }
}

export function onAgentCardChanged(listener: (agentId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function readAgentCardView(agentId: string): Promise<AgentCardView | null> {
  return source ? source.status(agentId) : null;
}

export async function saveAgentCardEdit(agentId: string, fields: Partial<AgentCardFields>): Promise<AgentCardView> {
  if (!source) throw new Error(AGENT_CARDS_UNAVAILABLE);
  const view = await source.saveUserCard(agentId, fields);
  notifyAgentCardChanged(agentId);
  return view;
}
