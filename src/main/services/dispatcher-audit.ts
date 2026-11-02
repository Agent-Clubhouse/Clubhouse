/**
 * The audit record of the Dispatcher's controls over orchestrators (#2661): one
 * JSON line per call, refusals included, in `dispatcher-audit.jsonl` under the
 * Clubhouse base dir. Not the Dispatcher's folder, which is its working
 * directory. appLog isn't enough: it can be off.
 *
 * Rows hold allowlisted values only, and strings the caller supplied are cut
 * short. At {@link MAX_AUDIT_BYTES} the file moves to `.1`, replacing the last
 * one, so the record stays bounded.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { getBaseDirPath } from './base-dir';
import { appLog } from './log-service';

export const MAX_AUDIT_BYTES = 1024 * 1024;
export const MAX_AUDIT_READ = 50;
const MAX_CALLER_STRING = 100;
const MAX_CALLER_LIST = 8;

export type AuditValue = boolean | number | string | null;

export interface AuditRow {
  ts: string;
  tool: string;
  actorId: string;
  /** The agents named, as the caller gave them. */
  targets: string[];
  requested?: Record<string, AuditValue | string[]>;
  before?: Record<string, AuditValue>;
  after?: Record<string, AuditValue>;
  outcome: 'ok' | 'refused' | 'error';
  /** The refusal's code, or what each pair ended as. */
  code?: string;
}

export function auditPath(): string {
  return path.join(getBaseDirPath(), 'dispatcher-audit.jsonl');
}

/** A string the caller supplied, safe to keep in a row. */
export function auditString(value: unknown): string {
  return (typeof value === 'string' ? value : String(value)).slice(0, MAX_CALLER_STRING);
}

/** Argument names the caller supplied, safe to keep in a row. */
export function auditNames(names: readonly string[]): string[] {
  return names.slice(0, MAX_CALLER_LIST).map(auditString);
}

/** One append or read at a time, so a rotation never races a write. */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.catch((): void => undefined).then(fn);
  queue = run.catch((): void => undefined);
  return run;
}

async function rotateIfFull(file: string): Promise<void> {
  try {
    if ((await fsp.stat(file)).size >= MAX_AUDIT_BYTES) await fsp.rename(file, `${file}.1`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Append a row. Returns false when it couldn't be written: the change it
 * describes has already happened, so the caller reports that and carries on.
 */
export function appendAudit(row: Omit<AuditRow, 'ts'>): Promise<boolean> {
  return serial(async () => {
    try {
      const file = auditPath();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await rotateIfFull(file);
      await fsp.appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, 'utf-8');
      return true;
    } catch (err) {
      // telemetry-exempt: logged, and the tool result carries a warning
      appLog('core:mcp', 'warn', 'Could not write the Dispatcher audit record', {
        meta: { tool: row.tool, error: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  });
}

async function readRows(file: string): Promise<AuditRow[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const rows: AuditRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as AuditRow);
    } catch {
      // telemetry-exempt: a torn line (a crash mid-append) is skipped; the rest still read
    }
  }
  return rows;
}

/** The newest rows, newest first, up to {@link MAX_AUDIT_READ}. */
export function readAudit(limit: number): Promise<AuditRow[]> {
  const wanted = Math.min(Math.max(Math.floor(limit), 0), MAX_AUDIT_READ);
  return serial(async () => {
    if (wanted === 0) return [];
    const file = auditPath();
    let rows = await readRows(file);
    if (rows.length < wanted) rows = [...await readRows(`${file}.1`), ...rows];
    return rows.slice(-wanted).reverse();
  });
}

/** For testing: forget pending work. */
export function _resetDispatcherAuditForTesting(): void {
  queue = Promise.resolve();
}
