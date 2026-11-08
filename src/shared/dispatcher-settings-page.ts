/**
 * What Settings › Dispatcher (#3046, part of #3034) reads from main besides
 * DispatcherState: its usage, the agents it can reach, and what Forget
 * everything did.
 */

/** Token counts summed over sessions, as their transcripts reported them. */
export interface UsageTotals {
  /** Input tokens, not counting cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  /** Sessions that counted. */
  sessions: number;
}

export const EMPTY_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, sessions: 0 };

/**
 * The Dispatcher's usage over the last {@link USAGE_WINDOW_DAYS} days, across
 * every provider it ran on. `background` is null until background work
 * (check-ins and memory upkeep, #3040) reports its own share; until then
 * `conversations` holds everything.
 */
export interface DispatcherUsage {
  conversations: UsageTotals;
  background: UsageTotals | null;
  /** When main read it, in ms. */
  readAt: number;
}

export const USAGE_WINDOW_DAYS = 7;

/** "1.2M", "48K", "950". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(Math.max(0, Math.round(n)));
}

/** One line for a share of usage: "3 sessions, 1.2M tokens in and 48K out", or "None yet". */
export function describeUsage(totals: UsageTotals): string {
  if (totals.sessions === 0) return 'None yet';
  const sessions = totals.sessions === 1 ? '1 session' : `${totals.sessions} sessions`;
  return `${sessions}, ${formatTokenCount(totals.inputTokens)} tokens in and ${formatTokenCount(totals.outputTokens)} out`;
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
