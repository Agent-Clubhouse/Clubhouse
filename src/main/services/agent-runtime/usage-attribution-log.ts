/**
 * Who used which tokens: one local log line per finished chat turn, for every
 * agent (normal agents, orchestrators, helpers, quick agents and the
 * Dispatcher), with its provider, model, effort, session, role and parent.
 *
 * Lines go through appLog (`core:usage`), so the logging settings decide
 * whether they are written, at what level, and how long they are kept; the
 * diag tier is local-only and never exported. Nothing here touches telemetry
 * consent or export.
 *
 * Counting rules come from RunUsageTracker (telemetry/helper-usage-accounting.ts):
 * - A turn line carries that turn's own figures, never a running total, so
 *   summing turn lines can't count a resumed session's earlier use or a
 *   cumulative figure twice. A repeated turn id is logged once.
 * - A figure the provider did not report is absent; `completeness` says so.
 * - `source` says who did the arithmetic (provider turn, summed calls, or our
 *   difference of Codex running totals); `scope` keeps main vs inclusive.
 * - When a session ends, its running totals are logged as `final` lines with
 *   a `baseline` (`lifetime` for a resumed session). They are a cross-check,
 *   not more use: never add them to the turn lines.
 *
 * Role and parent come from the last read of the agent's config. An agent
 * that read doesn't know yet is `unknown`, with no parent, and is looked up
 * again on its next line. An agent running in a
 * terminal publishes no chat events, so it logs nothing here.
 *
 * No message text, tool input or output, prompt or credential is read.
 */
import type { ChatEvent } from '../../../shared/chat';
import type { ChatDriverId } from '../../../shared/chat/capabilities';
import { RunUsageTracker, type UsageSample } from '../../telemetry/helper-usage-accounting';
import { appLog } from '../log-service';
import { knownAgent } from '../app-event-sources';
import { isDispatcherIdentityAgentId } from '../dispatcher/dispatcher-service';
import { onChatEvent } from './chat-event-bus';

export const USAGE_LOG_NS = 'core:usage';

/** Lines written per hour, across every agent. Past it, lines are counted and the count logged when the hour turns. */
export const USAGE_LOG_MAX_LINES_PER_HOUR = 2000;

export type UsageRole = 'dispatcher' | 'helper' | 'orchestrator' | 'quick' | 'agent' | 'unknown';

export interface UsageAgentInfo {
  role: UsageRole;
  parentAgentId?: string;
  projectPath?: string;
}

interface Deps {
  agentInfo(agentId: string): UsageAgentInfo;
  log(msg: string, meta: Record<string, unknown>): void;
  now(): number;
}

interface SessionState {
  agentId: string;
  sessionId: string;
  driver: ChatDriverId;
  provider: string;
  resumed: boolean;
  nativeSessionId?: string;
  model?: string;
  effort?: string;
  info: UsageAgentInfo;
  tracker: RunUsageTracker;
}

let deps: Deps | null = null;
const sessions = new Map<string, SessionState>();
let hourStart = 0;
let linesThisHour = 0;
let dropped = 0;
let stopListening: (() => void) | null = null;

function now(): number {
  return deps?.now() ?? Date.now();
}

function write(msg: string, meta: Record<string, unknown>): void {
  const t = now();
  if (t - hourStart >= 60 * 60_000) {
    if (dropped > 0) emit('Usage lines dropped over the hourly limit', { dropped, limit: USAGE_LOG_MAX_LINES_PER_HOUR });
    hourStart = t;
    linesThisHour = 0;
    dropped = 0;
  }
  if (linesThisHour >= USAGE_LOG_MAX_LINES_PER_HOUR) {
    dropped++;
    return;
  }
  linesThisHour++;
  emit(msg, meta);
}

function emit(msg: string, meta: Record<string, unknown>): void {
  if (deps) deps.log(msg, meta);
  else appLog(USAGE_LOG_NS, 'info', msg, { meta });
}

function agentInfo(agentId: string): UsageAgentInfo {
  if (deps) return deps.agentInfo(agentId);
  if (isDispatcherIdentityAgentId(agentId)) return { role: 'dispatcher' };
  const known = knownAgent(agentId);
  if (!known) return { role: 'unknown' };
  const role: UsageRole = known.quick ? 'quick' : known.parentAgentId ? 'helper' : known.orchestrates ? 'orchestrator' : 'agent';
  return { role, ...(known.parentAgentId && { parentAgentId: known.parentAgentId }), projectPath: known.projectPath };
}

function who(s: SessionState): Record<string, unknown> {
  // The agent registry fills in after startup, and a new helper's config is read a moment after it starts.
  if (s.info.role === 'unknown') s.info = agentInfo(s.agentId);
  return {
    agentId: s.agentId,
    role: s.info.role,
    ...(s.info.parentAgentId && { parentAgentId: s.info.parentAgentId }),
    ...(s.info.projectPath && { projectPath: s.info.projectPath }),
    sessionId: s.sessionId,
    ...(s.nativeSessionId && { nativeSessionId: s.nativeSessionId }),
    resumed: s.resumed,
    driver: s.driver,
    provider: s.provider,
    model: s.model ?? 'unknown',
    effort: s.effort ?? 'unknown',
  };
}

/** Figures flat and numeric: a nested `tokens` object would read as a secret to diag redaction. */
function sampleMeta(sample: UsageSample): Record<string, unknown> {
  return {
    kind: sample.kind,
    source: sample.source,
    dedup: sample.dedup,
    scope: sample.scope,
    completeness: sample.completeness,
    ...sample.figures,
    ...(sample.turnIndex !== undefined && { turnIndex: sample.turnIndex }),
    ...(sample.durationMs !== undefined && { durationMs: sample.durationMs }),
    ...(sample.baseline && { baseline: sample.baseline }),
    ...(sample.reset && { reset: true }),
    ...(sample.subagentExcluded && { subagentExcluded: true }),
  };
}

/** Count one chat event. Exported for tests; startUsageAttributionLog feeds it. */
export function logUsageChatEvent(event: ChatEvent): void {
  const key = `${event.agentId}\u0000${event.sessionId}`;
  if (event.type === 'session_started') {
    if (sessions.has(key)) return;
    const d = event.data;
    const s: SessionState = {
      agentId: event.agentId,
      sessionId: event.sessionId,
      driver: d.driver,
      provider: d.provider,
      resumed: d.resumed === true,
      ...(d.nativeSessionId && { nativeSessionId: d.nativeSessionId }),
      ...(d.model && { model: d.model }),
      info: agentInfo(event.agentId),
      // No sample cap of its own: an orchestrator's session can run for days. The hourly line limit bounds writes.
      tracker: new RunUsageTracker(d.driver, Number.MAX_SAFE_INTEGER, d.resumed === true),
    };
    sessions.set(key, s);
    write('Usage session started', who(s));
    return;
  }
  const s = sessions.get(key);
  if (!s) return;
  switch (event.type) {
    case 'session_info':
      if (event.data.nativeSessionId) s.nativeSessionId = event.data.nativeSessionId;
      if (event.data.model) s.model = event.data.model;
      return;
    case 'model_changed':
      // Each change carries the whole state: no effort means the model has none. Except a Codex
      // server reroute (model/rerouted), which names only the model; the driver keeps sending its effort.
      // Known gap: a Codex switch to a model with no effort levels looks the same and keeps the old effort.
      s.model = event.data.modelId;
      s.effort = event.data.effort ?? (s.driver === 'codex_app_server' ? s.effort : undefined);
      return;
    case 'turn_started':
      s.tracker.turnStarted(event.turnId, event.ts);
      return;
    case 'usage':
      s.tracker.usage(event.data, event.turnId);
      return;
    case 'subagent':
      s.tracker.subagentDeclared(event.data.subagentId);
      return;
    case 'turn_ended': {
      const sample = s.tracker.turnEnded(event.turnId, event.data, event.ts);
      if (sample) write('Usage turn', { ...who(s), ...(event.turnId && { turnId: event.turnId }), stopReason: event.data.stopReason, ...sampleMeta(sample) });
      return;
    }
    case 'session_ended': {
      sessions.delete(key);
      if (event.data.reason === 'fallback') return;
      for (const sample of s.tracker.finalSamples(event.ts)) write('Usage session total', { ...who(s), ...sampleMeta(sample) });
      return;
    }
    default:
      return;
  }
}

/** Start logging. Idempotent. */
export function startUsageAttributionLog(): void {
  if (stopListening) return;
  stopListening = onChatEvent(logUsageChatEvent);
}

/** For tests: the agent lookup, where lines go, and the clock. */
export function _setUsageAttributionDepsForTesting(next: Deps | null): void {
  deps = next;
}

export function _resetUsageAttributionForTesting(): void {
  stopListening?.();
  stopListening = null;
  sessions.clear();
  hourStart = 0;
  linesThisHour = 0;
  dropped = 0;
  deps = null;
}
