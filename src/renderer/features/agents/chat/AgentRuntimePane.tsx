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
import { chatEventCount, useChatStore } from '../../../stores/chatStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useToastStore } from '../../../stores/toastStore';
import { isRemoteProjectId } from '../../../stores/remoteProjectStore';
import { ConfirmDestructiveAction } from '../../../components/ConfirmDestructiveAction';
import { TerminalPaneToolbar } from '../pane/AgentPaneToolbar';
import { AgentDetails } from '../details/AgentDetails';
import { HelperHeader } from '../helpers/HelperHeader';
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
import { recordBreadcrumb } from '../../../telemetry/breadcrumbs';
import { loadChatFlag, resetChatFlag, useChatFlag } from './chat-flag';

const ChatView = lazy(() => import('./ChatView'));

const SWITCH_LOG_NS = 'ui:chat:switch';

export { loadChatFlag, useChatFlag };

/** For tests and for the Experimental settings toggle. */
export function resetChatFlagCache(): void {
  resetChatFlag();
  runtimeCache.clear();
}

const NO_CHAT: ChatAgentRuntimeInfo = { chat: false, live: false, chatAvailable: false };

/** A chat runtime is running the agent now. Older answers have no `live`; their `chat` meant the same. */
export function isChatLive(info: ChatAgentRuntimeInfo): boolean {
  return info.live ?? info.chat;
}

/** Created, spawning or waking: its runtime may not have started yet. */
export function isAgentStarting(agent: Pick<Agent, 'status'>): boolean {
  return agent.status === 'creating' || agent.status === 'spawning' || agent.status === 'waking';
}

/**
 * Last known runtime per agent: a pane remounting for an agent starts from it
 * instead of NO_CHAT. `starting` records whether it was asked while the agent
 * was starting, so an answer from before a wake (terminal, since nothing ran)
 * isn't shown for the wake itself (#2206).
 */
const runtimeCache = new Map<string, { info: ChatAgentRuntimeInfo; starting: boolean }>();

function cachedInfo(agentId: string, starting: boolean): ChatAgentRuntimeInfo | null {
  const cached = runtimeCache.get(agentId);
  if (!cached || (starting && !cached.starting)) return null;
  return cached.info;
}

/**
 * Which runtime the agent is in, re-checked when it starts, stops or opens a
 * chat session. While it is starting, `chat` is the runtime it is starting
 * into. Null while the first answer for an eligible agent is pending.
 *
 * Live chat events outrank a "not chat" answer (#2218): an answer that crossed
 * chat events in flight is asked again rather than shown, and chat events
 * arriving while the pane shows the terminal ask again. Main can briefly say
 * "not chat" while a chat runtime swaps sessions, and nothing else would ask
 * again once the swap finished.
 */
export function useAgentRuntimeInfo(agent: Agent, enabled: boolean): ChatAgentRuntimeInfo | null {
  const starting = isAgentStarting(agent);
  // Tagged with the agent id, so a result for a different agent is never shown,
  // and with whether it was set for an eligible agent, so the NO_CHAT set
  // before the flag loaded is never returned once it has (#2206).
  const [entry, setEntry] = useState<{ agentId: string; eligible: boolean; info: ChatAgentRuntimeInfo | null }>(() => ({ agentId: agent.id, eligible: true, info: cachedInfo(agent.id, starting) }));
  const chatSession = useChatStore((s) => s.agents[agent.id]?.sessionId ?? null);
  // A chat runtime runs it, as far as this window's chat events (or main's last answer) say.
  const chatLive = useChatStore((s) => s.live[agent.id] === true);
  const [recheck, setRecheck] = useState(0);
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.id === agent.projectId)?.path);
  const remote = isRemoteProjectId(agent.projectId);
  const eligible = enabled && !remote && agent.kind === 'durable';
  useEffect(() => {
    if (!eligible) { setEntry({ agentId: agent.id, eligible: false, info: NO_CHAT }); return; }
    // Drop a NO_CHAT left from before the flag loaded: until the answer comes, it's the last known runtime or unknown.
    setEntry((prev) => {
      const info = cachedInfo(agent.id, starting);
      return prev.agentId === agent.id && prev.eligible && prev.info === info ? prev : { agentId: agent.id, eligible: true, info };
    });
    let cancelled = false;
    const eventsBefore = chatEventCount(agent.id);
    const apply = (info: ChatAgentRuntimeInfo) => {
      if (cancelled) return;
      if (!info.chat && chatEventCount(agent.id) !== eventsBefore && useChatStore.getState().live[agent.id] === true) {
        // Chat events arrived while this answer was in flight and say chat runs
        // the agent: the answer is older than them. Ask again, keeping the view.
        setRecheck((n) => n + 1);
        return;
      }
      runtimeCache.set(agent.id, { info, starting });
      // Status surfaces overlay chat state only while chat runs the agent (#2208),
      // not while it is only starting into chat.
      useChatStore.getState().setRuntimeLive(agent.id, isChatLive(info));
      setEntry({ agentId: agent.id, eligible: true, info });
    };
    window.clubhouse.chat.getAgentRuntime(agent.id, agent.orchestrator, { projectPath, starting })
      .then((r) => apply(r ?? NO_CHAT))
      .catch(() => apply(NO_CHAT));
    return () => { cancelled = true; };
  }, [eligible, agent.id, agent.orchestrator, agent.status, chatSession, projectPath, starting, recheck]);
  const showsTerminal = eligible && entry.agentId === agent.id && entry.eligible && entry.info?.chat === false;
  useEffect(() => {
    // Chat events after a "not chat" answer: chat runs it now, so ask again.
    if (showsTerminal && chatLive) setRecheck((n) => n + 1);
  }, [showsTerminal, chatLive]);
  if (!eligible) return NO_CHAT;
  if (entry.agentId !== agent.id || !entry.eligible) return cachedInfo(agent.id, starting);
  return entry.info;
}

/** Restart a durable agent in the other runtime, resuming its CLI session. */
export async function switchAgentRuntime(agent: Agent, mode: AgentRuntimeMode): Promise<void> {
  const meta = { agentId: agent.id, to: mode };
  // Breadcrumbs land on feedback reports (#2098): the mode only, never ids.
  recordBreadcrumb('event', `runtime.switch.${mode}`);
  rendererLog(SWITCH_LOG_NS, 'info', 'Runtime switch requested', { meta });
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
    recordBreadcrumb('error', `runtime.switch_failed.${mode}`);
    rendererLog(SWITCH_LOG_NS, 'error', 'Runtime switch failed', {
      meta: { ...meta, error: err instanceof Error ? err.message : String(err) },
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
    // Waking into chat: wait for the chat runtime rather than show the terminal or a chat it can't take yet.
    if (!isChatLive(info) && isAgentStarting(agent)) return <RuntimePending agentName={agent.name} />;
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
      <HelperHeader agent={agent} />
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
