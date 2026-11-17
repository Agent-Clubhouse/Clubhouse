/** Desktop-only controller conversation reads. Never invoked by a phone route or command. */
import type { ChatEvent, ToolCallContent } from '../../shared/chat';
import { formatAgentAddress } from '../../shared/agent-address';
import { CONTROLLER_CHAT_MAX_BYTES, type ControllerChatPage } from '../../shared/controller-chat';
import { isSecretKey, redactSecretValues, REDACTED } from '../telemetry/diag-redaction';
import { getDispatcherAgentId } from './dispatcher/dispatcher-service';
import { remoteFederationController } from './dispatcher-federation';
import { isNetworkComputer } from './annex-agent-calls';
import { decideGrant } from './clubhouse-mcp/grant-check';
import { getAgentRuntime } from './agent-runtime';
import { listChatSessions, readChatTranscript } from './agent-runtime/chat-transcript';
import { remoteChatEvent } from './annex-chat-echo';

/** Credentials are scrubbed on the receiving host, before serialization, without cutting chat text. */
export function redactControllerChat<T>(value: T): T {
  if (typeof value === 'string') return redactSecretValues(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactControllerChat(v)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [
    redactSecretValues(key), isSecretKey(key) && typeof v !== 'number' ? REDACTED : redactControllerChat(v),
  ])) as T;
  return value;
}

/** Same host-side read grant as federated configuration reads; Ask first grants do not authorize reads. */
export function controllerChatAllowed(machine: string): boolean {
  if (!isNetworkComputer(machine)) return false;
  const caller = remoteFederationController(machine);
  const target = getDispatcherAgentId();
  if (!caller?.enabled || !target) return false;
  return decideGrant(formatAgentAddress({ agentId: caller.agentId, machine }), 'agent.read', {
    kind: 'agent', agentId: target,
  }, true).outcome === 'allow';
}

export interface ControllerChatResponse { status: number; body: unknown }

/** Fold streamed text before redacting: a credential can straddle two provider chunks.
 * Replacement events use the normal chat protocol, retain their seq, and also make a
 * page starting midway through a message/tool output meaningful to the desktop reader. */
function controllerEventProjection(events: ChatEvent[], wanted: ReadonlySet<number>): Map<number, ChatEvent> {
  const text = new Map<string, string>();
  const tools = new Map<string, ToolCallContent[]>();
  const out = new Map<number, ChatEvent>();
  for (const event of events) {
    let projected = event;
    if (event.type === 'agent_message_chunk' || event.type === 'agent_thought_chunk'
      || event.type === 'agent_message' || event.type === 'agent_thought') {
      const thought = event.type === 'agent_thought_chunk' || event.type === 'agent_thought';
      const key = `${thought}:${event.data.messageId}`;
      const chunk = event.type.endsWith('_chunk');
      const whole = (chunk ? text.get(key) ?? '' : '') + event.data.text;
      text.set(key, whole);
      projected = { ...event, type: thought ? 'agent_thought' : 'agent_message', data: { ...event.data, text: whole } } as ChatEvent;
    } else if (event.type === 'tool_call' || event.type === 'tool_call_update') {
      const previous = tools.get(event.data.toolCallId) ?? [];
      const content = event.type === 'tool_call_update' && event.data.contentMode === 'append'
        ? [...previous, ...(event.data.content ?? [])] : event.data.content ?? previous;
      const merged: ToolCallContent[] = [];
      for (const block of content) {
        const last = merged[merged.length - 1];
        if (last?.type === 'text' && block.type === 'text') merged[merged.length - 1] = { ...last, text: last.text + block.text };
        else if (last?.type === 'terminal' && block.type === 'terminal'
          && (block.command === undefined || block.command === last.command)
          && (block.cwd === undefined || block.cwd === last.cwd)) merged[merged.length - 1] = { ...last, ...block, output: last.output + block.output };
        else merged.push(block);
      }
      tools.set(event.data.toolCallId, merged);
      projected = { ...event, data: { ...event.data, content: merged, ...(event.type === 'tool_call_update' && { contentMode: 'replace' }) } } as ChatEvent;
    }
    if (wanted.has(event.seq)) out.set(event.seq, projected);
  }
  return out;
}

/** The adapter supplies a pinned, active desktop membership check, rechecked with the grant after IO. */
export async function readControllerChat(machine: string, query: URLSearchParams, sessions: boolean, authorized: () => boolean): Promise<ControllerChatResponse> {
  const agentId = getDispatcherAgentId();
  const allowed = () => authorized() && getDispatcherAgentId() === agentId && controllerChatAllowed(machine);
  const denied = { status: 403, body: { error: 'agent_read_required' } };
  if (!allowed()) return denied;
  try {
    if (sessions) {
      const list = agentId ? await listChatSessions(agentId) : [];
      const body = redactControllerChat({ sessions: list });
      if (!allowed()) return denied;
      return Buffer.byteLength(JSON.stringify(body)) <= CONTROLLER_CHAT_MAX_BYTES
        ? { status: 200, body } : { status: 413, body: { error: 'session_index_too_large' } };
    }
    const sessionId = query.get('sessionId') ?? undefined;
    const before = query.has('beforeSeq') ? Number(query.get('beforeSeq')) : undefined;
    const after = query.has('afterSeq') ? Number(query.get('afterSeq')) : undefined;
    const limit = query.has('limit') ? Number(query.get('limit')) : 500;
    if ([...query.keys()].some((key) => !['sessionId', 'beforeSeq', 'afterSeq', 'limit'].includes(key) || query.getAll(key).length !== 1)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000
      || before !== undefined && (!Number.isSafeInteger(before) || before < 1)
      || after !== undefined && (!Number.isSafeInteger(after) || after < 0)
      || before !== undefined && after !== undefined
      || sessionId !== undefined && (!sessionId || sessionId.length > 256)) return { status: 400, body: { error: 'invalid_query' } };
    const runtime = agentId ? getAgentRuntime(agentId) : undefined;
    const live = runtime?.kind === 'chat' && runtime.isRunning();
    const currentSessionId = live ? runtime.getSessionId?.() ?? null : null;
    const events = agentId ? (live && (sessionId === undefined || sessionId === currentSessionId)
      ? (await runtime.readTranscript()).events ?? [] : await readChatTranscript(agentId, { sessionId })) : [];
    const selected = sessionId ?? currentSessionId ?? events[events.length - 1]?.sessionId ?? null;
    const current = events.filter((e) => e.sessionId === selected).sort((a, b) => a.seq - b.seq);
    const eligible = current.filter((e) => (before === undefined || e.seq < before) && (after === undefined || e.seq > after));
    // Like the Annex chat page, initial/history reads walk back from the tail. Live catch-up walks
    // forward so a burst larger than a page cannot silently skip events. Events are never summarized.
    const candidates = after === undefined ? [...eligible].reverse() : eligible;
    const batch = candidates.slice(0, limit);
    const projections = controllerEventProjection(current, new Set(batch.map((e) => e.seq)));
    const page: ChatEvent[] = [];
    let bytes = 4096; // envelope room
    for (const event of batch) {
      const projected = redactControllerChat(remoteChatEvent(projections.get(event.seq)!));
      const size = Buffer.byteLength(JSON.stringify(projected)) + 1;
      if (bytes + size > CONTROLLER_CHAT_MAX_BYTES) {
        if (!page.length) return { status: 413, body: { error: 'event_too_large' } };
        break;
      }
      bytes += size;
      page.push(projected);
    }
    page.sort((a, b) => a.seq - b.seq);
    const first = page[0]?.seq;
    const last = page[page.length - 1]?.seq;
    const body: ControllerChatPage = {
      version: 1, agentId, sessionId: selected, currentSessionId, events: page, readOnly: true,
      lastSeq: current[current.length - 1]?.seq ?? 0,
      nextBeforeSeq: first !== undefined && eligible.some((e) => e.seq < first) ? first : null,
      nextAfterSeq: last !== undefined && eligible.some((e) => e.seq > last) ? last : null,
    };
    return allowed() ? { status: 200, body } : denied;
  } catch {
    // telemetry-exempt: neither transcript content nor filesystem errors leave in logs.
    return { status: 500, body: { error: 'controller_chat_failed' } };
  }
}
