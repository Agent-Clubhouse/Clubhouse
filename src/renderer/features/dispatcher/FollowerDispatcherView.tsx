import { useMemo, useState } from 'react';
import type { Agent } from '../../../shared/types';
import type { LeadOutboxState } from '../../../shared/dispatcher-lead';
import { createChatViewState } from '../../stores/chatStore';
import { Button } from '../../components/Button';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { AgentRuntimePane } from '../agents/chat/AgentRuntimePane';
import { ChatStream } from '../agents/chat/ChatStream';
import { formatWhen } from '../agents/chat/MessageBlocks';
import { useChatLoading, useChatState, useChatTranscript } from '../agents/chat/useChatSession';
import { groupChatState } from './group-chat';
import type { FollowedLead } from './leadStore';

/**
 * The Dispatcher pane on a follower (#3352, #3353): the lead's chat, live,
 * through chat across desktops (D219). This computer's own chat until it
 * started following stays as it was, read-only, one click away. Nothing is
 * deleted or merged.
 *
 * While the lead's computer is offline, its chat as last loaded stays
 * readable, and what the person types waits on this computer until it's back.
 * Take back is the person's way to use this computer's own Dispatcher now.
 * Nothing takes back by itself.
 */
export function FollowerDispatcherView({ lead, localChatId, localName }: { lead: FollowedLead; localChatId: string; localName: string }) {
  const [earlier, setEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const machine = lead.machineName;
  const leadName = lead.agent?.name ?? 'the Dispatcher';

  const run = async (action: () => Promise<unknown>, failed: string) => {
    setError(null);
    try { await action(); } catch (err) {
      // telemetry-exempt: shown in the pane, which keeps its state.
      setError(`${failed} ${ipcErrorMessage(err)}`);
    }
  };

  let body: React.ReactNode;
  if (earlier) body = <EarlierChat agentId={localChatId} name={localName} />;
  else if (!lead.agent) {
    body = (
      <p className="m-auto max-w-md text-center text-sm text-ctp-subtext0" role="status" data-testid="follower-no-lead-chat">
        {lead.online ? `${machine}’s Dispatcher is off. Its chat shows here when it’s on.` : `Waiting for ${machine} to connect.`}
      </p>
    );
  } else if (lead.online) body = <AgentRuntimePane key={lead.agent.id} agent={lead.agent} terminal={null} canSwitch={false} />;
  else body = <OfflineLeadChat agent={lead.agent} machine={machine} onError={setError} />;

  return (
    <div className="relative h-full flex flex-col bg-ctp-base" data-testid="follower-dispatcher-view" data-lead-online={lead.online}>
      <div className="flex-shrink-0 px-7 py-2 flex flex-col gap-1 text-xs text-ctp-overlay1 border-b border-surface-0">
        <div className="flex items-center gap-3">
          <p className="flex-1 min-w-0 truncate text-ctp-subtext0" data-testid="follower-heading">
            {earlier ? `This computer’s earlier chat with ${localName}. Read only.` : `Following ${leadName} on ${machine}`}
          </p>
          <Button onClick={() => setEarlier((v) => !v)} data-testid="follower-earlier-toggle">
            {earlier ? `Back to ${machine}` : 'This computer’s earlier chat'}
          </Button>
          <Button onClick={() => void run(() => window.clubhouse.dispatcher.takeBack(), 'Couldn’t take back.')} data-testid="follower-take-back">
            Take back
          </Button>
        </div>
        {!lead.online && (
          <p data-testid="follower-lead-offline">
            Lead ({machine}) is offline{lead.state.leadLastSeen ? `, last seen ${formatWhen(Date.parse(lead.state.leadLastSeen))}` : ''}.
            {' '}What you send waits until it’s back, for up to a day. Take back to use this computer’s Dispatcher now.
          </p>
        )}
        <OutboxNotice outbox={lead.state.outbox} machine={machine} onError={setError} />
        <LocalNewsNotice news={lead.state.localNews} onShow={() => setEarlier(true)} onError={setError} />
        {error && <p className="text-ctp-error" role="alert" data-testid="follower-error">{error}</p>}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{body}</div>
    </div>
  );
}

/** "1 message", "3 messages". */
export function messages(n: number): string {
  return `${n} ${n === 1 ? 'message' : 'messages'}`;
}

/** What waits for the lead, and what didn't make it. */
export function outboxLines(outbox: LeadOutboxState, machine: string): { waiting: string | null; problem: string | null } {
  const waiting = outbox.waiting > 0 ? `${messages(outbox.waiting)} waiting for ${machine}.` : null;
  const problems = [
    outbox.expired > 0 ? `${messages(outbox.expired)} expired before ${machine} came back, and ${outbox.expired === 1 ? 'wasn’t' : 'weren’t'} sent.` : null,
    outbox.failed,
  ].filter(Boolean);
  return { waiting, problem: problems.length ? problems.join(' ') : null };
}

function OutboxNotice({ outbox, machine, onError }: { outbox: LeadOutboxState; machine: string; onError: (error: string | null) => void }) {
  const { waiting, problem } = outboxLines(outbox, machine);
  if (!waiting && !problem) return null;
  return (
    <>
      {waiting && <p data-testid="follower-waiting">{waiting}</p>}
      {problem && (
        <p className="flex items-center gap-2" data-testid="follower-outbox-problem">
          <span>{problem}</span>
          <Button onClick={() => {
            window.clubhouse.dispatcher.dismissLeadNotice().catch((err: unknown) => {
              // telemetry-exempt: shown in the pane; the notice stays.
              onError(`Couldn’t dismiss it. ${ipcErrorMessage(err)}`);
            });
          }} data-testid="follower-outbox-dismiss">Dismiss</Button>
        </p>
      )}
    </>
  );
}

/** News this computer's Dispatcher kept in its own chat while the lead couldn't take it. */
export function localNewsLine(news: { count: number; needsUser: boolean }): string | null {
  if (news.count === 0) return null;
  const what = news.count === 1 ? 'An update from this computer’s Dispatcher is' : `${news.count} updates from this computer’s Dispatcher are`;
  return `${what} in its own chat, because the lead couldn’t take ${news.count === 1 ? 'it' : 'them'}.`
    + (news.needsUser ? ' One needs your answer: read it in this computer’s earlier chat, and Take back to answer it there.' : '');
}

function LocalNewsNotice({ news, onShow, onError }: { news: { count: number; needsUser: boolean }; onShow: () => void; onError: (error: string | null) => void }) {
  const line = localNewsLine(news);
  if (!line) return null;
  return (
    <p className={`flex items-center gap-2 ${news.needsUser ? 'text-ctp-warning' : ''}`} data-testid="follower-local-news">
      <span>{line}</span>
      <Button onClick={onShow} data-testid="follower-local-news-show">Show</Button>
      <Button onClick={() => {
        window.clubhouse.dispatcher.dismissLeadNotice().catch((err: unknown) => {
          // telemetry-exempt: shown in the pane; the notice stays.
          onError(`Couldn’t dismiss it. ${ipcErrorMessage(err)}`);
        });
      }} data-testid="follower-local-news-dismiss">Dismiss</Button>
    </p>
  );
}

/** The lead's chat as last loaded, read-only, with a box whose messages wait for the lead. */
function OfflineLeadChat({ agent, machine, onError }: { agent: Agent; machine: string; onError: (error: string | null) => void }) {
  const stored = useChatState(agent.id);
  const empty = useMemo(() => createChatViewState(agent.id), [agent.id]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    const message = text.trim();
    if (!message) return;
    setSending(true);
    onError(null);
    try {
      await window.clubhouse.dispatcher.queueForLead(message);
      setText('');
    } catch (err) {
      // telemetry-exempt: shown in the pane; the draft stays in the box.
      onError(`Couldn’t keep the message. ${ipcErrorMessage(err)}`);
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        <ChatStream state={stored ?? empty} agentName={agent.name} announce={false} emptyMessage="Nothing loaded from the lead yet." />
      </div>
      <form
        className="flex-shrink-0 flex items-end gap-2 px-7 py-3 border-t border-surface-0"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        <textarea
          aria-label={`Message for ${agent.name} on ${machine}`}
          className="flex-1 min-h-[38px] max-h-40 resize-y rounded-md bg-ctp-mantle border border-surface-1 px-3 py-2 text-sm text-ctp-text"
          value={text}
          placeholder={`Sent when ${machine} is back`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          data-testid="follower-offline-input"
        />
        <Button type="submit" disabled={sending || !text.trim()} data-testid="follower-offline-send">Send later</Button>
      </form>
    </>
  );
}

/** This computer's own Dispatcher chat, read-only, as its group chat shows it. */
function EarlierChat({ agentId, name }: { agentId: string; name: string }) {
  useChatTranscript(agentId);
  const stored = useChatState(agentId);
  const loading = useChatLoading(agentId);
  const empty = useMemo(() => createChatViewState(agentId), [agentId]);
  const ctx = useMemo(() => ({ ownAgentIds: new Set([agentId]) }), [agentId]);
  const state = useMemo(() => groupChatState(stored ?? empty, ctx), [stored, empty, ctx]);
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="follower-earlier-chat">
      <ChatStream state={state} agentName={name} announce={false} emptyMessage={loading && !stored ? 'Loading' : 'This computer’s Dispatcher has no earlier chat.'} />
    </div>
  );
}
