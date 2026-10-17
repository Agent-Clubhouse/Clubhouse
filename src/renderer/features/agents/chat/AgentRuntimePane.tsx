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

import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Agent } from '../../../../shared/types';
import type { AgentRuntimeMode, ChatAgentRuntimeInfo } from '../../../../shared/chat';
import { useChatStore } from '../../../stores/chatStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useToastStore } from '../../../stores/toastStore';
import { isRemoteProjectId } from '../../../stores/remoteProjectStore';
import { ConfirmDestructiveAction } from '../../../components/ConfirmDestructiveAction';
import { TerminalPaneToolbar } from '../pane/AgentPaneToolbar';
import { useAgentRowActions } from '../useAgentRowActions';
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
    rendererLog(SWITCH_LOG_NS, 'error', 'Runtime switch failed', { meta: { ...meta, error: err instanceof Error ? err.message : String(err) } });
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

/** Shown instead of the terminal while it isn't known yet whether this agent runs in chat. */
function RuntimePending() {
  return <div className="h-full bg-ctp-base" data-testid="agent-runtime-pending" aria-busy="true" />;
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
  const rowActions = useAgentRowActions(agent);

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

  if (flag === false || !couldBeChat) return <>{terminal}</>;
  // Flag or runtime still loading: a terminal here would flash before ChatView replaces it.
  if (flag === null || info === null) return <RuntimePending />;

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
        <Suspense fallback={<div className="h-full bg-ctp-base" />}>
          <ChatView agent={agent} context={context} switching={switching} onSwitchToTerminal={canSwitch ? () => requestSwitch('terminal') : undefined} />
        </Suspense>
        {confirmDialog}
      </>
    );
  }

  if (!info.chatAvailable || !canSwitch) return <>{terminal}</>;

  return (
    <div className="flex flex-col h-full">
      <div data-testid="terminal-runtime-bar">
        <TerminalPaneToolbar
          agent={agent}
          runtime={{ value: 'terminal', onChange: () => requestSwitch('chat'), disabled: switching }}
          actions={context === 'main' ? rowActions : undefined}
        />
      </div>
      <div className="flex-1 min-h-0 relative">{terminal}</div>
      {confirmDialog}
    </div>
  );
}
