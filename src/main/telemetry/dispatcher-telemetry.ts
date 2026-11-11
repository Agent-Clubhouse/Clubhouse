/**
 * Dispatcher telemetry (#3052, epic #3034; spec §4.18 and §6.13).
 *
 * - `clubhouse.dispatcher.turn`: each finished turn, split into conversations
 *   and background work, with what the provider reported it used.
 * - `clubhouse.dispatcher.memory_health` and `.memory_upkeep`: after each
 *   memory upkeep run, how big memory is, the index against its cap, pages
 *   nothing links to, stale pages and broken links, and what upkeep fixed.
 * - `clubhouse.dispatcher.news_triage`: what happened to each report on its
 *   way to the chat, and how an agent's news was rewritten.
 * - `clubhouse.audit.dispatcher_control`: the Dispatcher's controls over
 *   orchestrators (#2661), read back by `list_orchestrator_controls`. This was
 *   dispatcher-audit.ts.
 *
 * Safety:
 * - The Dispatcher events carry counts, sizes and closed codes only. Never
 *   message text, page contents, page or agent names, paths or ids, and never
 *   which of the Dispatcher's agents did the work.
 * - With telemetry off nothing is built or recorded, and callers can skip
 *   measuring with `dispatcherTelemetryActive()`.
 * - Nothing here changes what the Dispatcher does: every recorder returns void
 *   (or what was recorded) and swallows its own errors.
 */

import { isTelemetryActive, tel } from './facade';
import { ATTR, type TelAttr } from '../../shared/telemetry/attributes';
import { localRecordSalt, readLocalEvents } from './local-control';
import { hashId } from './ids';
import type { DispatcherUsageKind } from '../../shared/dispatcher-usage';
import type { TokenUsage } from '../../shared/chat';

/** Whether recording would do anything; skip measuring when it wouldn't. */
export function dispatcherTelemetryActive(): boolean {
  return isTelemetryActive();
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

// ── Usage split ─────────────────────────────────────────────────────────────

export interface DispatcherTurnUsage {
  tokens?: TokenUsage;
  costUsd?: number;
  costIsEstimate?: boolean;
}

const TOKEN_ATTRS = [
  ['input', ATTR.dispatcherTurnInputTokens],
  ['cachedInput', ATTR.dispatcherTurnCachedInputTokens],
  ['cacheWrite', ATTR.dispatcherTurnCacheWriteTokens],
  ['output', ATTR.dispatcherTurnOutputTokens],
  ['reasoning', ATTR.dispatcherTurnReasoningTokens],
] as const;

const reported = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** One finished Dispatcher turn. Never throws. */
export function recordDispatcherTurn(kind: DispatcherUsageKind, usage: DispatcherTurnUsage): void {
  try {
    if (!isTelemetryActive()) return;
    const attrs: TelAttr[] = [ATTR.dispatcherWork(kind)];
    for (const [key, attr] of TOKEN_ATTRS) {
      const value = usage.tokens?.[key];
      if (reported(value)) attrs.push(attr(value));
    }
    if (reported(usage.costUsd)) {
      attrs.push(ATTR.dispatcherTurnCostMicroUsd(Math.round(usage.costUsd * 1_000_000)), ATTR.costEstimate(usage.costIsEstimate === true));
    }
    attrs.splice(1, 0, ATTR.dispatcherTurnUsageReported(attrs.length > 1));
    tel.event('clubhouse.dispatcher.turn', attrs);
  } catch {
    // telemetry-exempt: telemetry never affects the usage count
  }
}

// ── Memory health and upkeep ────────────────────────────────────────────────

/** Memory as upkeep left it. Counts and sizes only. */
export interface DispatcherMemoryHealth {
  pages: number;
  bytes: number;
  topics: number;
  agentPages: number;
  timelinePages: number;
  indexBytes: number;
  indexCapBytes: number;
  unlinkedTopics: number;
  staleTopics: number;
  unconfirmedTopics: number;
  conflictingPages: number;
  brokenLinks: number;
  missingSources: number;
}

/** What one upkeep run did. `outcome` is `error` when it threw before finishing. */
export interface DispatcherUpkeepOutcome {
  outcome: 'ok' | 'error';
  rolledDays?: number;
  rolledWeeks?: number;
  linksFixed?: number;
  pruned?: number;
  toCheck?: number;
  review?: boolean;
}

/** Memory health after an upkeep run. Never throws. */
export function recordMemoryHealth(h: DispatcherMemoryHealth): void {
  try {
    if (!isTelemetryActive()) return;
    tel.event('clubhouse.dispatcher.memory_health', [
      ATTR.dispatcherMemoryPages(count(h.pages)),
      ATTR.dispatcherMemoryBytes(count(h.bytes)),
      ATTR.dispatcherMemoryTopics(count(h.topics)),
      ATTR.dispatcherMemoryAgentPages(count(h.agentPages)),
      ATTR.dispatcherMemoryTimelinePages(count(h.timelinePages)),
      ATTR.dispatcherMemoryIndexBytes(count(h.indexBytes)),
      ATTR.dispatcherMemoryIndexCapBytes(count(h.indexCapBytes)),
      ATTR.dispatcherMemoryIndexOverCap(count(h.indexBytes) > count(h.indexCapBytes)),
      ATTR.dispatcherMemoryUnlinkedTopics(count(h.unlinkedTopics)),
      ATTR.dispatcherMemoryStaleTopics(count(h.staleTopics)),
      ATTR.dispatcherMemoryUnconfirmedTopics(count(h.unconfirmedTopics)),
      ATTR.dispatcherMemoryConflictingPages(count(h.conflictingPages)),
      ATTR.dispatcherMemoryBrokenLinks(count(h.brokenLinks)),
      ATTR.dispatcherMemoryMissingSources(count(h.missingSources)),
    ]);
  } catch {
    // telemetry-exempt: telemetry never affects upkeep
  }
}

/** One memory upkeep run. Never throws. */
export function recordMemoryUpkeep(u: DispatcherUpkeepOutcome): void {
  try {
    if (!isTelemetryActive()) return;
    tel.event('clubhouse.dispatcher.memory_upkeep', [
      ATTR.outcome(u.outcome),
      ATTR.dispatcherUpkeepRolledDays(count(u.rolledDays)),
      ATTR.dispatcherUpkeepRolledWeeks(count(u.rolledWeeks)),
      ATTR.dispatcherUpkeepLinksFixed(count(u.linksFixed)),
      ATTR.dispatcherUpkeepPruned(count(u.pruned)),
      ATTR.dispatcherUpkeepToCheck(count(u.toCheck)),
      ATTR.dispatcherUpkeepReview(u.review === true),
    ], u.outcome === 'error' ? { severity: 'warn' } : undefined);
  } catch {
    // telemetry-exempt: telemetry never affects upkeep
  }
}

// ── News triage ─────────────────────────────────────────────────────────────

type NewsReason = Parameters<typeof ATTR.dispatcherNewsReason>[0];

export interface DispatcherNewsOutcome {
  kind: Parameters<typeof ATTR.dispatcherNewsKind>[0];
  show: Parameters<typeof ATTR.dispatcherNewsShow>[0];
  reason?: NewsReason;
  fromAgent: boolean;
  /** Held items a check-in summary took with it. */
  held?: number;
}

/** One report's way to the chat. Never throws. */
export function recordNewsTriage(n: DispatcherNewsOutcome): void {
  try {
    if (!isTelemetryActive()) return;
    tel.event('clubhouse.dispatcher.news_triage', [
      ATTR.dispatcherNewsKind(n.kind),
      ATTR.dispatcherNewsShow(n.show),
      ATTR.dispatcherNewsReason(n.reason ?? 'none'),
      ATTR.dispatcherNewsFromAgent(n.fromAgent === true),
      ...(n.show === 'check_in' ? [ATTR.dispatcherNewsHeld(count(n.held))] : []),
      // No rewrite step since #3193: the chat says agents' news in its own words. Kept so the event's attributes don't change.
      ATTR.dispatcherNewsRewrite('none'),
      ATTR.dispatcherNewsRewriteReason('none'),
    ]);
  } catch {
    // telemetry-exempt: telemetry never affects the chat
  }
}

// ── Control audit (was dispatcher-audit.ts) ─────────────────────────────────
//
// One `clubhouse.audit.dispatcher_control` event per control call, refusals
// included, in the local record (#2920, §6.13). appLog isn't enough: it can be
// off. Rows hold allowlisted values only, and strings the caller supplied are
// cut short. The record's retention keeps it bounded.

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
 * Record one control call: tool, outcome and hashed ids as attributes; every
 * target's hash, what was requested, before, after and the code in the local
 * record's detail only. Returns false when nothing records it (local telemetry
 * recording is off). The change it describes has already happened, so the
 * caller reports that and carries on. Never throws.
 */
export function recordDispatcherControl(row: Omit<AuditRow, 'ts'>): boolean {
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
    // telemetry-exempt: the caller still reports the change it made
  }
  return isTelemetryActive();
}

type Flat = Record<string, AuditValue>;
const flatOf = (v: unknown): Flat | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Flat : undefined);

/**
 * The newest control rows from the local record, newest first. Ids are hashed
 * there, so each is matched against `knownIds` hashed with the record's salt;
 * one that matches none (an agent since removed) shows as `hash:<hash>`.
 * Empty while telemetry signals aren't recorded locally.
 */
export async function readDispatcherControls(limit: number, knownIds: Iterable<string>): Promise<AuditRow[]> {
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
