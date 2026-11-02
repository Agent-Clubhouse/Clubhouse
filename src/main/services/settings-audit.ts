/**
 * The audit record of settings changes (#2671), one JSON line per change or
 * refusal, in `settings-audit.jsonl` under the Clubhouse base dir. Bounded: 1 MB,
 * then one rotated file. docs/helper-auto-routing.md lists what it covers.
 *
 * It hooks where settings are written, not where they're asked for, so a new way
 * to reach a writer is covered without doing anything. Who asked comes from
 * withSettingsSurface around each entry point.
 *
 * A value is kept only through a per-key format: an enum, boolean, whole number or
 * short id. Everything else, such as names, commands, env and instructions,
 * records `changed: true` and nothing about what it holds. Rows use ids, not paths.
 *
 * Off until enableSettingsAudit, at startup.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import { createAuditLog } from './bounded-audit-log';
import { setSettingsStoreAuditor } from './settings-store';

export type SettingsAuditSurface = 'ui' | 'mcp' | 'mobile' | 'dispatcher' | 'persona' | 'cli' | 'system';
export type SettingsAuditValue = boolean | number | string | null;

export interface SettingsAuditRow {
  surface: SettingsAuditSurface;
  /** The agent that asked, when an agent did. */
  actorId?: string;
  scope: 'app' | 'project' | 'agent';
  /** The agent or project the setting is on. */
  targetId?: string;
  key: string;
  before?: SettingsAuditValue;
  after?: SettingsAuditValue;
  /** The value isn't one to keep, so this only says it changed. */
  changed?: true;
  outcome: 'ok' | 'refused' | 'error';
  code?: string;
}

export const MAX_SETTINGS_AUDIT_READ = 50;

const log = createAuditLog<SettingsAuditRow>('settings-audit.jsonl', (row) => ({ key: row.key }), MAX_SETTINGS_AUDIT_READ);

let enabled = false;

export const settingsAuditPath = log.path;
export const readSettingsAudit = log.read;

/** Never throws. False only when the record couldn't be written; the change it describes has happened. */
export function appendSettingsAudit(row: SettingsAuditRow): Promise<boolean> {
  return enabled ? log.append(row) : Promise.resolve(true);
}

// ── Who asked ────────────────────────────────────────────────────────────

const origin = new AsyncLocalStorage<{ surface: SettingsAuditSurface; actorId?: string }>();

/** Run `fn` as coming from this surface. Set at each entry point: an IPC handler, an MCP tool, a phone's command. */
export function withSettingsSurface<T>(surface: SettingsAuditSurface, actorId: string | undefined, fn: () => T): T {
  return origin.run({ surface, ...(actorId && { actorId }) }, fn);
}

/** Who is asking now. Nothing set means Clubhouse itself. */
export function currentSettingsOrigin(): { surface: SettingsAuditSurface; actorId?: string } {
  return origin.getStore() ?? { surface: 'system' };
}

// ── What is kept ─────────────────────────────────────────────────────────

/**
 * - `value`: a boolean, a whole number, or a short word or id.
 * - `changed`: never the value, whatever it looks like.
 */
export type AuditKeyFormat = 'value' | 'changed';

const SHORT_ID = /^[\w.:[\]-]{1,64}$/;

/** A value fit to keep, or undefined if this one isn't, even on a `value` key: anything longer or odder records only that it changed. */
function keepable(value: unknown): SettingsAuditValue | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && SHORT_ID.test(value)) return value;
  return undefined;
}

function same(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** One row per catalog key that differs. A key not in the catalog isn't looked at. Never throws. */
export async function auditChanges(
  scope: SettingsAuditRow['scope'],
  prefix: string,
  targetId: string | undefined,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  catalog: Readonly<Record<string, AuditKeyFormat>>,
): Promise<void> {
  if (!enabled) return;
  const who = currentSettingsOrigin();
  for (const [key, format] of Object.entries(catalog)) {
    if (same(before[key], after[key])) continue;
    const was = format === 'value' ? keepable(before[key]) : undefined;
    const now = format === 'value' ? keepable(after[key]) : undefined;
    const row: SettingsAuditRow = {
      ...who, scope, key: `${prefix}.${key}`, ...(targetId && { targetId }), outcome: 'ok',
      ...(was !== undefined && now !== undefined ? { before: was, after: now } : { changed: true as const }),
    };
    await log.append(row);
  }
}

/** A project in a row, where only its path is to hand: stable, and not the path. */
export function projectAuditTarget(projectPath: string): string {
  return `path:${createHash('sha256').update(projectPath).digest('hex').slice(0, 12)}`;
}

/** A setting that isn't a key on a record, such as a file's contents: only that it changed. */
export async function auditChanged(scope: SettingsAuditRow['scope'], key: string, targetId?: string): Promise<void> {
  if (!enabled) return;
  await log.append({ ...currentSettingsOrigin(), scope, key, ...(targetId && { targetId }), changed: true, outcome: 'ok' });
}

/** Start recording, and have the app's settings stores report to it. Called once at startup. */
export function enableSettingsAudit(): void {
  enabled = true;
  setSettingsStoreAuditor(({ key, before, after, keys, ignore }) => {
    const catalog: Record<string, AuditKeyFormat> = {};
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (ignore?.includes(name)) continue;
      // A boolean can't hold anything but itself. Anything else needs a store to say so.
      const isSwitch = typeof before[name] === 'boolean' || typeof after[name] === 'boolean';
      catalog[name] = isSwitch || keys?.includes(name) ? 'value' : 'changed';
    }
    return auditChanges('app', key, undefined, before, after, catalog);
  });
}

/** For testing. */
export function _resetSettingsAuditForTesting(on = false): void {
  log.reset();
  enabled = on;
  setSettingsStoreAuditor(null);
}
