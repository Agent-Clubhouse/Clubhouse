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
import type { ContentBlock, PermissionLevel } from '../../../../shared/chat';
import { createChatViewState, type ChatViewState } from '../../../stores/chatStore';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { ChatHeader } from './ChatHeader';
import { ChatStream } from './ChatStream';
import { PermissionCard, QuestionCard } from './ApprovalDock';
import { Composer, QueueList, TaskList } from './Composer';
import { useChatActions, useChatAttachments, useChatDraft, useChatDraftStore, useChatLoading, useChatState, useChatTranscript, type ChatActions } from './useChatSession';
import { implementLevel, isRunningState, isSessionEnded, LEVEL_LABELS, needsManualPlanHandoff, planForRequest, type SendAction } from './view-model';

export interface ChatViewBodyProps {
  agent: Agent;
  state: ChatViewState;
  actions: ChatActions;
  providerName: string;
  loading?: boolean;
  onSwitchToTerminal?: () => void;
  switching?: boolean;
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

export function ChatViewBody({ agent, state, actions, providerName, loading, onSwitchToTerminal, switching }: ChatViewBodyProps) {
  const running = isRunningState(state.state);
  const permission = state.pendingPermissions[0];
  const question = state.pendingQuestions[0];
  const plan = permission ? planForRequest(state.items, permission) : undefined;
  const ended = isSessionEnded(state);
  const [draft, setDraft] = useChatDraft(agent.id);
  const [attachments, setAttachments] = useChatAttachments(agent.id);

  const onSend = (text: string, action: SendAction, blocks?: ContentBlock[]) => {
    const sentAttachments = attachments;
    const send = (delivery: 'auto' | 'steer' | 'queued') => (blocks ? actions.send(text, delivery, blocks) : actions.send(text, delivery));
    void (async () => {
      let result;
      if (action === 'steer') result = await send('steer');
      else if (action === 'queue') result = await send('queued');
      else if (action === 'stop_and_send') {
        // No steering: cancel the turn, then send. 'auto' queues it until the
        // cancelled turn has ended, so it becomes the next prompt.
        await actions.interrupt();
        result = await send('auto');
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
      await actions.setLevel(level);
      await actions.send('Implement the plan.', 'auto');
    })();
  };

  let dock: ReactNode;
  if (permission) {
    dock = (
      <PermissionCard
        key={permission.requestId}
        request={permission}
        plan={plan}
        queueSize={state.pendingPermissions.length}
        onRespond={actions.respondPermission}
      />
    );
  } else if (question) {
    dock = <QuestionCard key={question.requestId} request={question} onAnswer={actions.answerQuestion} />;
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
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          onSend={onSend}
          onStop={() => { void actions.interrupt(); }}
          onLevelChange={(l) => { void actions.setLevel(l); }}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-ctp-base" data-testid="chat-view" data-state={state.state ?? 'none'}>
      <ChatHeader agent={agent} state={state} providerName={providerName} onSwitchToTerminal={onSwitchToTerminal} switching={switching} />
      <ChatStream state={state} />
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
}

/** ChatView bound to the chat store. */
export function ChatView({ agent, onSwitchToTerminal, switching }: ChatViewProps) {
  useChatTranscript(agent.id);
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
    />
  );
}

export default ChatView;
