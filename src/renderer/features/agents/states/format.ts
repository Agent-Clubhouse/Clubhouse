/** Plain-text formatting shared by the agent-state views (#2019). */

export { formatDuration, formatShortDuration, describeSleep } from '../../../../shared/agent-session-display';

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
