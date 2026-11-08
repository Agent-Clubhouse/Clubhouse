/**
 * The renderer's way to an agent's card (#3049): what its Dispatcher card in
 * Details reads and saves. The card lives in the Dispatcher's memory and is
 * kept by main (#3041); this file is the one place the renderer asks for it,
 * so the card UI doesn't know about IPC.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentCardFields, AgentCardView } from '../../../shared/dispatcher-agent-card';

export function readAgentCard(agentId: string): Promise<AgentCardView | null> {
  return window.clubhouse.dispatcher.getAgentCard(agentId);
}

export function saveAgentCard(agentId: string, fields: Partial<AgentCardFields>): Promise<AgentCardView> {
  return window.clubhouse.dispatcher.saveAgentCard(agentId, fields);
}

export function onAgentCardChanged(callback: (agentId: string) => void): () => void {
  return window.clubhouse.dispatcher.onAgentCardChanged?.(callback) ?? (() => {});
}

export interface AgentCardRead {
  /** Null before the first read, after a failed one, or when it was never asked for a card. */
  view: AgentCardView | null;
  /** The first read for this agent hasn't come back. */
  loading: boolean;
  /** Put a newer view in place, such as the one a save hands back. */
  set: (view: AgentCardView) => void;
  reload: () => void;
}

/**
 * The agent's card, re-read when main says it changed and when `refreshKey`
 * changes (its Connect to Dispatcher switch, say). Reads nothing while
 * `enabled` is false.
 */
export function useAgentCard(agentId: string, enabled: boolean, refreshKey: unknown = null): AgentCardRead {
  const [read, setRead] = useState<{ agentId: string; view: AgentCardView | null } | null>(null);
  const [nonce, setNonce] = useState(0);
  // Replies can land out of order: only the latest request's answer is used.
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    return onAgentCardChanged((changed) => { if (changed === agentId) setNonce((n) => n + 1); });
  }, [agentId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const mine = ++seq.current;
    Promise.resolve().then(() => readAgentCard(agentId)).then(
      (view) => { if (mine === seq.current) setRead({ agentId, view: view ?? null }); },
      // telemetry-exempt: the card says there's no description yet and keeps Edit.
      () => { if (mine === seq.current) setRead({ agentId, view: null }); },
    );
  }, [agentId, enabled, nonce, refreshKey]);

  const set = useCallback((view: AgentCardView) => {
    seq.current++;
    setRead({ agentId, view });
  }, [agentId]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const mine = read?.agentId === agentId ? read : null;
  return { view: mine?.view ?? null, loading: enabled && !mine, set, reload };
}
