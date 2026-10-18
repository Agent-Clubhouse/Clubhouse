import { useEffect, useState } from 'react';
import type { ChatSessionSummary } from '../../../../shared/chat';
import { foldChatEvents, type ChatViewState } from '../../../stores/chatStore';
import { ChatStream } from './ChatStream';

function SavedSession({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const [tail, setTail] = useState<number | undefined>(500);
  const [state, setState] = useState<ChatViewState | null>(null);
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setError(false);
    window.clubhouse.chat.readTranscript(agentId, tail, sessionId).then((events) => {
      if (!alive) return;
      setState(foldChatEvents(undefined, agentId, events));
      setPartial(tail !== undefined && events.length >= tail);
    }, () => { if (alive) setError(true); }); // telemetry-exempt: the archive displays the read error.
    return () => { alive = false; };
  }, [agentId, sessionId, tail]);
  if (error) return <p role="alert" className="p-4 text-ctp-error">Could not load this conversation.</p>;
  if (!state) return <p role="status" className="p-4 text-ctp-overlay1">Loading conversation…</p>;
  return <ChatStream state={state} announce={false} onShowEarlier={partial ? () => setTail(undefined) : undefined} />;
}

/** Saved history is separate from the live store and never exposes a composer or approval controls. */
export function ChatHistory({ agentId, currentSessionId, onClose }: {
  agentId: string;
  currentSessionId: string | null;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<ChatSessionSummary[] | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    window.clubhouse.chat.listSessions(agentId).then((list) => {
      if (!alive) return;
      setSessions(list);
      setSelected((id) => list.some((s) => s.sessionId === id) ? id
        : (list.find((s) => s.sessionId !== currentSessionId) ?? list[0])?.sessionId ?? '');
    }, () => { if (alive) setError(true); }); // telemetry-exempt: shown in the history view.
    return () => { alive = false; };
  }, [agentId, currentSessionId]);
  return (
    <section aria-label="Chat history" className="flex flex-col h-full min-h-0 bg-ctp-base">
      <div className="flex items-center gap-2 p-2 text-xs border-b border-surface-0">
        <span className="text-ctp-overlay1">Saved conversation · read only</span>
        <button type="button" onClick={onClose} className="ml-auto text-ctp-accent">Back to current chat</button>
      </div>
      {error ? <p role="alert" className="p-4 text-ctp-error">Could not load saved sessions.</p>
        : sessions === null ? <p role="status" className="p-4 text-ctp-overlay1">Loading sessions…</p>
          : sessions.length === 0 ? <p className="p-4 text-ctp-overlay1">No saved conversations.</p>
            : <select aria-label="Saved session" value={selected} onChange={(e) => setSelected(e.target.value)} className="m-2 p-2 bg-surface-0 text-ctp-text rounded">
              {sessions.map((s) => <option key={s.sessionId} value={s.sessionId}>
                {new Date(s.startedAt).toLocaleString()} · {s.title || s.sessionId.slice(0, 8)}{s.sessionId === currentSessionId ? ' (current)' : ''}
              </option>)}
            </select>}
      {selected && <SavedSession key={`${agentId}:${selected}`} agentId={agentId} sessionId={selected} />}
    </section>
  );
}
