/**
 * What Settings › Dispatcher (#3046, part of #3034) reads from main besides
 * DispatcherState: the agents it can reach, and what Forget everything did.
 * Its usage is #3040's split (shared/dispatcher-usage).
 */

import type { DispatcherUsageTotals } from './dispatcher-usage';

/** "1.2M", "48K", "950". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(Math.max(0, Math.round(n)));
}

/** One line for a side of the usage split: "3 turns, 1.2M tokens in and 48K out", or "None yet". */
export function describeUsage(totals: Pick<DispatcherUsageTotals, 'turns' | 'input' | 'output'>): string {
  if (totals.turns === 0) return 'None yet';
  const turns = totals.turns === 1 ? '1 turn' : `${totals.turns} turns`;
  return `${turns}, ${formatTokenCount(totals.input)} tokens in and ${formatTokenCount(totals.output)} out`;
}

/** One agent in Connected agents: a local durable agent that isn't a helper. */
export interface ConnectableAgent {
  projectId: string;
  projectPath: string;
  projectName: string;
  agentId: string;
  name: string;
  color?: string;
  emoji?: string | null;
  /** Its resolved Connect switch, the same value its Dispatcher card shows. */
  connected: boolean;
  /** What it's for, from its card, when it has one. */
  purpose?: string;
}

/** What Forget everything removed. Agents, connections and Actions are never touched. */
export interface ForgetEverythingResult {
  /** Folders removed: memory, and any old notes folders. */
  removed: number;
  /** News held for the next check-in that was dropped. */
  heldNews: number;
}
