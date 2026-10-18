/**
 * Per-agent auto-sleep (#2143). A durable agent can override the app-wide
 * chat idle timeout (#2104): `inherit` follows the app setting, `never` keeps
 * it awake, and a number of minutes sleeps it after that long idle. Unset on
 * the config means `inherit`.
 */

export type AgentIdleSleep = 'inherit' | 'never' | number;

/** Minutes offered for an agent's own timeout; the same as the app setting's. */
export const AGENT_IDLE_SLEEP_MINUTES = [15, 30, 60, 240] as const;

/** A stored value as one we act on; anything malformed inherits. */
export function normalizeIdleSleep(value: unknown): AgentIdleSleep {
  if (value === 'never') return 'never';
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  return 'inherit';
}

export interface ResolvedIdleSleep {
  /** Minutes before the agent sleeps; 0 means never. */
  minutes: number;
  source: 'agent' | 'app';
}

/** Agent over app. `appMinutes` is the app setting, where 0 is Never. */
export function resolveIdleSleep(agent: unknown, appMinutes: number): ResolvedIdleSleep {
  const own = normalizeIdleSleep(agent);
  if (own === 'never') return { minutes: 0, source: 'agent' };
  if (own !== 'inherit') return { minutes: own, source: 'agent' };
  return { minutes: Number.isFinite(appMinutes) && appMinutes > 0 ? appMinutes : 0, source: 'app' };
}

/** "30 min", "4 h" or "Never". */
export function formatIdleMinutes(minutes: number): string {
  if (!(minutes > 0)) return 'Never';
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}
