/**
 * Native chat view for an agent running in the chat runtime
 * (docs/structured-chat-research.md, UI and Phase 1 "ChatView core").
 *
 * Renders purely from the agent's ChatViewState, which the chat store folds
 * from ChatEvent envelopes. Features a driver doesn't report in its
 * ChatCapabilities are hidden or disabled; nothing here checks provider ids.
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Agent } from '../../../../shared/types';
import type { PermissionLevel } from '../../../../shared/chat';
import { createChatViewState, useAnswering, type ChatViewState } from '../../../stores/chatStore';
import { ChatHeader } from './ChatHeader';
import { ChatHistory } from './ChatHistory';
import { isNewChromeEnabled } from '../../../chrome/chromeFlag';
import { ChatStream, type StreamJump } from './ChatStream';
import { AgentDetails } from '../details/AgentDetails';
import { DetailsToggle } from '../details/DetailsToggle';
import { ChangesReview } from '../review/ChangesReview';
import { DOT_LABEL, StatusDot } from '../agent-status';
import { Button } from '../../../components/Button';
import { useAgentReview } from '../review/useAgentReview';
import { useAgentDetailsStore } from '../details/detailsStore';
import { PermissionCard, QuestionCard } from './ApprovalDock';
import { XIcon } from './icons';
import { Composer, LevelPill, QueueList, TaskList, type ComposerLayout } from './Composer';
import { useNarrow, useShortWindow } from '../pane/useNarrow';
import { useChatActions, useChatAttachments, useChatDraft, useChatDraftStore, useChatLoading, useChatState, useChatTranscript, useEarlierHistory, type ChatActions } from './useChatSession';
import { buildAgentMap, commandForRequest, diffsForRequest, implementLevel, isRunningState, isSessionEnded, LEVEL_LABELS, needsManualPlanHandoff, planForRequest, type SendAction } from './view-model';
import { HelperHeader } from '../helpers/HelperHeader';

/** Where a ChatView is shown; several can show the same agent at once. */
export type ChatViewContext = 'main' | 'popout' | 'canvas' | 'plugin';

/** Canvas cards read only the end of the transcript; "Show earlier" loads the rest. */
export const CANVAS_TRANSCRIPT_TAIL = 1500;

export interface ChatViewBodyProps {
  agent: Agent;
  state: ChatViewState;
  actions: ChatActions;
  /** @deprecated The toolbar names the provider from the session itself. */
  providerName?: string;
  loading?: boolean;
  onSwitchToTerminal?: () => void;
  switching?: boolean;
  context?: ChatViewContext;
  /** Set when earlier history wasn't loaded. */
  onShowEarlier?: () => void;
  onBrowseHistory?: () => void;
}

/**
 * Unrecognized CLI messages, plus the "newer than tested" CLI note. That note
 * is only shown here, next to a real problem (drift or a fatal error), since
 * a CLI newer than the tested one is the normal case. One line (the names and
 * full text are in the tooltip), shorter on canvas cards, and dismissible
 * until a new kind of message turns up.
 */
function ProtocolDriftNote({ state, compact }: { state: ChatViewState; compact: boolean }) {
  const [dismissedKinds, setDismissedKinds] = useState<number | null>(null);
  const counts = state.protocolUnknown;
  const names = Object.keys(counts);
  const fatal = state.items.some((i) => i.kind === 'error' && i.fatal);
  const versionNote = state.untestedCliNote && (names.length > 0 || fatal) ? state.untestedCliNote : null;
  if (names.length === 0 && !versionNote) return null;
  if (dismissedKinds !== null && names.length <= dismissedKinds) return null;
  const total = names.reduce((n, k) => n + counts[k], 0);
  const messages = total === 1 ? 'message' : 'messages';
  const drift = names.length === 0 ? ''
    : compact ? `${total} unrecognized CLI ${messages}. `
    : `This CLI sent ${total} ${messages} Clubhouse doesn't recognize yet. The terminal view shows everything. `;
  const text = `${drift}${versionNote ?? ''}`.trim();
  return (
    <div className="flex items-center gap-1.5 min-w-0 text-[12px] text-ctp-overlay0 px-1" data-testid="chat-protocol-unknown">
      <span className="truncate min-w-0" title={[text, ...names].join('\n')}>{text}</span>
      <button
        type="button"
        className="flex-shrink-0 p-0.5 rounded text-ctp-overlay0 hover:text-ctp-text"
        aria-label="Dismiss"
        data-testid="chat-protocol-unknown-dismiss"
        onClick={() => setDismissedKinds(names.length)}
      >
        <XIcon size={10} />
      </button>
    </div>
  );
}

/** Shown after the CLI reports it needs a login: the terminal runs the CLI's own login flow. */
function LoginBanner({ state, onSwitchToTerminal }: { state: ChatViewState; onSwitchToTerminal?: () => void }) {
  const last = state.items[state.items.length - 1];
  if (!last || last.kind !== 'error' || last.code !== 'auth_required') return null;
  return (
    <div className="flex items-center gap-2.5 flex-wrap text-[12.5px] text-ctp-subtext0 px-0.5" data-testid="chat-login-banner" role="status">
      <span>This CLI needs you to log in.</span>
      {onSwitchToTerminal && (
        <button
          type="button"
          onClick={onSwitchToTerminal}
          className="h-7 px-2.5 rounded-md bg-ctp-accent text-ctp-crust text-[12px] font-medium"
        >
          Log in in the terminal
        </button>
      )}
    </div>
  );
}

function PlanHandoff({ state, onImplement }: { state: ChatViewState; onImplement: (level: PermissionLevel) => void }) {
  const level = implementLevel(state.capabilities);
  if (!level || !needsManualPlanHandoff(state)) return null;
  return (
    <div className="flex items-center gap-2.5 flex-wrap text-[12.5px] text-ctp-subtext0 px-0.5" data-testid="chat-plan-handoff">
      <span>This agent doesn't ask for approval in plan mode.</span>
      <button
        type="button"
        onClick={() => onImplement(level)}
        className="h-7 px-2.5 rounded-md bg-ctp-accent text-ctp-crust text-[12px] font-medium"
      >
        Switch to {LEVEL_LABELS[level]} and implement
      </button>
    </div>
  );
}

export function ChatViewBody({ agent, state, actions, loading, onSwitchToTerminal, switching, context = 'main', onShowEarlier, onBrowseHistory }: ChatViewBodyProps) {
  const running = isRunningState(state.state);
  // Only a queue the runtime holds can be edited; a CLI that queues natively (Claude) already has the message.
  const queueEditable = state.capabilities?.queue === 'client';
  const permission = state.pendingPermissions[0];
  const question = state.pendingQuestions[0];
  // An answer sent from another view of this agent disables the card here too.
  const permissionBusy = useAnswering(agent.id, permission?.requestId ?? '');
  const questionBusy = useAnswering(agent.id, question?.requestId ?? '');
  const plan = permission ? planForRequest(state.items, permission) : undefined;
  const ended = isSessionEnded(state);
  const rootRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  // The composer fits the transcript column, which the details column narrows.
  const narrow = useNarrow(columnRef);
  // Below 640px of pane there's no room beside the transcript, so details hides.
  const paneNarrow = useNarrow(rootRef);
  // A popout near its 300px minimum height keeps the conversation, not the composer chrome.
  const short = useShortWindow() && context === 'popout';
  const composerLayout: ComposerLayout = short ? 'line' : narrow ? 'narrow' : 'wide';
  const [draft, setDraft] = useChatDraft(agent.id);
  const [attachments, setAttachments] = useChatAttachments(agent.id);
  const [jump, setJump] = useState<StreamJump | null>(null);
  const { items, subagents, capabilities } = state;
  const runState = state.state;
  const agentMap = useMemo(() => buildAgentMap({ items, subagents, capabilities, state: runState }), [items, subagents, capabilities, runState]);
  // The map exists only when the driver reports subagents and there are some.
  const hasAgentMap = agentMap.mode !== 'none' && agentMap.nodes.length > 0;
  // Details is offered in the main pane; popouts and canvas cards are too small for its column.
  const detailsAvailable = context === 'main';
  const detailsOpen = useAgentDetailsStore((s) => s.open) && detailsAvailable && !paneNarrow;
  const revealDetails = useAgentDetailsStore((s) => s.reveal);
  const openSubagent = useCallback((subagentId: string) => {
    revealDetails({ agentId: agent.id, card: 'subagents', subagentId });
  }, [revealDetails, agent.id]);
  const review = useAgentReview(agent, `${state.turnId ?? 'idle'}:${state.state ?? ''}`, detailsAvailable);
  const reviewing = detailsAvailable && review.active;
  const showInStream = useCallback((subagentId: string) => {
    setJumpMissed(null);
    setJump((j) => ({ subagentId, nonce: (j?.nonce ?? 0) + 1 }));
  }, []);
  // A jump whose target isn't rendered (e.g. a trimmed transcript) is reported in the panel.
  const [jumpMissed, setJumpMissed] = useState<string | null>(null);
  const onJumpResult = useCallback((j: StreamJump, found: boolean) => {
    setJumpMissed(found ? null : j.subagentId);
  }, []);

  const onSend = (text: string, action: SendAction, blocks?: string[]) => {
    const sentAttachments = attachments;
    const send = (delivery: 'auto' | 'steer' | 'queued') => (blocks ? actions.send(text, delivery, blocks) : actions.send(text, delivery));
    void (async () => {
      let result;
      if (action === 'steer') result = await send('steer');
      else if (action === 'queue') result = await send('queued');
      else if (action === 'stop_and_send') {
        // No steering: cancel the turn, then send. 'auto' queues it until the
        // cancelled turn has ended, so it becomes the next prompt. If the turn
        // couldn't be stopped, don't send: the draft goes back to the composer.
        result = (await actions.interrupt()) ? await send('auto') : null;
      } else result = await send('auto');
      // Not sent: put the draft back unless the user has started a new one.
      if (result !== null) return;
      const drafts = useChatDraftStore.getState();
      if (!drafts.drafts[agent.id] && !drafts.attachments[agent.id]) {
        setDraft(text);
        if (blocks) setAttachments(sentAttachments);
      }
    })();
  };

  const onImplement = (level: PermissionLevel) => {
    void (async () => {
      // Implementing in the old level would run the plan unapproved (or not at all).
      if (!(await actions.setLevel(level))) return;
      await actions.send('Implement the plan.', 'auto');
    })();
  };

  let dock: ReactNode;
  if (permission) {
    dock = (
      <PermissionCard
        key={permission.requestId}
        agentName={agent.name}
        extras={state.capabilities?.permissionExtras}
        request={permission}
        busy={permissionBusy}
        plan={plan}
        diffs={diffsForRequest(state.items, permission)}
        command={commandForRequest(state.items, permission)}
        queueSize={state.pendingPermissions.length}
        onRespond={actions.respondPermission}
      />
    );
    // The card replaces the composer, and with it the level pill: keep the pill reachable, so the user can
    // move to a looser level from here. It sits outside the card so its keys never answer the request.
    dock = (
      <>
        <div key={permission.requestId} className="min-h-0 overflow-y-auto" data-testid="chat-permission-scroll">{dock}</div>
        <div className="flex-shrink-0 flex items-center" data-testid="chat-permission-level">
          <LevelPill
            level={state.level}
            capabilities={state.capabilities}
            levelNames={state.levelNames}
            onChange={(l) => { void actions.setLevel(l); }}
            compact={composerLayout !== 'wide'}
          />
        </div>
      </>
    );
  } else if (question) {
    dock = <QuestionCard key={question.requestId} request={question} busy={questionBusy} onAnswer={actions.answerQuestion} />;
  } else {
    dock = (
      <>
        <PlanHandoff state={state} onImplement={onImplement} />
        <Composer
          agentName={agent.name}
          capabilities={state.capabilities}
          running={running}
          disabled={ended || loading}
          disabledReason={loading ? 'Loading the conversation…' : 'This session has ended. Wake the agent to continue.'}
          level={state.level}
          model={state.model}
          modelUnknown={state.modelUnknown}
          effort={state.effort}
          effortIsDefault={state.effortIsDefault}
          effortReported={state.effortReported}
          models={state.models}
          efforts={state.efforts}
          levelNames={state.levelNames}
          commands={state.commands}
          text={draft}
          onTextChange={setDraft}
          attachmentAgentId={agent.id}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          onSend={onSend}
          onStop={() => { void actions.interrupt(); }}
          onLevelChange={(l) => { void actions.setLevel(l); }}
          onModelChange={actions.setModel ? (m, e) => { void actions.setModel?.(m, e); } : undefined}
          layout={composerLayout}
        />
      </>
    );
  }

  return (
    <div ref={rootRef} className="flex flex-col h-full min-h-0 bg-ctp-base" data-testid="chat-view" data-agent-pane={agent.id} data-view-context={context} data-state={state.state ?? 'none'}>
      <ChatHeader
        agent={agent}
        state={state}
        showMenu={context === 'main'}
        showName={context === 'main' && !isNewChromeEnabled()}
        onSwitchToTerminal={onSwitchToTerminal}
        switching={switching}
        detailsToggle={<>
          {onBrowseHistory && <button type="button" onClick={onBrowseHistory} className="h-7 px-2 text-xs text-ctp-subtext0 hover:text-ctp-text">History</button>}
          {detailsAvailable && <DetailsToggle />}
        </>}
        review={detailsAvailable ? review.view : undefined}
      />
      {context === 'main' && <HelperHeader agent={agent} />}
      {reviewing && (permission || question) && (
        // The approval card lives in the chat dock; while reviewing, say it's waiting and offer the way back.
        <div className="h-9 flex-shrink-0 flex items-center gap-2 px-3.5 border-b border-surface-0 text-xs" role="status" data-testid="review-needs-you">
          <StatusDot dot="needs" />
          <span className="text-ctp-text">{DOT_LABEL.needs}</span>
          <span className="min-w-0 truncate text-ctp-overlay1">{permission ? permission.title : 'has a question'}</span>
          <Button kind="primary" className="ml-auto" onClick={() => review.view?.onClose()} data-testid="review-back-to-chat">Back to chat</Button>
        </div>
      )}
      {reviewing && review.cwd && (
        <ChangesReview
          agentName={agent.name}
          cwd={review.cwd}
          branch={review.branch}
          onChanged={review.reload}
          refreshKey={`${state.turnId ?? 'idle'}:${state.state ?? ''}:${state.workspaceRevision}`}
          onAskAgent={ended ? undefined : (text) => { void actions.send(text, running ? 'queued' : 'auto'); }}
        />
      )}
      {/* Hidden, not unmounted, while reviewing: the stream keeps its scroll and the draft its focus. */}
      <div className={`flex-1 min-h-0 flex ${reviewing ? 'hidden' : ''}`}>
        <div ref={columnRef} className="flex-1 min-w-0 min-h-0 flex flex-col">
          {/* Canvas cards stay quiet: the focused view announces replies, not every card on the board. */}
          <ChatStream
            state={state}
            agentName={agent.name}
            onOpenSubagent={hasAgentMap ? openSubagent : undefined}
            jump={jump}
            onJumpResult={onJumpResult}
            announce={context !== 'canvas'}
            onShowEarlier={onShowEarlier}
          />
          {/* An approval card is capped so it can't squeeze the transcript out (#2412): the card and the lists
              above it scroll inside the cap. The composer is never capped or wrapped: its menus open upward. */}
          <div className={`flex-shrink-0 flex justify-center ${permission || question ? 'max-h-[60%]' : ''} ${narrow || short ? 'px-2 pb-2' : 'px-7 pb-4'}`} data-testid="chat-dock">
            <div className="w-full max-w-[740px] min-h-0 flex flex-col gap-2">
              <ProtocolDriftNote state={state} compact={context === 'canvas' || narrow} />
              <LoginBanner state={state} onSwitchToTerminal={onSwitchToTerminal} />
              {(state.plan.length > 0 || state.queued.length > 0) && (
                <div className="min-h-0 overflow-y-auto space-y-2" data-testid="chat-dock-lists">
                  {state.plan.length > 0 && <TaskList entries={state.plan} />}
                  {state.queued.length > 0 && (
                    <QueueList
                      queued={state.queued}
                      onRemove={queueEditable && actions.removeQueued ? (ids) => { void actions.removeQueued?.(ids); } : undefined}
                    />
                  )}
                </div>
              )}
              {dock}
            </div>
          </div>
        </div>
        {detailsOpen && (
          <AgentDetails agent={agent} chat={state} onShowInStream={showInStream} missedSubagentId={jumpMissed} branch={review.branch} onReviewAll={review.cwd ? review.open : undefined} />
        )}
      </div>
    </div>
  );
}

export interface ChatViewProps {
  agent: Agent;
  onSwitchToTerminal?: () => void;
  switching?: boolean;
  context?: ChatViewContext;
}

/** ChatView bound to the chat store. */
export function ChatView({ agent, onSwitchToTerminal, switching, context = 'main' }: ChatViewProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  useChatTranscript(agent.id, context === 'canvas' ? CANVAS_TRANSCRIPT_TAIL : undefined);
  const earlier = useEarlierHistory(agent.id);
  const stored = useChatState(agent.id);
  const loading = useChatLoading(agent.id);
  const actions = useChatActions(agent.id);
  const empty = useMemo(() => createChatViewState(agent.id), [agent.id]);
  if (historyOpen) return <ChatHistory key={agent.id} agentId={agent.id} currentSessionId={stored?.sessionId ?? null} onClose={() => setHistoryOpen(false)} />;
  return (
    <ChatViewBody
      agent={agent}
      state={stored ?? empty}
      actions={actions}
      loading={loading && !stored}
      onSwitchToTerminal={onSwitchToTerminal}
      switching={switching}
      context={context}
      onShowEarlier={earlier.partial ? earlier.loadAll : undefined}
      onBrowseHistory={() => setHistoryOpen(true)}
    />
  );
}

export default ChatView;
