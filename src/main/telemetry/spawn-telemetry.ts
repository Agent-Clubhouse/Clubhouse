/**
 * Agent spawn, create and delete helpers (spec §4.4, Phase 4b). The spans
 * themselves are tel.flow / tel.step calls at the call sites; this file holds
 * the facts a spawn collects along the way and the metrics recorded at its end.
 *
 * No OpenTelemetry imports: part of the main bundle.
 */
import { ATTR, ERROR_TYPES, type TelAttr } from '../../shared/telemetry/attributes';
import type { ChatDriverAttempt, ChatStartFacts, ChatStartResult } from '../services/agent-runtime/chat-spawn';
import { replaySpan, tel } from './facade';
import { errorTypeOf, type ErrorType } from './types';

type Kind = Parameters<typeof ATTR.agentKind>[0];
type Runtime = Parameters<typeof ATTR.agentRuntime>[0];
type Orchestrator = Parameters<typeof ATTR.orchestrator>[0];

/** What a spawn learned on its way, set as it goes and attached to the span at the end. */
export interface SpawnFacts {
  orchestrator?: string;
  /** Unset until the spawn picks a runtime; omitted from attributes until then. */
  runtime?: Runtime;
  clubhouseMode?: boolean;
  mcpEnabled?: boolean;
  hooksEnabled?: boolean;
  profileActive?: boolean;
  wrapperApplied?: boolean;
  model?: string;
  /** Headless only: the process never got a PID. */
  noPid?: boolean;
}

export function orchestratorAttr(id: string | undefined): Orchestrator {
  return id === 'claude-code' || id === 'codex-cli' || id === 'copilot-cli' ? id : 'other';
}

/** Bucket a model string. The raw value is never sent. */
export function modelFamily(model: string | undefined): Parameters<typeof ATTR.modelFamily>[0] {
  if (!model || model === 'default') return 'default';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.startsWith('gpt-5')) return 'gpt-5';
  return 'other';
}

export function spawnAttrs(f: SpawnFacts): TelAttr[] {
  const attrs: TelAttr[] = [ATTR.orchestrator(orchestratorAttr(f.orchestrator)), ATTR.modelFamily(modelFamily(f.model))];
  if (f.runtime) attrs.push(ATTR.agentRuntime(f.runtime));
  if (f.clubhouseMode !== undefined) attrs.push(ATTR.clubhouseMode(f.clubhouseMode));
  if (f.mcpEnabled !== undefined) attrs.push(ATTR.mcpEnabled(f.mcpEnabled));
  if (f.hooksEnabled !== undefined) attrs.push(ATTR.hooksEnabled(f.hooksEnabled));
  if (f.profileActive !== undefined) attrs.push(ATTR.profileActive(f.profileActive));
  if (f.wrapperApplied !== undefined) attrs.push(ATTR.wrapperApplied(f.wrapperApplied));
  return attrs;
}

/** How a chat start ended, as the caller saw it: `failed` when it threw. */
export type ChatStartEnd = ChatStartResult | 'failed';

const ERROR_TYPE_SET: ReadonlySet<string> = new Set(ERROR_TYPES);

/** A bounded error code from chat, kept only when it is a registered `error.type`. */
function chatErrorType(code: string | undefined): ErrorType | undefined {
  return code !== undefined && ERROR_TYPE_SET.has(code) ? (code as ErrorType) : undefined;
}

/** A duration attribute: whole, non-negative milliseconds. */
function ms(value: number): number {
  return Math.max(0, Math.round(value));
}

function attemptAttrs(a: ChatDriverAttempt): TelAttr[] {
  const attrs: TelAttr[] = [ATTR.chatDriver(a.driver), ATTR.chatCheckMs(ms(a.checkMs))];
  if (a.reason) attrs.push(ATTR.chatStartReason(a.reason));
  const errorType = chatErrorType(a.errorCode);
  if (errorType) attrs.push(ATTR.errorType(errorType));
  if (a.versionStatus) attrs.push(ATTR.chatCliVersionStatus(a.versionStatus));
  if (a.sessionStartMs !== undefined) attrs.push(ATTR.chatSessionStartMs(ms(a.sessionStartMs)));
  return attrs;
}

/**
 * Record a chat start (#2304). Each driver it left is a
 * `clubhouse.chat.fallback` event, as is going to the terminal before any
 * driver was checked (no driver, binary missing). A start that really began
 * (`startMs` set, from `tryStartChatAgent`'s `onStarting`) is also a
 * `clubhouse.chat.start` span, replayed as a child of the spawn, carrying the
 * result, the reason, the driver it ended on and the timings. Spawns that were
 * never chat record nothing. Closed enums, numbers and bools only.
 */
export function recordChatStart(
  startMs: number | undefined,
  end: ChatStartEnd,
  facts: ChatStartFacts,
  context: { orchestrator: string | undefined; resume: boolean },
  atMs = Date.now(),
): void {
  const orchestrator = ATTR.orchestrator(orchestratorAttr(context.orchestrator));
  const { attempts } = facts;

  if (attempts.length === 0 && end === 'terminal' && facts.reason) {
    tel.event('clubhouse.chat.fallback', [
      orchestrator,
      ATTR.chatFallbackTo('terminal'),
      ATTR.chatStartReason(facts.reason),
      ...(facts.preferredDriver ? [ATTR.chatDriver(facts.preferredDriver)] : []),
      ...(facts.reason === 'binary_missing' ? [ATTR.errorType('binary_not_found')] : []),
    ]);
  }
  attempts.forEach((a, i) => {
    if (!a.reason) return;
    const last = i === attempts.length - 1;
    tel.event('clubhouse.chat.fallback', [
      orchestrator,
      // The last driver left goes to the terminal, unless the start was cancelled.
      ATTR.chatFallbackTo(last && end !== 'cancelled' ? 'terminal' : 'driver'),
      ...attemptAttrs(a),
    ]);
  });

  if (startMs === undefined) return;
  const final = attempts[attempts.length - 1] as ChatDriverAttempt | undefined;
  const result = end === 'chat' && attempts.length > 1 ? 'fallback' : end;
  const attrs: TelAttr[] = [
    orchestrator,
    ATTR.chatStartResult(result),
    ATTR.chatDriversTried(attempts.length),
    ATTR.chatCheckMs(Math.max(0, Math.round(attempts.reduce((sum, a) => sum + a.checkMs, 0)))),
    ATTR.agentResume(context.resume),
  ];
  if (final) {
    attrs.push(ATTR.chatDriver(final.driver));
    if (final.versionStatus) attrs.push(ATTR.chatCliVersionStatus(final.versionStatus));
    if (final.sessionStartMs !== undefined) attrs.push(ATTR.chatSessionStartMs(ms(final.sessionStartMs)));
  }
  if (facts.reason && end !== 'chat') attrs.push(ATTR.chatStartReason(facts.reason));
  if (facts.resumeHonored !== undefined) attrs.push(ATTR.chatResumeHonored(facts.resumeHonored));
  if (facts.resumeTiming) {
    attrs.push(ATTR.chatResumeLoadMs(ms(facts.resumeTiming.loadMs)));
    if (facts.resumeTiming.firstReplyMs !== undefined) {
      attrs.push(ATTR.chatResumeFirstReplyMs(ms(facts.resumeTiming.firstReplyMs)));
    }
  }
  const ok = end === 'chat';
  replaySpan({
    name: 'clubhouse.chat.start',
    startMs,
    endMs: Math.max(atMs, startMs),
    attrs,
    outcome: ok ? 'ok' : end === 'cancelled' ? 'cancelled' : 'error',
    errorType: ok || end === 'cancelled' ? undefined : 'chat_start_failed',
  });
}

/** Count one spawn attempt; on success also its duration. */
export function recordSpawn(kind: Kind, f: SpawnFacts, startMs: number, error: unknown, atMs = Date.now()): void {
  const dims = [ATTR.agentKind(kind), ATTR.orchestrator(orchestratorAttr(f.orchestrator))];
  if (f.runtime) dims.push(ATTR.agentRuntime(f.runtime));
  const failed = error !== undefined || f.noPid === true;
  const errorType = error !== undefined ? errorTypeOf(error) : f.noPid ? 'headless_no_pid' : undefined;
  tel.count('clubhouse.agent.spawns', 1, [
    ...dims,
    ATTR.outcome(failed ? 'error' : 'ok'),
    ...(errorType ? [ATTR.errorType(errorType)] : []),
  ]);
  if (!failed) tel.count('clubhouse.agent.spawn.duration', (atMs - startMs) / 1000, dims);
}
