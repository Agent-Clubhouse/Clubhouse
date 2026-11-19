/** Host lifecycle evidence for Details. In-memory observations only; never launch authority. */
import type { AgentStatus, DurableAgentConfig } from '../../shared/types';
import { safeMcpErrorLine } from './mcp-error-text';

interface Observation { status: AgentStatus; at: number; spawnedAt?: number; error?: string }
const observations = new Map<string, Observation>();
const listeners = new Set<(id: string, status: AgentStatus) => void>();
function note(id: string, value: Observation) {
  observations.set(id, value);
  // Bound retained observations; registered agent/config resolution still controls reads.
  if (observations.size > 10_000) observations.delete(observations.keys().next().value!);
  for (const listener of listeners) listener(id, value.status);
}
export function noteAgentStarting(id: string, quick = false): void { note(id, { status: quick ? 'spawning' : 'waking', at: Date.now() }); }
export function noteAgentAwake(id: string): void { note(id, { status: 'running', at: Date.now(), spawnedAt: Date.now() }); }
export function noteAgentWakeFailed(id: string, error: unknown): void { note(id, { status: 'error', at: Date.now(), error: safeMcpErrorLine(error instanceof Error ? error.message : String(error)) }); }
export function agentDisplayState(agent: Pick<DurableAgentConfig, 'id' | 'creation'>, running: boolean): Observation {
  const observed = observations.get(agent.id);
  if (agent.creation?.state === 'creating') return { status: 'creating', at: observed?.at ?? 0 };
  if (agent.creation?.state === 'failed') return { status: 'error', at: observed?.at ?? 0, error: safeMcpErrorLine(agent.creation.reason) };
  if (running) return { ...observed, status: 'running', at: observed?.at ?? 0 };
  if (observed?.status === 'waking' || observed?.status === 'spawning' || observed?.status === 'error') return observed;
  return { status: 'sleeping', at: observed?.at ?? 0 };
}
export function onAgentDisplayState(listener: (id: string, status: AgentStatus) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function _resetAgentDisplayStateForTesting(): void { observations.clear(); }
