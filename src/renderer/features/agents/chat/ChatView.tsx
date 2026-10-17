/**
 * Native chat view for an agent running in the chat runtime
 * (docs/structured-chat-research.md, UI and Phase 1 "ChatView core").
 *
 * Renders purely from the agent's ChatViewState, which the chat store folds
 * from ChatEvent envelopes. Features a driver doesn't report in its
 * ChatCapabilities are hidden or disabled; nothing here checks provider ids.
 */

import { useMemo, type ReactNode } from 'react';
import type { Agent } from '../../../../shared/types';
import type { PermissionLevel } from '../../../../shared/chat';
import { createChatViewState, useAnswering, type ChatViewState } from '../../../stores/chatStore';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { ChatHeader } from './ChatHeader';
import { ChatStream } from './ChatStream';
import { PermissionCard, QuestionCard } from './ApprovalDock';
import { Composer, QueueList, TaskList } from './Composer';
import { useChatActions, useChatDraft, useChatDraftStore, useChatLoading, useChatState, useChatTranscript, useEarlierHistory, type ChatActions } from './useChatSession';
import { implementLevel, isRunningState, isSessionEnded, LEVEL_LABELS, needsManualPlanHandoff, planForRequest, type SendAction } from './view-model';

/** Where a ChatView is shown; several can show the same agent at once. */
export type ChatViewContext = 'main' | 'popout' | 'canvas' | 'plugin';

/** Canvas cards read only the end of the transcript; "Show earlier" loads the rest. */
export const CANVAS_TRANSCRIPT_TAIL = 1500;

export interface ChatViewBodyProps {
  agent: Agent;
  state: ChatViewState;
  actions: ChatActions;
  providerName: string;
  loading?: boolean;
  onSwitchToTerminal?: () => void;
  switching?: boolean;
  context?: ChatViewContext;
  /** Set when earlier history wasn't loaded. */
  onShowEarlier?: () => void;
}

function ProtocolDriftNote({ counts }: { counts: Record<string, number> }) {
  const names = Object.keys(counts);
  if (names.length === 0) return null;
  const total = names.reduce((n, k) => n + counts[k], 0);
  return (
    <div className="text-[12px] text-ctp-overlay1 px-1" title={names.join('\n')} data-testid="chat-protocol-unknown">
      This CLI sent {total} {total === 1 ? 'message' : 'messages'} Clubhouse doesn't recognize yet, so some activity may be missing here. The terminal view shows everything.
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

export function ChatViewBody({ agent, state, actions, providerName, loading, onSwitchToTerminal, switching, context = 'main', onShowEarlier }: ChatViewBodyProps) {
  const running = isRunningState(state.state);
  const permission = state.pendingPermissions[0];
  const question = state.pendingQuestions[0];
  // An answer sent from another view of this agent disables the card here too.
  const permissionBusy = useAnswering(agent.id, permission?.requestId ?? '');
  const questionBusy = useAnswering(agent.id, question?.requestId ?? '');
  const plan = permission ? planForRequest(state.items, permission) : undefined;
  const ended = isSessionEnded(state);
  const [draft, setDraft] = useChatDraft(agent.id);

  const onSend = (text: string, action: SendAction) => {
    void (async () => {
      let result;
      if (action === 'steer') result = await actions.send(text, 'steer');
      else if (action === 'queue') result = await actions.send(text, 'queued');
      else if (action === 'stop_and_send') {
        // No steering: cancel the turn, then send. 'auto' queues it until the
        // cancelled turn has ended, so it becomes the next prompt.
        await actions.interrupt();
        result = await actions.send(text, 'auto');
      } else result = await actions.send(text, 'auto');
      // Not sent: put the text back unless the user has started a new draft.
      if (result === null && !useChatDraftStore.getState().drafts[agent.id]) setDraft(text);
    })();
  };

  const onImplement = (level: PermissionLevel) => {
    void (async () => {
      await actions.setLevel(level);
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
        queueSize={state.pendingPermissions.length}
        onRespond={actions.respondPermission}
      />
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
          effort={state.effort}
          commands={state.commands}
          text={draft}
          onTextChange={setDraft}
          onSend={onSend}
          onStop={() => { void actions.interrupt(); }}
          onLevelChange={(l) => { void actions.setLevel(l); }}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-ctp-base" data-testid="chat-view" data-view-context={context} data-state={state.state ?? 'none'}>
      <ChatHeader agent={agent} state={state} providerName={providerName} onSwitchToTerminal={onSwitchToTerminal} switching={switching} />
      {/* Canvas cards stay quiet: the focused view announces replies, not every card on the board. */}
      <ChatStream state={state} announce={context !== 'canvas'} onShowEarlier={onShowEarlier} />
      <div className="flex-shrink-0 px-7 pb-4 flex justify-center" data-testid="chat-dock">
        <div className="w-full max-w-[740px] flex flex-col gap-2">
          <ProtocolDriftNote counts={state.protocolUnknown} />
          {state.plan.length > 0 && <TaskList entries={state.plan} />}
          {state.queued.length > 0 && <QueueList queued={state.queued} />}
          {dock}
        </div>
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
  useChatTranscript(agent.id, context === 'canvas' ? CANVAS_TRANSCRIPT_TAIL : undefined);
  const earlier = useEarlierHistory(agent.id);
  const stored = useChatState(agent.id);
  const loading = useChatLoading(agent.id);
  const actions = useChatActions(agent.id);
  const orchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const empty = useMemo(() => createChatViewState(agent.id), [agent.id]);
  const providerId = stored?.provider ?? agent.orchestrator ?? 'claude-code';
  const providerName = orchestrators.find((o) => o.id === providerId)?.displayName ?? providerId;
  return (
    <ChatViewBody
      agent={agent}
      state={stored ?? empty}
      actions={actions}
      providerName={providerName}
      loading={loading && !stored}
      onSwitchToTerminal={onSwitchToTerminal}
      switching={switching}
      context={context}
      onShowEarlier={earlier.partial ? earlier.loadAll : undefined}
    />
  );
}

export default ChatView;
