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

import { createAuditLog, MAX_AUDIT_BYTES } from './bounded-audit-log';

export { MAX_AUDIT_BYTES };
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

const log = createAuditLog<Omit<AuditRow, 'ts'>>('dispatcher-audit.jsonl', (row) => ({ tool: row.tool }), MAX_AUDIT_READ);

export const auditPath = log.path;

/** A string the caller supplied, safe to keep in a row. */
export function auditString(value: unknown): string {
  return (typeof value === 'string' ? value : String(value)).slice(0, MAX_CALLER_STRING);
}

/** Argument names the caller supplied, safe to keep in a row. */
export function auditNames(names: readonly string[]): string[] {
  return names.slice(0, MAX_CALLER_LIST).map(auditString);
}

/**
 * Append a row. Returns false when it couldn't be written: the change it
 * describes has already happened, so the caller reports that and carries on.
 */
export const appendAudit = log.append;

/** The newest rows, newest first, up to {@link MAX_AUDIT_READ}. */
export function readAudit(limit: number): Promise<AuditRow[]> {
  return log.read(limit);
}

/** For testing: forget pending work. */
export const _resetDispatcherAuditForTesting = log.reset;
