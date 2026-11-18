/** Local delivery receipts, deliberately separate from replicated board state. */
import * as path from 'path';
import { groupProjectsDir } from './group-project-paths';
import { readJsonFile, writeJsonFile } from './group-project-json-file';

export const WAKE_LIMIT_MAX = 3;
export const WAKE_LIMIT_WINDOW_MS = 10 * 60_000;
interface Receipts { notified: Record<string, number>; wakes: Record<string, number[]> }
const empty = (): Receipts => ({ notified: {}, wakes: {} });
function validate(raw: unknown): Receipts {
  const r = raw as Receipts;
  if (!r || !r.notified || !r.wakes || Object.values(r.notified).some((n) => !Number.isSafeInteger(n) || n < 0)
    || Object.values(r.wakes).some((a) => !Array.isArray(a) || a.some((n) => !Number.isFinite(n)))) throw new Error('Invalid notification receipts');
  return r;
}
let pending: Promise<unknown> = Promise.resolve();
function access<T>(fn: (r: Receipts) => Promise<T>): Promise<T> {
  const next = pending.catch(() => {}).then(async () => fn(await readJsonFile(file(), empty, validate)));
  pending = next;
  return next;
}
const file = () => path.join(groupProjectsDir(), 'notification-receipts.json');
const key = (group: string, agent: string) => JSON.stringify([group, agent]);
export function lastNotified(group: string, agent: string): Promise<number> {
  return access(async (r) => r.notified[key(group, agent)] ?? 0);
}
export function markNotified(group: string, agent: string, seq: number): Promise<void> {
  return access(async (r) => {
    r.notified[key(group, agent)] = Math.max(r.notified[key(group, agent)] ?? 0, seq);
    await writeJsonFile(file(), r);
  });
}
/** Reserve before spawning: parallel projects and restarts share the same recipient budget. */
export function reserveWake(agent: string, now = Date.now()): Promise<boolean> {
  return access(async (r) => {
    const recent = (r.wakes[agent] ?? []).filter((at) => now - at < WAKE_LIMIT_WINDOW_MS);
    if (recent.length >= WAKE_LIMIT_MAX) return false;
    r.wakes[agent] = [...recent, now];
    await writeJsonFile(file(), r);
    return true;
  });
}
