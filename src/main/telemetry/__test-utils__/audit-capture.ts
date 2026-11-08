/**
 * For tests: the audit events (#2920) as the local recorder would receive them,
 * turned back into rows shaped like the old JSONL audit files. Ids are the raw
 * ids the call site gave (the recorder hashes them on write), and values are
 * what the event's detail carries. Installs itself as the facade's local sink.
 */

import { EVENTS, type EventDef, type EventName } from '../../../shared/telemetry/attributes';
import { setLocalSink } from '../facade';
import type { EventOptions } from '../types';
import { passThroughSink } from './producing-runtime';

type Value = boolean | number | string | null;

export interface CapturedSettingsRow {
  surface: string;
  scope: string;
  outcome: string;
  actorId?: string;
  targetId?: string;
  key: string;
  before?: Value;
  after?: Value;
  changed?: true;
  code?: string;
}

export interface CapturedControlRow {
  tool: string;
  outcome: string;
  actorId: string;
  targets: string[];
  requested?: Record<string, unknown>;
  before?: Record<string, Value>;
  after?: Record<string, Value>;
  code?: string;
}

interface Captured { name: EventName; attrs: Record<string, unknown>; opts?: EventOptions }

export interface AuditCapture {
  /** Settings rows, oldest first. */
  settings(): CapturedSettingsRow[];
  /** Dispatcher control rows, oldest first. */
  controls(): CapturedControlRow[];
  clear(): void;
  stop(): void;
}

export function captureAuditEvents(): AuditCapture {
  const events: Captured[] = [];
  setLocalSink({
    ...passThroughSink('standard'),
    event: (name, attrs, opts) => {
      if (!(EVENTS[name] as EventDef).audit) return;
      events.push({ name, attrs: Object.fromEntries((attrs ?? []).map((a) => [a.key, a.value])), opts });
    },
  });
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    settings: () => events.filter((e) => e.name === 'clubhouse.audit.setting').map(({ attrs, opts }) => {
      const d = (opts?.detail ?? {}) as Record<string, unknown>;
      return {
        surface: String(attrs['clubhouse.audit.surface']),
        scope: String(attrs['clubhouse.audit.scope']),
        outcome: String(attrs['clubhouse.audit.outcome']),
        ...(str(attrs['clubhouse.audit.actor.id_hash']) && { actorId: str(attrs['clubhouse.audit.actor.id_hash']) }),
        ...(str(attrs['clubhouse.audit.target.id_hash']) && { targetId: str(attrs['clubhouse.audit.target.id_hash']) }),
        key: String(d.key),
        ...('before' in d && { before: d.before as Value }),
        ...('after' in d && { after: d.after as Value }),
        ...(d.changed === true && { changed: true as const }),
        ...(typeof d.code === 'string' && { code: d.code }),
      };
    }),
    controls: () => events.filter((e) => e.name === 'clubhouse.audit.dispatcher_control').map(({ attrs, opts }) => {
      const d = (opts?.detail ?? {}) as Record<string, unknown>;
      return {
        tool: String(d.tool ?? attrs['clubhouse.audit.tool']),
        outcome: String(attrs['clubhouse.audit.outcome']),
        actorId: String(attrs['clubhouse.audit.actor.id_hash']),
        targets: [...(opts?.detailIds?.targets ?? [])],
        ...(d.requested !== undefined && { requested: d.requested as Record<string, unknown> }),
        ...(d.before !== undefined && { before: d.before as Record<string, Value> }),
        ...(d.after !== undefined && { after: d.after as Record<string, Value> }),
        ...(typeof d.code === 'string' && { code: d.code }),
      };
    }),
    clear: () => { events.length = 0; },
    stop: () => setLocalSink(null),
  };
}
