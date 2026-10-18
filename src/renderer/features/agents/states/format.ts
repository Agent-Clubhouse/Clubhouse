/** Plain-text formatting shared by the agent-state views (#2019). */
import type { AgentSleepInfo } from '../../../../shared/types';

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

/** "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function formatAgo(at: number, now: number = Date.now()): string {
  const diff = now - at;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(at).toLocaleDateString();
}

export function formatUsd(usd: number): string {
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** Split a path into its file name and the directory it sits in. */
export function splitPath(p: string): { name: string; dir: string } {
  const clean = p.replace(/\\/g, '/');
  const i = clean.lastIndexOf('/');
  return i < 0 ? { name: clean, dir: '' } : { name: clean.slice(i + 1), dir: clean.slice(0, i) };
}

/** Show a path relative to the agent's directory when it sits inside it. */
export function relativeTo(p: string, base?: string): string {
  if (!base) return p;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(p);
  const b = norm(base);
  return a.startsWith(b + '/') ? a.slice(b.length + 1) : a;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
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
