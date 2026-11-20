import { isChatEvent, type ChatEvent } from '../../../../shared/chat';
import { isRemoteSessionHistoryBinding, sameRemoteSessionHistoryBinding, type RemoteSessionHistoryBinding } from '../../../../shared/remote-session-history';

export const REMOTE_HISTORY_PAGE_LIMIT = 200;
export interface RemoteHistoryPage { events: ChatEvent[]; nextBeforeSeq: number | null; atRunStart: boolean }
/** Archive pages never enter the live chat store. Refuse ambiguous identity/cursors. */
export function remoteSessionHistoryPage(value: unknown, expected: RemoteSessionHistoryBinding, beforeSeq: number): RemoteHistoryPage | null {
  if (!Number.isSafeInteger(beforeSeq) || beforeSeq <= expected.startSeq) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (!isRemoteSessionHistoryBinding(p.historyBinding) || !sameRemoteSessionHistoryBinding(expected, p.historyBinding)
    || p.agentId !== expected.agentId || p.sessionId !== expected.sessionId || p.currentSessionId !== expected.sessionId
    || p.displayRunId !== expected.displayRunId || p.readOnly !== false || typeof p.state !== 'string' || ['sleeping', 'error'].includes(p.state)
    || typeof p.truncated !== 'boolean' || !Array.isArray(p.events) || p.events.length > 2000
    || JSON.stringify(value).length * 4 > 8 * 1024 * 1024) return null;
  const next = p.nextBeforeSeq;
  if (next !== null && (!Number.isSafeInteger(next) || (next as number) < 1 || (next as number) >= beforeSeq)
    || p.truncated !== (next !== null)) return null;
  let previous = 0;
  const events: ChatEvent[] = [];
  for (const event of p.events) {
    if (!isChatEvent(event) || event.agentId !== expected.agentId || event.sessionId !== expected.sessionId
      || !Number.isSafeInteger(event.seq) || event.seq <= previous || event.seq >= beforeSeq || !Number.isFinite(event.ts) || Math.abs(event.ts) > 8.64e15) return null;
    previous = event.seq;
    if (event.seq < expected.startSeq) continue;
    if (event.type === 'session_started' && (event.seq !== expected.startSeq || event.data.provider !== expected.providerId || event.data.driver !== expected.driver
      || event.data.nativeSessionId !== undefined && event.data.nativeSessionId !== expected.nativeSessionId)) return null;
    if (event.type === 'session_info' && event.data.nativeSessionId !== undefined && event.data.nativeSessionId !== expected.nativeSessionId) return null;
    events.push(event);
  }
  const atRunStart = next === null || (next as number) <= expected.startSeq;
  return { events, nextBeforeSeq: atRunStart ? null : next as number, atRunStart };
}
