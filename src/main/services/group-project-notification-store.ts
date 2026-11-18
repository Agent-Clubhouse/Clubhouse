/** Local delivery receipts, deliberately separate from replicated board state. */
import * as path from 'path';
import * as fsp from 'fs/promises';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { replaceFile } from './settings-store';
import { groupProjectHost } from './group-project-host';
import { appLog } from './log-service';

export const WAKE_LIMIT_MAX = 3;
export const WAKE_LIMIT_WINDOW_MS = 10 * 60_000;
export const URGENT_LIMIT_MAX = 20;
export const URGENT_LIMIT_WINDOW_MS = 10 * 60_000;
interface Receipts { notified: Record<string, number>; wakes: Record<string, number[]>; urgent: Record<string, number[]> }
const empty = (): Receipts => ({ notified: {}, wakes: {}, urgent: {} });
const key = (group: string, agent: string) => JSON.stringify([group, agent]);
// Local derived state belongs to this computer's app data, outside shared board storage.
// A legacy file in the shared directory is deliberately ignored; missing cursors baseline on connect.
const file = () => path.join(app.getPath('userData'), 'group-project-notification-receipts.json');
async function writeReceipts(location: string, receipts: Receipts): Promise<void> {
  await fsp.mkdir(path.dirname(location), { recursive: true });
  await replaceFile(location, JSON.stringify(receipts, null, 2), undefined);
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function validate(raw: unknown): Receipts {
  if (!record(raw) || !record(raw.notified) || !record(raw.wakes) || (raw.urgent !== undefined && !record(raw.urgent))) throw new Error('Invalid notification receipts');
  for (const [k, n] of Object.entries(raw.notified)) {
    const pair: unknown = JSON.parse(k);
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((v) => typeof v !== 'string') || !Number.isSafeInteger(n) || (n as number) < 0) throw new Error('Invalid notification cursor');
  }
  for (const budget of [raw.wakes, raw.urgent ?? {}]) {
    if (Object.values(budget).some((a) => !Array.isArray(a) || a.some((n) => !Number.isFinite(n) || n < 0))) throw new Error('Invalid notification budget');
  }
  return { notified: raw.notified, wakes: raw.wakes, urgent: raw.urgent ?? {} } as Receipts;
}
interface Roster { group: string; seq: number; agents: string[] }
interface RosterSnapshot { groups?: Set<string>; rows: Roster[]; unresolved: Set<string> }
/** Only explicit main-process departures/deletions remove a member cursor. */
export interface ReceiptDepartures { deletedGroups?: string[]; departed?: Array<{ group: string; agents: string[] }> }
async function roster(): Promise<RosterSnapshot> {
  let projects: Awaited<ReturnType<typeof groupProjectHost.list>>;
  try { projects = await groupProjectHost.list(); } catch (err) {
    // telemetry-exempt: preserve all receipts when the registry cannot be read
    appLog('core:group-project', 'warn', 'Could not inspect groups for receipt maintenance', { meta: { error: String(err) } });
    return { rows: [], unresolved: new Set() };
  }
  const results = await Promise.allSettled(projects.map(async (gp) => ({
    group: gp.id, seq: gp.seq ?? Math.max(0, ...(await groupProjectHost.readRecentBySeq(gp.id, 50)).map((m) => m.seq ?? 0)),
    agents: (await groupProjectHost.resolveMembers(gp.id)).map((m) => groupProjectHost.localAgentId(gp, m.address)).filter((a): a is string => !!a),
  })));
  const rows: Roster[] = []; const unresolved = new Set<string>();
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') rows.push(result.value);
    else {
      unresolved.add(projects[i].id);
      appLog('core:group-project', 'warn', 'Could not inspect group for receipt maintenance; preserving its receipts', { meta: { groupProjectId: projects[i].id, error: String(result.reason) } });
    }
  });
  return { groups: new Set(projects.map((gp) => gp.id)), rows, unresolved };
}
function prune(r: Receipts, snapshot: RosterSnapshot, confirmed: ReceiptDepartures = {}): void {
  const deleted = new Set(confirmed.deletedGroups);
  const departed = new Set((confirmed.departed ?? []).filter((g) => !snapshot.unresolved.has(g.group)).flatMap((g) => g.agents.map((a) => key(g.group, a))));
  for (const k of Object.keys(r.notified)) {
    const [group] = JSON.parse(k) as string[];
    if (deleted.has(group) || (snapshot.groups && !snapshot.groups.has(group)) || departed.has(k)) delete r.notified[k];
  }
  // A temporarily absent/unresolved member may still own unread receipts and budgets.
  const agents = new Set([...snapshot.rows.flatMap((g) => g.agents), ...Object.keys(r.notified).map((k) => (JSON.parse(k) as string[])[1])]);
  const complete = !!snapshot.groups && snapshot.unresolved.size === 0;
  for (const a of Object.keys(r.wakes)) {
    r.wakes[a] = r.wakes[a].filter((at) => Date.now() - at < WAKE_LIMIT_WINDOW_MS);
    if ((complete && !agents.has(a)) || !r.wakes[a].length) delete r.wakes[a];
  }
  for (const k of Object.keys(r.urgent)) {
    let recipient: unknown;
    try { recipient = JSON.parse(k)[1]; } catch { /* telemetry-exempt: invalid budget key is pruned below */ }
    r.urgent[k] = r.urgent[k].filter((at) => Date.now() - at < URGENT_LIMIT_WINDOW_MS);
    if ((complete && !agents.has(recipient as string)) || !r.urgent[k].length) delete r.urgent[k];
  }
}
let pending: Promise<unknown> = Promise.resolve();
let loaded: { file: string; data: Receipts } | undefined;
async function load(): Promise<Receipts> {
  const location = file();
  if (loaded?.file === location) return loaded.data;
  let r = empty(); let corrupt = false;
  let raw: string | undefined;
  try { raw = await fsp.readFile(location, 'utf8'); } catch (err) {
    // telemetry-exempt: ENOENT initializes a new store; other I/O errors propagate
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (raw !== undefined) {
    try { r = validate(JSON.parse(raw)); } catch (err) {
      // telemetry-exempt: corrupt data is quarantined and logged before recovery
      const quarantine = `${location}.corrupt-${Date.now()}-${randomUUID()}`;
      await fsp.rename(location, quarantine);
      appLog('core:group-project', 'warn', 'Corrupt notification receipts quarantined', { meta: { quarantine, error: String(err) } });
      corrupt = true;
    }
  }
  const current = await roster();
  prune(r, current);
  // Recovery deliberately starts now, rather than replaying a board's history.
  if (corrupt) for (const g of current.rows) for (const a of g.agents) r.notified[key(g.group, a)] = g.seq;
  await writeReceipts(location, r);
  loaded = { file: location, data: r };
  return r;
}
function access<T>(fn: (r: Receipts) => Promise<T>): Promise<T> {
  const next = pending.catch(() => {}).then(async () => fn(await load())); pending = next; return next;
}
/** Undefined is a new member/upgrade, not an unread cursor at the start of history. */
export function lastNotified(group: string, agent: string): Promise<number | undefined> {
  return access(async (r) => r.notified[key(group, agent)]);
}
export function initializeNotified(group: string, agent: string, seq: number): Promise<number> {
  return access(async (r) => {
    const k = key(group, agent);
    if (r.notified[k] === undefined) { r.notified[k] = seq; await writeReceipts(file(), r); }
    return r.notified[k];
  });
}
export function markNotified(group: string, agent: string, seq: number): Promise<void> {
  return access(async (r) => { r.notified[key(group, agent)] = Math.max(r.notified[key(group, agent)] ?? 0, seq); await writeReceipts(file(), r); });
}
export function pruneNotificationReceipts(confirmed: ReceiptDepartures = {}): Promise<void> {
  return access(async (r) => { prune(r, await roster(), confirmed); await writeReceipts(file(), r); });
}
export function reserveWake(agent: string, now = Date.now()): Promise<boolean> {
  return access(async (r) => {
    const recent = (r.wakes[agent] ?? []).filter((at) => now - at < WAKE_LIMIT_WINDOW_MS);
    if (recent.length >= WAKE_LIMIT_MAX) return false;
    r.wakes[agent] = [...recent, now]; await writeReceipts(file(), r); return true;
  });
}
export function wakeBudgetAvailable(agent: string, now = Date.now()): Promise<boolean> {
  return access(async (r) => (r.wakes[agent] ?? []).filter((at) => now - at < WAKE_LIMIT_WINDOW_MS).length < WAKE_LIMIT_MAX);
}
export function reserveUrgent(sender: string, agent: string, now = Date.now()): Promise<boolean> {
  return access(async (r) => {
    const k = key(sender, agent);
    const recent = (r.urgent[k] ?? []).filter((at) => now - at < URGENT_LIMIT_WINDOW_MS);
    if (recent.length >= URGENT_LIMIT_MAX) return false;
    r.urgent[k] = [...recent, now]; await writeReceipts(file(), r); return true;
  });
}
