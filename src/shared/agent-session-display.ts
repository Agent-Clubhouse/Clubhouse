/** Plain-text session fields shared by local and host-read Details. */
import type { AgentSleepInfo } from './types';

/** "3s", "4m 12s", "1h 5m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Coarser than formatDuration, for a past session's length: "41m", "2h 5m". */
export function formatShortDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return formatDuration(ms);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Why an agent went to sleep, in a few words (#2104): "slept after 30 min
 * idle", "stopped by you", "put to sleep by Clubhouse-PM", "CLI exited (code 1)".
 */
export function describeSleep(info: AgentSleepInfo): string {
  switch (info.reason) {
    case 'idle': {
      const m = info.idleMinutes;
      const span = m === undefined ? '' : m >= 60 && m % 60 === 0 ? ` ${m / 60} h` : ` ${m} min`;
      return `slept after${span} idle`;
    }
    case 'user': return 'stopped by you';
    case 'agent': return info.by ? `put to sleep by ${info.by}` : 'put to sleep by another agent';
    case 'crashed': return info.exitCode !== undefined ? `CLI exited (code ${info.exitCode})` : 'CLI exited with an error';
    case 'exited': return 'CLI exited';
  }
}
