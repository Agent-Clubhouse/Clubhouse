import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatEvent, ChatSessionSummary } from '../../../shared/chat';
import type { ControllerChatPage, ControllerChatQuery, ControllerReadResult } from '../../../shared/controller-chat';
import { compactControllerEvents } from '../../../shared/controller-chat';
import { DISPATCHER_CONTROLLER_NAME } from '../../../shared/dispatcher-name';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { foldChatEvents } from '../../stores/chatStore';
import { ChatStream } from '../agents/chat/ChatStream';
import { RemoteChatContext } from '../agents/chat/remote-chat';

const READ_MESSAGES = {
  unavailable: 'This conversation is not available on that computer’s version of Clubhouse.',
  offline: 'That computer is offline. Reconnect to read its controller conversation.',
  forbidden: 'That computer does not allow this desktop to read the controller conversation (agent.read).',
  error: 'Could not load the controller conversation.',
};
type Failure = Exclude<ControllerReadResult<unknown>['status'], 'ok' | 'rate_limited'>;

/** A normal desktop chat stream, with full events and lazy history, and no command/action surface. */
export function RemoteControllerChatView({ machine }: { machine: string }) {
  const satellite = useAnnexClientStore((s) => s.satellites.find((sat) => sat.fingerprint.toLowerCase() === machine.toLowerCase()));
  const machineName = satellite?.alias || 'other computer';
  const connection = satellite?.state;
  const [selected, setSelected] = useState(''); // empty follows the current conversation
  const [sessions, setSessions] = useState<ChatSessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState(false);
  const [page, setPage] = useState<ControllerChatPage | null>(null);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(true);
  const [earlierLoading, setEarlierLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const current = useRef<ControllerChatPage | null>(null);
  const historyRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const state = useMemo(() => foldChatEvents(undefined, page?.agentId ?? 'remote-controller', events), [page?.agentId, events]);

  useEffect(() => {
    const token = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSeq = 0;
    let session: string | null = null;
    let idleDelay = 5000;
    const alive = () => generation.current === token;
    setPage(null); current.current = null; setEvents([]); setFailure(null); setLoading(true); setEarlierLoading(false);
    const load = async (initial: boolean) => {
      try {
        const opts: ControllerChatQuery = selected ? { sessionId: selected } : {};
        if (!initial) opts.afterSeq = lastSeq;
        let result = await window.clubhouse.annexClient.controllerChatPage(machine, opts);
        if (!alive()) return;
        // A new current session has its own sequence space. Start at its tail, not the old cursor.
        if (!initial && result.status === 'ok' && result.value.sessionId !== session) {
          result = await window.clubhouse.annexClient.controllerChatPage(machine);
          initial = true;
        }
        if (!alive()) return;
        if (result.status === 'rate_limited') {
          timer = setTimeout(() => { void load(initial); }, result.retryAfterMs);
          return;
        }
        setLoading(false);
        if (result.status !== 'ok') { setFailure(result.status); return; }
        const next = result.value;
        session = next.sessionId;
        lastSeq = next.events[next.events.length - 1]?.seq ?? (initial ? 0 : lastSeq);
        // Polls carry only new events; keep the oldest-history cursor already loaded by the user.
        const mergedPage = initial ? next : { ...next, nextBeforeSeq: current.current?.nextBeforeSeq ?? null };
        current.current = mergedPage;
        setPage(mergedPage);
        setEvents((prev) => mergeControllerEvents(initial ? [] : prev, next.events));
        setFailure(null);
        // Archives stay still. Current conversations catch up one bounded page at a time.
        idleDelay = !initial && next.events.length === 0 ? Math.min(30_000, idleDelay * 2) : 5000;
        if (!selected) timer = setTimeout(() => { void load(false); }, next.nextAfterSeq !== null ? 1000 : idleDelay);
      } catch {
        // telemetry-exempt: the view shows a safe error and waits for an explicit retry.
        if (alive()) { setLoading(false); setFailure('error'); }
      }
    };
    void load(true);
    return () => {
      generation.current++;
      if (timer) clearTimeout(timer);
      if (historyRetry.current) clearTimeout(historyRetry.current);
      historyRetry.current = null;
    };
  }, [machine, selected, retry, connection]);

  const earlier = async () => {
    const before = current.current;
    if (!before?.nextBeforeSeq || earlierLoading) return;
    const token = generation.current;
    setEarlierLoading(true);
    const readPage = async () => {
      let retrying = false;
      try {
        if (token !== generation.current || current.current?.sessionId !== before.sessionId) return;
        const result = await window.clubhouse.annexClient.controllerChatPage(machine, {
          ...(before.sessionId && { sessionId: before.sessionId }), beforeSeq: before.nextBeforeSeq,
        });
        if (token !== generation.current || current.current?.sessionId !== before.sessionId) return;
        if (result.status === 'rate_limited') {
          retrying = true;
          historyRetry.current = setTimeout(() => { historyRetry.current = null; void readPage(); }, result.retryAfterMs);
          return;
        }
        if (result.status !== 'ok') { setFailure(result.status); return; }
        const merged = { ...current.current, nextBeforeSeq: result.value.nextBeforeSeq };
        current.current = merged; setPage(merged);
        setEvents((prev) => mergeControllerEvents(prev, result.value.events));
        setFailure(null);
      } catch {
        // telemetry-exempt: displayed in the read-only view.
        if (token === generation.current) setFailure('error');
      } finally { if (!retrying && token === generation.current) setEarlierLoading(false); }
    };
    await readPage();
  };
  const loadSessions = async () => {
    const token = generation.current;
    setSessionsError(false);
    try {
      const result = await window.clubhouse.annexClient.controllerChatSessions(machine);
      if (token !== generation.current) return;
      if (result.status === 'ok') setSessions([...result.value.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt));
      else setSessionsError(true);
    } catch {
      // telemetry-exempt: displayed without remote error text.
      if (token === generation.current) setSessionsError(true);
    }
  };

  return <RemoteChatContext.Provider value={{ machineName }}>
    <section className="h-full min-h-0 flex flex-col bg-ctp-base" aria-label="Remote controller conversation" data-testid="remote-controller-chat">
      <div className="flex-shrink-0 px-7 py-2 text-xs text-ctp-overlay1 border-b border-surface-0 flex flex-wrap items-center gap-2">
        <h2 className="font-medium text-ctp-subtext0">{DISPATCHER_CONTROLLER_NAME} on {machineName}</h2>
        <span>Read only · tools and thoughts included · large tool output previewed</span>
        <button type="button" onClick={() => { void loadSessions(); }} className="text-ctp-accent">Browse history</button>
        {sessions && <select aria-label="Controller conversation" value={selected} onChange={(event) => setSelected(event.target.value)} className="bg-surface-0 text-ctp-text rounded p-1">
          <option value="">Current conversation</option>
          {sessions.map((s) => <option key={s.sessionId} value={s.sessionId}>{new Date(s.startedAt).toLocaleString()} · {s.title || 'Conversation'}</option>)}
        </select>}
        {sessionsError && <span role="alert">Could not load saved conversations. Try Browse history again.</span>}
      </div>
      {failure && <div role="status" className="px-7 py-3 text-sm text-ctp-subtext0">
        {READ_MESSAGES[failure]} <button type="button" onClick={() => setRetry((n) => n + 1)} className="text-ctp-accent">Retry</button>
      </div>}
      {earlierLoading && <p role="status" className="px-7 text-xs text-ctp-overlay1">Loading earlier messages…</p>}
      <div className="flex-1 min-h-0 flex flex-col">
        <ChatStream state={state} agentName={DISPATCHER_CONTROLLER_NAME} announce={false}
          emptyMessage={loading ? 'Loading conversation…' : failure ? 'Conversation unavailable.' : 'This conversation has no messages.'}
          onShowEarlier={page?.nextBeforeSeq && !earlierLoading ? () => { void earlier(); } : undefined} />
      </div>
    </section>
  </RemoteChatContext.Provider>;
}

export function mergeControllerEvents(previous: ChatEvent[], next: ChatEvent[]): ChatEvent[] {
  const bySeq = new Map(previous.map((e) => [`${e.sessionId}:${e.seq}`, e]));
  for (const event of next) bySeq.set(`${event.sessionId}:${event.seq}`, event);
  return compactControllerEvents([...bySeq.values()].sort((a, b) => a.seq - b.seq));
}
