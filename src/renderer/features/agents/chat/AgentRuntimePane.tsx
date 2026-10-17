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
import { RuntimeSwitch } from './ChatHeader';
import { isRunningState } from './view-model';

const ChatView = lazy(() => import('./ChatView'));

let flagPromise: Promise<boolean> | null = null;

/** Same gate as main: the Chat flag only counts in preview-eligible builds. */
export function loadChatFlag(): Promise<boolean> {
  if (!flagPromise) {
    flagPromise = Promise.all([window.clubhouse.app.getExperimentalSettings(), window.clubhouse.app.isPreviewEligible()])
      .then(([s, eligible]) => s?.chat === true && eligible === true)
      .catch(() => false);
  }
  return flagPromise;
}

/** For tests and for the Experimental settings toggle. */
export function resetChatFlagCache(): void {
  flagPromise = null;
}

export function useChatFlag(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadChatFlag().then((v) => { if (!cancelled) setOn(v); });
    return () => { cancelled = true; };
  }, []);
  return on;
}

const NO_CHAT: ChatAgentRuntimeInfo = { chat: false, chatAvailable: false };

/** Which runtime the agent is in, re-checked when it starts, stops or opens a chat session. */
export function useAgentRuntimeInfo(agent: Agent, enabled: boolean): ChatAgentRuntimeInfo {
  const [info, setInfo] = useState<ChatAgentRuntimeInfo>(NO_CHAT);
  const chatSession = useChatStore((s) => s.agents[agent.id]?.sessionId ?? null);
  const remote = isRemoteProjectId(agent.projectId);
  useEffect(() => {
    if (!enabled || remote || agent.kind !== 'durable') { setInfo(NO_CHAT); return; }
    let cancelled = false;
    window.clubhouse.chat.getAgentRuntime(agent.id, agent.orchestrator)
      .then((r) => { if (!cancelled) setInfo(r ?? NO_CHAT); })
      .catch(() => { if (!cancelled) setInfo(NO_CHAT); });
    return () => { cancelled = true; };
  }, [enabled, remote, agent.id, agent.kind, agent.orchestrator, agent.status, chatSession]);
  return info;
}

/** Restart a durable agent in the other runtime, resuming its CLI session. */
export async function switchAgentRuntime(agent: Agent, mode: AgentRuntimeMode): Promise<void> {
  const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
  if (!project) throw new Error('Project not found');
  const api = window.clubhouse.agent;
  await api.updateDurableConfig(project.path, agent.id, { runtimeMode: mode });
  const store = useAgentStore.getState();
  await store.killAgent(agent.id, project.path);
  const config = await api.getDurableConfig(project.path, agent.id);
  if (!config) throw new Error('Agent config not found');
  await store.spawnDurableAgent(project.id, project.path, config, !!config.lastSessionId);
}

interface Props {
  agent: Agent;
  /** The terminal view, rendered unchanged when the agent isn't in chat. */
  terminal: ReactNode;
}

export function AgentRuntimePane({ agent, terminal }: Props) {
  const flag = useChatFlag();
  const info = useAgentRuntimeInfo(agent, flag);
  const running = useChatStore((s) => isRunningState(s.agents[agent.id]?.state ?? null));
  const [switching, setSwitching] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const doSwitch = useCallback(async (mode: AgentRuntimeMode) => {
    setConfirm(false);
    setSwitching(true);
    try {
      await switchAgentRuntime(agent, mode);
    } catch (err) {
      useToastStore.getState().addToast(`Couldn't switch to ${mode === 'chat' ? 'Chat' : 'Terminal'}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSwitching(false);
    }
  }, [agent]);

  if (!flag) return <>{terminal}</>;

  if (info.chat) {
    return (
      <>
        <Suspense fallback={<div className="h-full bg-ctp-base" />}>
          <ChatView
            agent={agent}
            switching={switching}
            onSwitchToTerminal={() => { if (running) setConfirm(true); else void doSwitch('terminal'); }}
          />
        </Suspense>
        <ConfirmDestructiveAction
          open={confirm}
          title="Interrupt and switch?"
          description={`${agent.name} is working. Switching to the terminal stops the current turn, then resumes the same session there.`}
          confirmLabel="Interrupt and switch"
          onConfirm={() => { void doSwitch('terminal'); }}
          onCancel={() => setConfirm(false)}
        />
      </>
    );
  }

  if (!info.chatAvailable) return <>{terminal}</>;

  return (
    <div className="flex flex-col h-full">
      <div className="h-8 flex-shrink-0 flex items-center justify-end px-3 border-b border-surface-0 bg-ctp-base" data-testid="terminal-runtime-bar">
        <RuntimeSwitch value="terminal" onChange={() => { void doSwitch('chat'); }} disabled={switching} />
      </div>
      <div className="flex-1 min-h-0 relative">{terminal}</div>
    </div>
  );
}
