/**
 * Chat telemetry (telemetry spec §4.4 "Chat turns", §9.1; research §8.1).
 *
 * Telemetry subscribes once to the chat event bus. Chat imports nothing from
 * telemetry; this module maps the normalized ChatEvents it already publishes:
 *
 * - turn_started → turn_ended: one `clubhouse.agent.turn` span (replayed with
 *   explicit times), `clubhouse.agent.turn.duration`, time to first token,
 *   tokens and cost;
 * - tool_call → its completing tool_call_update: `clubhouse.agent.tool_calls`;
 * - permission_request → permission_resolved: `clubhouse.agent.permission`
 *   with `clubhouse.permission.path=chat`, and the wait histogram;
 * - protocol_unknown: `clubhouse.chat.protocol.unknown` (CLI drift, §12 H2);
 * - a turn with no event for five minutes, while not waiting on the user:
 *   `clubhouse.agent.turn.stalled`;
 * - session_started opens a `chat` agent run that the exit broadcast closes,
 *   and the first streamed text is the run's first output.
 *
 * Privacy: only closed enums and numbers leave this module. Message text,
 * thoughts, tool inputs and outputs, titles, paths and native ids are never
 * read into an attribute; tool names go through the built-in bucket list.
 *
 * Cost when telemetry is off: one function call and a branch per event.
 */
import type { ChatDriverId, ChatEvent, ChatEventDataMap, TokenUsage } from '../../shared/chat';
import { ATTR, type TelAttr } from '../../shared/telemetry/attributes';
import { onChatEvent } from '../services/agent-runtime/chat-event-bus';
import { agentOutput, agentRunStarted, discardRun, hasActiveRun, toolBucket } from './agent-telemetry';
import { isTelemetryActive, replaySpan, tel } from './facade';
import type { ErrorType } from './types';

type Orchestrator = Parameters<typeof ATTR.orchestrator>[0];
type EndReason = Parameters<typeof ATTR.turnEndReason>[0];
type StopReason = ChatEventDataMap['turn_ended']['stopReason'];

/** A turn with no event for this long, while not waiting on the user, is stalled (spec §12 H2). */
export const TURN_STALL_MS = 5 * 60_000;
const STALL_SCAN_MS = 60_000;

interface Session {
  agentId: string;
  driver: ChatDriverId;
  orchestrator: Orchestrator;
}

interface Turn {
  turnId: string | undefined;
  startMs: number;
  lastEventMs: number;
  firstTokenMs?: number;
  /** Tool call ids seen this turn; dropped with the turn. */
  toolIds: Set<string>;
  tokens?: TokenUsage;
  costUsd?: number;
  costIsEstimate?: boolean;
  errorCode?: ErrorType;
  /** Waiting on a permission answer or a question: not a stall. */
  waiting: boolean;
  stalled: boolean;
}

interface Tool {
  toolName: string | undefined;
}

const sessions = new Map<string, Session>();
const turns = new Map<string, Turn>();
/** Tool calls not yet completed, by `${sessionId}:${toolCallId}`. Removed once counted. */
const tools = new Map<string, Tool>();
/** Pending permissions by `${sessionId}:${requestId}`. */
const permissions = new Map<string, { startMs: number; toolName: string | undefined }>();
let stallTimer: ReturnType<typeof setInterval> | null = null;

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorType>([
  'max_tokens', 'refusal', 'rpc_timeout', 'process_exited', 'spawn_failed', 'unhandled_server_request',
  'protocol_error', 'driver_stream_failed', 'auth_required', 'rate_limited', 'context_overflow', 'tool_failed',
  'timeout', 'unknown',
]);

function orchestratorOf(provider: string): Orchestrator {
  return provider === 'claude-code' || provider === 'codex-cli' || provider === 'copilot-cli' ? provider : 'other';
}

/** turn_ended stop reasons onto the spec's end reasons; anything that isn't a clean end, a cancel or a timeout is an error. */
export function endReasonFor(stop: StopReason): EndReason {
  if (stop === 'end_turn') return 'complete';
  if (stop === 'cancelled') return 'cancelled';
  if (stop === 'timeout') return 'timeout';
  return 'error';
}

/** The error.type for a failed turn: the stop reason when it is one, else the last chat error seen in the turn. */
function errorTypeFor(stop: StopReason, turn: Turn): ErrorType {
  if (stop === 'max_tokens' || stop === 'refusal') return stop;
  if (stop === 'timeout') return 'timeout';
  return turn.errorCode ?? 'unknown';
}

function scanStalls(now = Date.now()): void {
  for (const [sessionId, turn] of turns) {
    if (turn.waiting || turn.stalled || now - turn.lastEventMs < TURN_STALL_MS) continue;
    const session = sessions.get(sessionId);
    if (!session) continue;
    turn.stalled = true;
    tel.count('clubhouse.agent.turn.stalled', 1, [ATTR.chatDriver(session.driver)]);
  }
}

function ensureStallTimer(): void {
  if (stallTimer || turns.size === 0) return;
  stallTimer = setInterval(() => {
    if (turns.size === 0) { stopStallTimer(); return; }
    scanStalls();
  }, STALL_SCAN_MS);
  stallTimer.unref?.();
}

function stopStallTimer(): void {
  if (stallTimer) clearInterval(stallTimer);
  stallTimer = null;
}

function reset(): void {
  sessions.clear();
  turns.clear();
  tools.clear();
  permissions.clear();
  stopStallTimer();
}

function dropSession(sessionId: string): void {
  sessions.delete(sessionId);
  turns.delete(sessionId);
  const prefix = `${sessionId}:`;
  for (const key of tools.keys()) if (key.startsWith(prefix)) tools.delete(key);
  for (const key of permissions.keys()) if (key.startsWith(prefix)) permissions.delete(key);
}

function endTurn(session: Session, turn: Turn, data: ChatEventDataMap['turn_ended'], atMs: number): void {
  const reason = endReasonFor(data.stopReason);
  const durationMs = data.durationMs ?? atMs - turn.startMs;
  const tokens = data.usage ?? turn.tokens;
  const costUsd = data.costUsd ?? turn.costUsd;
  const driver = ATTR.chatDriver(session.driver);
  const orchestrator = ATTR.orchestrator(session.orchestrator);

  const attrs: TelAttr[] = [driver, orchestrator, ATTR.turnEndReason(reason), ATTR.turnToolCalls(turn.toolIds.size)];
  if (turn.firstTokenMs !== undefined) attrs.push(ATTR.turnTimeToFirstTokenMs(turn.firstTokenMs - turn.startMs));
  if (tokens?.input !== undefined) attrs.push(ATTR.genAiInputTokens(tokens.input));
  if (tokens?.output !== undefined) attrs.push(ATTR.genAiOutputTokens(tokens.output));
  const errorType = reason === 'error' ? errorTypeFor(data.stopReason, turn) : undefined;
  replaySpan({
    name: 'clubhouse.agent.turn',
    startMs: atMs - durationMs,
    endMs: atMs,
    attrs,
    outcome: reason === 'complete' ? 'ok' : reason,
    ...(errorType && { errorType }),
  });

  tel.count('clubhouse.agent.turn.duration', durationMs / 1000, [driver, orchestrator, ATTR.turnEndReason(reason)]);
  if (turn.firstTokenMs !== undefined) {
    tel.count('clubhouse.agent.turn.time_to_first_token', (turn.firstTokenMs - turn.startMs) / 1000, [driver]);
  }
  if (tokens?.input) tel.count('clubhouse.agent.tokens', tokens.input, [driver, orchestrator, ATTR.genAiTokenType('input')]);
  if (tokens?.output) tel.count('clubhouse.agent.tokens', tokens.output, [driver, orchestrator, ATTR.genAiTokenType('output')]);
  if (costUsd !== undefined && costUsd > 0) {
    tel.count('clubhouse.agent.cost', costUsd, [driver, orchestrator, ATTR.costEstimate(turn.costIsEstimate === true)]);
  }
}

/** Fold one chat event into telemetry. Exported for tests; the bus calls it via installChatTelemetry. */
export function handleChatEvent(event: ChatEvent): void {
  if (!isTelemetryActive()) {
    if (sessions.size > 0 || turns.size > 0) reset();
    return;
  }
  const sid = event.sessionId;

  if (event.type === 'session_started') {
    const d = event.data;
    sessions.set(sid, { agentId: event.agentId, driver: d.driver, orchestrator: orchestratorOf(d.provider) });
    // One run per process: a context clear starts a new chat session on the same run.
    if (!hasActiveRun(event.agentId)) agentRunStarted(event.agentId, 'chat', event.ts);
    return;
  }

  // Sessions that started before telemetry was on have no known driver; skip them.
  const session = sessions.get(sid);
  if (!session) return;
  const turn = turns.get(sid);
  if (turn) {
    turn.lastEventMs = event.ts;
  }

  switch (event.type) {
    case 'session_state': {
      if (turn) turn.waiting = event.data.state === 'waiting_permission' || event.data.state === 'waiting_input';
      return;
    }
    case 'session_ended': {
      const reason = event.data.reason;
      if (reason === 'fallback') {
        // A failed chat start that fell back to the terminal: not a chat run or turn.
        discardRun(session.agentId);
      } else if (turn) {
        // The CLI went away mid-turn (some drivers send no turn_ended then):
        // a stop cancels the turn, anything else fails it.
        if (reason !== 'stopped') turn.errorCode ??= 'process_exited';
        endTurn(session, turn, { stopReason: reason === 'stopped' ? 'cancelled' : 'error' }, event.ts);
      }
      dropSession(sid);
      if (turns.size === 0) stopStallTimer();
      return;
    }

    case 'turn_started':
      turns.set(sid, { turnId: event.turnId, startMs: event.ts, lastEventMs: event.ts, toolIds: new Set(), waiting: false, stalled: false });
      ensureStallTimer();
      return;
    case 'turn_ended': {
      if (turn) endTurn(session, turn, event.data, event.ts);
      turns.delete(sid);
      if (turns.size === 0) stopStallTimer();
      return;
    }

    case 'agent_message_chunk':
    case 'agent_message':
    case 'agent_thought_chunk':
    case 'agent_thought': {
      // The main agent's first streamed text; subagent text doesn't count.
      if (event.data.subagentId) return;
      if (turn && turn.firstTokenMs === undefined) turn.firstTokenMs = event.ts;
      agentOutput(session.agentId, 0, event.ts);
      return;
    }

    case 'tool_call': {
      const key = `${sid}:${event.data.toolCallId}`;
      // A tool_call can repeat (an upsert); count each call once per turn.
      const seen = turn ? turn.toolIds.has(event.data.toolCallId) : false;
      turn?.toolIds.add(event.data.toolCallId);
      if (!seen && !tools.has(key)) tools.set(key, { toolName: event.data.toolName });
      if (event.data.status === 'completed' || event.data.status === 'failed') countTool(session, key, event.data.status);
      return;
    }
    case 'tool_call_update': {
      const status = event.data.status;
      if (status === 'completed' || status === 'failed') countTool(session, `${sid}:${event.data.toolCallId}`, status);
      return;
    }

    case 'permission_request':
      permissions.set(`${sid}:${event.data.requestId}`, { startMs: event.ts, toolName: event.data.toolName });
      return;
    case 'permission_resolved': {
      const key = `${sid}:${event.data.requestId}`;
      const pending = permissions.get(key);
      if (!pending) return;
      permissions.delete(key);
      // The agent withdrew its own request (e.g. the turn moved on): nobody decided anything.
      if (event.data.by === 'agent') return;
      recordChatPermission(session, pending, event.data, event.ts);
      return;
    }

    case 'usage': {
      if (!turn || event.data.scope !== 'turn') return;
      if (event.data.tokens) turn.tokens = event.data.tokens;
      if (event.data.costUsd !== undefined) {
        turn.costUsd = event.data.costUsd;
        turn.costIsEstimate = event.data.costIsEstimate === true;
      }
      return;
    }
    case 'error': {
      if (turn && ERROR_CODES.has(event.data.code)) turn.errorCode = event.data.code as ErrorType;
      return;
    }
    case 'protocol_unknown':
      tel.count('clubhouse.chat.protocol.unknown', 1, [ATTR.chatDriver(session.driver), ATTR.chatProtocolKind(event.data.kind)]);
      return;
    default:
      return;
  }
}

function countTool(session: Session, key: string, status: 'completed' | 'failed'): void {
  const tool = tools.get(key);
  if (!tool) return;
  // Counted once: drop it, so a later update for the same call finds nothing to count.
  tools.delete(key);
  tel.count('clubhouse.agent.tool_calls', 1, [
    ATTR.orchestrator(session.orchestrator),
    ATTR.toolBucket(toolBucket(tool.toolName)),
    ATTR.toolResult(status === 'completed' ? 'ok' : 'error'),
  ]);
}

function recordChatPermission(
  session: Session,
  pending: { startMs: number; toolName: string | undefined },
  data: ChatEventDataMap['permission_resolved'],
  atMs: number,
): void {
  const timedOut = data.by === 'timeout';
  const decision = ATTR.permissionDecision(data.decision === 'allow' ? 'allow' : 'deny');
  const result = ATTR.permissionResult(timedOut ? 'timeout' : 'resolved');
  const path = ATTR.permissionPath('chat');
  replaySpan({
    name: 'clubhouse.agent.permission',
    startMs: pending.startMs,
    endMs: atMs,
    attrs: [
      ATTR.orchestrator(session.orchestrator),
      ATTR.chatDriver(session.driver),
      ATTR.toolBucket(toolBucket(pending.toolName)),
      decision,
      result,
      path,
      ATTR.permissionSource(data.by === 'annex' ? 'annex' : 'desktop'),
    ],
    outcome: timedOut ? 'timeout' : 'ok',
  });
  tel.count('clubhouse.agent.permission.wait', (atMs - pending.startMs) / 1000, [decision, result, path]);
}

// --- Wiring ---------------------------------------------------------------------

let unsubscribe: (() => void) | null = null;

/** Subscribe to the chat event bus. Call once at startup. */
export function installChatTelemetry(): void {
  if (unsubscribe) return;
  unsubscribe = onChatEvent(handleChatEvent);
}

/** Test-only reset. */
export function _resetChatTelemetryForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  reset();
}

/** Test-only: run the stall scan at `now`. */
export function _scanStallsForTests(now: number): void {
  scanStalls(now);
}

/** Test-only: open turn count. */
export function _openTurnsForTests(): number {
  return turns.size;
}
