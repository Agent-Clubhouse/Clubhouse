/**
 * Session-id capture and resume outcomes for durable agents (#2305): the
 * signals that show a made-up id being saved and resumed in a loop (#2086)
 * or a resume that stalls into a fresh session (#2296). Only enums, the exit
 * code and the hashed agent id are recorded; the session id never is (the
 * local diag line next to each call keeps it for local cross-reference).
 * Imports only the facade, like agent-signals.
 */
import { ATTR, type TelAttr } from '../../shared/telemetry/attributes';
import { isTelemetryActive, tel } from './facade';

type Orchestrator = Parameters<typeof ATTR.orchestrator>[0];
type Runtime = Parameters<typeof ATTR.agentRuntime>[0];
export type SessionCaptureResult = Parameters<typeof ATTR.sessionCaptureResult>[0];
export type SessionCaptureSource = Parameters<typeof ATTR.sessionCaptureSource>[0];
export type SessionStaleReason = Parameters<typeof ATTR.sessionStaleReason>[0];
export type SessionResumeResult = Parameters<typeof ATTR.sessionResumeResult>[0];

function orchestratorOf(id: string | undefined): Orchestrator {
  return id === 'claude-code' || id === 'codex-cli' || id === 'copilot-cli' ? id : 'other';
}

function base(orchestratorId: string | undefined, agentId: string): TelAttr[] {
  return [ATTR.orchestrator(orchestratorOf(orchestratorId)), ATTR.agentIdHash(agentId)];
}

/** A durable run ended: what happened to its session id, and where the saved one came from. */
export function recordSessionCapture(opts: {
  orchestrator: string | undefined;
  agentId: string;
  runtime: Runtime;
  result: SessionCaptureResult;
  source: SessionCaptureSource;
  exitCode?: number;
}): void {
  if (!isTelemetryActive()) return;
  tel.event('clubhouse.agent.session_capture', [
    ...base(opts.orchestrator, opts.agentId),
    ATTR.agentRuntime(opts.runtime),
    ATTR.sessionCaptureResult(opts.result),
    ATTR.sessionCaptureSource(opts.source),
    ...(opts.exitCode === undefined ? [] : [ATTR.exitCode(opts.exitCode)]),
  ]);
}

/** A saved resume id was cleared because its session is gone (#2113). */
export function recordStaleSessionCleared(orchestrator: string | undefined, agentId: string, reason: SessionStaleReason): void {
  if (!isTelemetryActive()) return;
  tel.event('clubhouse.agent.session_stale_cleared', [...base(orchestrator, agentId), ATTR.sessionStaleReason(reason)]);
}

/** How a durable wake's resume went. `runtime` is omitted when the wake hasn't picked one yet. */
export function recordResumeOutcome(orchestrator: string | undefined, agentId: string, result: SessionResumeResult, runtime?: Runtime): void {
  if (!isTelemetryActive()) return;
  tel.event('clubhouse.agent.resume_outcome', [
    ...base(orchestrator, agentId),
    ...(runtime ? [ATTR.agentRuntime(runtime)] : []),
    ATTR.sessionResumeResult(result),
  ]);
}

/**
 * The resume outcome of a chat session open. `fallback` is the driver's
 * reason for starting fresh, when it gave one; otherwise a different native
 * id than the one asked for is a fresh start for an unknown reason.
 */
export function chatResumeResult(
  requestedId: string,
  nativeSessionId: string | undefined,
  fallback: 'not_found' | 'stalled' | undefined,
): SessionResumeResult {
  if (fallback === 'stalled') return 'fresh_stalled';
  if (fallback === 'not_found') return 'fresh_not_found';
  // Undefined: the driver learns its id later (Claude's init comes after the first prompt).
  return nativeSessionId === undefined || nativeSessionId === requestedId ? 'resumed' : 'fresh_other';
}
