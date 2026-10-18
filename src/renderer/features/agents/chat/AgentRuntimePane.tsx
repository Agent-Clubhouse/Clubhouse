/**
 * Picks the agent pane's view: ChatView for agents running in the chat
 * runtime, the terminal otherwise. With the experimental Chat flag off (or in
 * a build that isn't preview-eligible) it renders the terminal exactly as
 * before and never loads the chat view.
 *
 * The Chat / Terminal switch hands the agent over by setting its runtime
 * override and restarting it with resume, so the CLI keeps its context
 * (docs/structured-chat-research.md §7.1, decision 8: switch freely when idle;
 * during a turn, confirm "Interrupt and switch?" first).
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Agent } from '../../../../shared/types';
import type { AgentRuntimeMode, ChatAgentRuntimeInfo } from '../../../../shared/chat';
import { useChatStore } from '../../../stores/chatStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useToastStore } from '../../../stores/toastStore';
import { isRemoteProjectId } from '../../../stores/remoteProjectStore';
import { ConfirmDestructiveAction } from '../../../components/ConfirmDestructiveAction';
import { TerminalPaneToolbar } from '../pane/AgentPaneToolbar';
import { AgentDetails } from '../details/AgentDetails';
import { DetailsToggle } from '../details/DetailsToggle';
import { useAgentDetailsStore } from '../details/detailsStore';
import { useNarrow } from '../pane/useNarrow';
import { ChangesReview } from '../review/ChangesReview';
import { useAgentReview } from '../review/useAgentReview';
import { isNewChromeEnabled } from '../../../chrome/chromeFlag';
import type { ChatViewContext } from './ChatView';
import { isRunningState } from './view-model';
import { noteExplicitTerminalChoice } from './chat-default-tip';
import { rendererLog } from '../../../plugins/renderer-logger';

const ChatView = lazy(() => import('./ChatView'));

const SWITCH_LOG_NS = 'ui:chat:switch';

let flagPromise: Promise<boolean> | null = null;
/** The resolved flag, so panes mounted after the first load render the right view at once. */
let flagValue: boolean | null = null;

/** Same gate as main: the Chat flag only counts in preview-eligible builds. */
export function loadChatFlag(): Promise<boolean> {
  if (!flagPromise) {
    flagPromise = Promise.all([window.clubhouse.app.getExperimentalSettings(), window.clubhouse.app.isPreviewEligible()])
      .then(([s, eligible]) => s?.chat === true && eligible === true)
      .catch(() => false)
      .then((v) => { flagValue = v; return v; });
  }
  return flagPromise;
}

/** For tests and for the Experimental settings toggle. */
export function resetChatFlagCache(): void {
  flagPromise = null;
  flagValue = null;
  runtimeCache.clear();
}

/** The Chat flag, or null until it has loaded once this app session. */
export function useChatFlag(): boolean | null {
  const [on, setOn] = useState<boolean | null>(() => flagValue);
  useEffect(() => {
    let cancelled = false;
    void loadChatFlag().then((v) => { if (!cancelled) setOn(v); });
    return () => { cancelled = true; };
  }, []);
  return on;
}

const NO_CHAT: ChatAgentRuntimeInfo = { chat: false, chatAvailable: false };

/** Last known runtime per agent: a pane remounting for an agent starts from it instead of NO_CHAT. */
const runtimeCache = new Map<string, ChatAgentRuntimeInfo>();

/**
 * Which runtime the agent is in, re-checked when it starts, stops or opens a
 * chat session. Null while the first answer for an eligible agent is pending.
 */
export function useAgentRuntimeInfo(agent: Agent, enabled: boolean): ChatAgentRuntimeInfo | null {
  // Tagged with the agent id, so a result for a different agent is never shown.
  const [entry, setEntry] = useState<{ agentId: string; info: ChatAgentRuntimeInfo | null }>(() => ({ agentId: agent.id, info: runtimeCache.get(agent.id) ?? null }));
  const chatSession = useChatStore((s) => s.agents[agent.id]?.sessionId ?? null);
  const remote = isRemoteProjectId(agent.projectId);
  const eligible = enabled && !remote && agent.kind === 'durable';
  useEffect(() => {
    if (!eligible) { setEntry({ agentId: agent.id, info: NO_CHAT }); return; }
    // Drop a NO_CHAT left from before the flag loaded: until the answer comes, it's the last known runtime or unknown.
    setEntry((prev) => {
      const info = runtimeCache.get(agent.id) ?? null;
      return prev.agentId === agent.id && prev.info === info ? prev : { agentId: agent.id, info };
    });
    let cancelled = false;
    const apply = (info: ChatAgentRuntimeInfo) => {
      if (cancelled) return;
      runtimeCache.set(agent.id, info);
      setEntry({ agentId: agent.id, info });
    };
    window.clubhouse.chat.getAgentRuntime(agent.id, agent.orchestrator)
      .then((r) => apply(r ?? NO_CHAT))
      .catch(() => apply(NO_CHAT));
    return () => { cancelled = true; };
  }, [eligible, agent.id, agent.orchestrator, agent.status, chatSession]);
  if (!eligible) return NO_CHAT;
  if (entry.agentId !== agent.id) return runtimeCache.get(agent.id) ?? null;
  return entry.info;
}

/** Restart a durable agent in the other runtime, resuming its CLI session. */
export async function switchAgentRuntime(agent: Agent, mode: AgentRuntimeMode): Promise<void> {
  const meta = { agentId: agent.id, to: mode };
  // `breadcrumb` lands on feedback reports (#2098): the mode only, never ids.
  rendererLog(SWITCH_LOG_NS, 'info', 'Runtime switch requested', { meta: { ...meta, breadcrumb: { kind: 'event', code: `runtime.switch.${mode}` } } });
  try {
    const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
    if (!project) throw new Error('Project not found');
    const api = window.clubhouse.agent;
    await api.updateDurableConfig(project.path, agent.id, { runtimeMode: mode });
    if (mode === 'terminal') noteExplicitTerminalChoice();
    const store = useAgentStore.getState();
    // Wait for the exit: the old process saves its session id as it exits,
    // and the respawn must resume that session, not the previous one.
    await store.killAgent(agent.id, project.path, { waitForExit: true });
    const config = await api.getDurableConfig(project.path, agent.id);
    if (!config) throw new Error('Agent config not found');
    rendererLog(SWITCH_LOG_NS, 'info', 'Runtime switch: respawning', { meta: { ...meta, resumeSessionId: config.lastSessionId ?? null } });
    await store.spawnDurableAgent(project.id, project.path, config, !!config.lastSessionId);
  } catch (err) {
    rendererLog(SWITCH_LOG_NS, 'error', 'Runtime switch failed', {
      meta: { ...meta, error: err instanceof Error ? err.message : String(err), breadcrumb: { kind: 'error', code: `runtime.switch_failed.${mode}` } },
    });
    throw err;
  }
}

interface Props {
  agent: Agent;
  /** The terminal view, rendered unchanged when the agent isn't in chat. */
  terminal: ReactNode;
  /**
   * Show the Chat / Terminal switch. Views outside the main agent pane
   * (popouts, canvas, plugins) render whichever runtime the agent is in and
   * leave switching to the main pane.
   */
  canSwitch?: boolean;
  /** Where the chat view is shown, for its behaviour and data-view-context. */
  context?: ChatViewContext;
}

/** How long the pending view stays blank before saying it's connecting, so a fast answer doesn't flash text. */
export const PENDING_NOTE_DELAY_MS = 400;

/**
 * Shown instead of the terminal while it isn't known yet whether this agent
 * runs in chat, and while the chat view loads. Blank at first, then a quiet
 * "Connecting" note if it takes a while (#2089).
 */
function RuntimePending({ agentName }: { agentName: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), PENDING_NOTE_DELAY_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="h-full bg-ctp-base flex items-center justify-center" data-testid="agent-runtime-pending" aria-busy="true">
      {slow && <span className="text-xs text-ctp-overlay1" role="status">Connecting to {agentName}…</span>}
    </div>
  );
}

export function AgentRuntimePane({ agent, terminal, canSwitch = true, context = 'main' }: Props) {
  const flag = useChatFlag();
  const info = useAgentRuntimeInfo(agent, flag === true);
  // Only a local durable agent can be in chat; everything else is the terminal from the first paint.
  const couldBeChat = agent.kind === 'durable' && !isRemoteProjectId(agent.projectId);
  // Busy in either runtime: chat from its events, the terminal from hook status.
  const chatBusy = useChatStore((s) => isRunningState(s.agents[agent.id]?.state ?? null));
  const hookState = useAgentStore((s) => s.agentDetailedStatus[agent.id]?.state);
  const terminalBusy = hookState === 'working' || hookState === 'needs_permission';
  const [switching, setSwitching] = useState(false);
  const [confirm, setConfirm] = useState<AgentRuntimeMode | null>(null);

  const doSwitch = useCallback(async (mode: AgentRuntimeMode) => {
    setConfirm(null);
    setSwitching(true);
    try {
      await switchAgentRuntime(agent, mode);
    } catch (err) {
      // telemetry-exempt: shown to the user; chat stays independent of telemetry (research §7.3), which maps chat events itself.
      useToastStore.getState().addToast(`Couldn't switch to ${mode === 'chat' ? 'Chat' : 'Terminal'}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSwitching(false);
    }
  }, [agent]);

  // The main pane always gets the toolbar and Agent details; other views show the terminal alone.
  const plainTerminal = canSwitch ? <MainTerminal agent={agent} terminal={terminal} /> : <>{terminal}</>;
  if (flag === false || !couldBeChat) return plainTerminal;
  // Flag or runtime still loading: a terminal here would flash before ChatView replaces it.
  if (flag === null || info === null) return <RuntimePending agentName={agent.name} />;

  const requestSwitch = (mode: AgentRuntimeMode) => {
    const busy = mode === 'terminal' ? chatBusy : terminalBusy;
    if (busy) setConfirm(mode);
    else void doSwitch(mode);
  };

  const confirmDialog = (
    <ConfirmDestructiveAction
      open={confirm !== null}
      title="Interrupt and switch?"
      description={`${agent.name} is working. Switching to ${confirm === 'chat' ? 'Chat' : 'the terminal'} stops the current turn, then resumes the same session there.`}
      confirmLabel="Interrupt and switch"
      onConfirm={() => { if (confirm) void doSwitch(confirm); }}
      onCancel={() => setConfirm(null)}
    />
  );

  if (info.chat) {
    return (
      <>
        <Suspense fallback={<RuntimePending agentName={agent.name} />}>
          <ChatView agent={agent} context={context} switching={switching} onSwitchToTerminal={canSwitch ? () => requestSwitch('terminal') : undefined} />
        </Suspense>
        {confirmDialog}
      </>
    );
  }

  if (!info.chatAvailable || !canSwitch) return plainTerminal;

  return (
    <>
      <MainTerminal agent={agent} terminal={terminal} runtime={{ value: 'terminal', onChange: () => requestSwitch('chat'), disabled: switching }} />
      {confirmDialog}
    </>
  );
}

/** A terminal in the main pane: the pane toolbar above it and Agent details beside it (#2032). */
function MainTerminal({ agent, terminal, runtime }: { agent: Agent; terminal: ReactNode; runtime?: { value: 'terminal'; onChange: () => void; disabled?: boolean } }) {
  const paneRef = useRef<HTMLDivElement>(null);
  // Below 640px of pane there's no room beside the terminal, so details hides.
  const paneNarrow = useNarrow(paneRef);
  const detailsOpen = useAgentDetailsStore((s) => s.open) && !paneNarrow;
  const hook = useAgentStore((s) => s.agentDetailedStatus[agent.id]);
  const review = useAgentReview(agent, `${hook?.state ?? ''}:${hook?.toolName ?? ''}:${agent.status}`);
  return (
    <div ref={paneRef} className="flex flex-col h-full" data-agent-pane={agent.id}>
      <div data-testid={runtime ? 'terminal-runtime-bar' : 'terminal-pane-bar'}>
        <TerminalPaneToolbar
          agent={agent}
          runtime={runtime}
          review={review.view}
          detailsToggle={<DetailsToggle />}
          showMenu
          showName={!isNewChromeEnabled()}
        />
      </div>
      {review.active && review.cwd && (
        <ChangesReview agentName={agent.name} cwd={review.cwd} branch={review.branch} onChanged={review.reload} />
      )}
      {/* Hidden, not unmounted, while reviewing: the terminal keeps its session and scrollback. */}
      <div className={`flex-1 min-h-0 flex ${review.active ? 'hidden' : ''}`}>
        <div className="flex-1 min-w-0 relative">{terminal}</div>
        {detailsOpen && <AgentDetails agent={agent} branch={review.branch} onReviewAll={review.cwd ? review.open : undefined} />}
      </div>
    </div>
  );
}
