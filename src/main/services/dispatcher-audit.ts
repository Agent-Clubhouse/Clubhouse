/**
 * The audit record of the Dispatcher's controls over orchestrators (#2661): one
 * `clubhouse.audit.dispatcher_control` event per call, refusals included, in the
 * local telemetry record (#2920, docs/telemetry-otel-spec.md §6.13). appLog isn't
 * enough: it can be off.
 *
 * Rows hold allowlisted values only, and strings the caller supplied are cut
 * short. The record's retention keeps it bounded.
 */

import { isTelemetryActive, tel } from '../telemetry/facade';
import { ATTR } from '../../shared/telemetry/attributes';
import { localRecordSalt, readLocalEvents } from '../telemetry/local-control';
import { hashId } from '../telemetry/ids';
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


/** A string the caller supplied, safe to keep in a row. */
export function auditString(value: unknown): string {
  return (typeof value === 'string' ? value : String(value)).slice(0, MAX_CALLER_STRING);
}

/** Argument names the caller supplied, safe to keep in a row. */
export function auditNames(names: readonly string[]): string[] {
  return names.slice(0, MAX_CALLER_LIST).map(auditString);
}

type AuditTool = Parameters<typeof ATTR.auditTool>[0];

/**
 * The row as a telemetry audit event (#2920): tool, outcome and hashed ids as
 * attributes; every target's hash, what was requested, before, after and the code
 * in the local record's detail only. Never throws.
 */
function recordEvent(row: Omit<AuditRow, 'ts'>): void {
  try {
    tel.event('clubhouse.audit.dispatcher_control', [
      ATTR.auditTool(row.tool as AuditTool), ATTR.auditOutcome(row.outcome),
      ATTR.auditActorIdHash(row.actorId),
      ...(row.targets[0] ? [ATTR.auditTargetIdHash(row.targets[0])] : []),
    ], {
      severity: row.outcome === 'ok' ? 'info' : 'warn',
      detail: {
        tool: row.tool,
        ...(row.requested && { requested: row.requested }),
        ...(row.before && { before: row.before }),
        ...(row.after && { after: row.after }),
        ...(row.code && { code: row.code }),
      },
      detailIds: { targets: row.targets },
    });
  } catch {
    // telemetry-exempt: the JSONL row below is still written
  }
}

/**
 * Record a row. Returns false when nothing records it: local telemetry recording
 * is off. The change it describes has already happened, so the caller reports
 * that and carries on.
 */
export async function appendAudit(row: Omit<AuditRow, 'ts'>): Promise<boolean> {
  recordEvent(row);
  return isTelemetryActive();
}

type Flat = Record<string, AuditValue>;
const flatOf = (v: unknown): Flat | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Flat : undefined);

/**
 * The newest rows from the local telemetry record (#2920), newest first. Ids are
 * hashed there, so each is matched against `knownIds` hashed with the record's
 * salt; one that matches none (an agent since removed) shows as `hash:<hash>`.
 * Empty while telemetry signals aren't recorded locally.
 */
export async function readAuditFromRecord(limit: number, knownIds: Iterable<string>): Promise<AuditRow[]> {
  const wanted = Math.min(Math.max(Math.floor(limit), 0), MAX_AUDIT_READ);
  if (wanted === 0) return [];
  const salt = localRecordSalt();
  if (!salt) return [];
  // Read past rows hashed under another salt (another build, or before a reset), which can't be matched.
  const events = await readLocalEvents('clubhouse.audit.dispatcher_control', MAX_AUDIT_READ * 4);
  const byHash = new Map<string, string>();
  for (const id of knownIds) byHash.set(hashId(salt, id), id);
  const idOf = (hash: unknown) => (typeof hash === 'string' ? byHash.get(hash) ?? `hash:${hash}` : 'unknown');
  const matched = events.filter((e) => byHash.has(String(e.attrs['clubhouse.audit.actor.id_hash'])));
  return matched.slice(0, wanted).map((e) => {
    const detail = e.detail ?? {};
    const targets = Array.isArray(detail.targets) ? detail.targets.map(idOf) : [];
    const outcome = e.attrs['clubhouse.audit.outcome'];
    // A row without a recognised outcome is not taken as a success.
    const requested = flatOf(detail.requested) as AuditRow['requested'];
    const before = flatOf(detail.before);
    const after = flatOf(detail.after);
    return {
      ts: e.ts,
      tool: typeof detail.tool === 'string' ? detail.tool : String(e.attrs['clubhouse.audit.tool'] ?? 'other'),
      actorId: idOf(e.attrs['clubhouse.audit.actor.id_hash']),
      targets,
      ...(requested && { requested }),
      ...(before && { before }),
      ...(after && { after }),
      outcome: outcome === 'ok' || outcome === 'refused' ? outcome : 'error',
      ...(typeof detail.code === 'string' && { code: detail.code }),
    };
  });
}

