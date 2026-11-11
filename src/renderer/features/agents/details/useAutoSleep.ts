import { useEffect, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import { normalizeIdleSleep, type AgentIdleSleep } from '../../../../shared/idle-sleep';
import type { ChatViewState } from '../../../stores/chatStore';
import { isRemoteProjectId } from '../../../stores/remoteProjectStore';
import { useChatFlag } from '../chat/chat-flag';
import { useEffectiveOrchestrator } from '../effective-orchestrator';
import { autoSleepSummary, useAppIdleMinutes } from './AutoSleepRow';
import { useDurableConfig } from './useDurableConfig';

export function useAutoSleep(agent: Agent, chat: ChatViewState | undefined, projectPath: string | undefined) {
  const local = agent.kind === 'durable' && !isRemoteProjectId(agent.projectId) && !!projectPath;
  const { config, loaded, update } = useDurableConfig(local ? projectPath : undefined, agent.id);
  const asleep = agent.status === 'sleeping' || agent.status === 'error';
  const orchestrator = useEffectiveOrchestrator(agent);
  const chatFlag = useChatFlag();
  const appMinutes = useAppIdleMinutes();
  const runtimeMode = config?.runtimeMode;
  const key = `${agent.id}\n${orchestrator}`;
  const [runtime, setRuntime] = useState<{ key: string; value: Awaited<ReturnType<typeof window.clubhouse.chat.getAgentRuntime>> } | null>(null);
  useEffect(() => {
    if (!asleep || !local || chatFlag !== true) return;
    let alive = true;
    window.clubhouse.chat.getAgentRuntime(agent.id, orchestrator, { projectPath, starting: true }).then(
      (value) => { if (alive) setRuntime({ key, value }); },
      // telemetry-exempt: the runtime stays unknown and its control remains hidden.
      () => { if (alive) setRuntime(null); },
    );
    return () => { alive = false; };
  }, [agent.id, asleep, local, chatFlag, orchestrator, projectPath, runtimeMode, key]);
  const nextRuntime = runtime?.key === key ? runtime.value : null;
  const runsIn: 'Chat' | 'CLI' | null = !asleep ? (chat ? 'Chat' : 'CLI')
    : !local ? null
      : chatFlag === false ? 'CLI'
        : nextRuntime ? (nextRuntime.chat ? 'Chat' : 'CLI')
          : runtimeMode === 'chat' ? 'Chat' : runtimeMode === 'terminal' ? 'CLI' : null;
  const showAutoSleep = local && (asleep ? runsIn === 'Chat' : !!chat);
  const idle = loaded ? normalizeIdleSleep(config?.idleSleep) : null;
  return {
    config, loaded, update, runsIn, showAutoSleep, idle, chatFlag, nextRuntime,
    summary: showAutoSleep && idle !== null ? autoSleepSummary(idle, appMinutes) : null,
    onChange: (next: AgentIdleSleep) => update({ idleSleep: next === 'inherit' ? null : next }),
  };
}
