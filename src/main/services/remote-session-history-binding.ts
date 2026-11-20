/** Optional positive history receipt; never changes ordinary/Quick/controller grants. */
import type { AgentRuntime } from '../../shared/chat';
import { isChatDetailsEvidence } from '../../shared/chat/details-evidence';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { isRemoteSessionHistoryBinding, sameRemoteSessionHistoryBinding, type RemoteSessionHistoryBinding } from '../../shared/remote-session-history';
import type { AgentConfigTarget } from './agent-config-reader';
import { captureReadOnlyAgentTargetWitness } from './read-only-agent-target-witness';
import { isDispatcherIdentityAgentId } from './dispatcher/dispatcher-service';
import { agentRegistry } from './agent-registry';
import { getAgentRuntime } from './agent-runtime';

export function captureRemoteSessionHistoryBinding(target: AgentConfigTarget, runtime: AgentRuntime, authorized: () => boolean): { value: RemoteSessionHistoryBinding; current(): boolean } | undefined {
  if (!authorized() || target.project.id === DISPATCHER_PROJECT_ID || isDispatcherIdentityAgentId(target.agent.id)
    || isDisposedAgent(target.agent) || runtime.kind !== 'chat') return undefined;
  const registration = agentRegistry.get(target.agent.id);
  if (!registration || registration.runtime !== 'chat' || registration.projectPath !== target.project.path || !registration.nonce) return undefined;
  const nonce = registration.nonce, provider = registration.orchestrator, cwd = registration.cwd;
  const read = (): RemoteSessionHistoryBinding | undefined => {
    if (!authorized() || getAgentRuntime(target.agent.id) !== runtime || !runtime.isRunning() || ['sleeping', 'error'].includes(runtime.getState())) return undefined;
    const current = agentRegistry.get(target.agent.id);
    if (current !== registration || current.nonce !== nonce || current.runtime !== 'chat' || current.orchestrator !== provider
      || current.projectPath !== target.project.path || current.cwd !== cwd) return undefined;
    const evidence = runtime.getDetailsEvidence?.();
    if (!isChatDetailsEvidence(evidence) || evidence.agentId !== target.agent.id || evidence.providerId !== provider
      || evidence.sessionId !== runtime.getSessionId?.() || evidence.nativeSessionId !== runtime.getNativeSessionId?.()
      || evidence.runId !== runtime.getDisplayRunId?.()) return undefined;
    const value = { version: 1 as const, projectId: target.project.id, agentId: target.agent.id, sessionId: evidence.sessionId,
      providerId: evidence.providerId, driver: evidence.driver, nativeSessionId: evidence.nativeSessionId,
      displayRunId: evidence.runId, startSeq: evidence.startSeq, subagents: runtime.getCapabilities?.()?.subagents };
    return isRemoteSessionHistoryBinding(value) ? value : undefined;
  };
  try {
    const value = read();
    if (!value) return undefined;
    const witness = captureReadOnlyAgentTargetWitness(target);
    return { value, current: () => {
      const current = read();
      return !!current && sameRemoteSessionHistoryBinding(value, current) && witness.current() && authorized();
    } };
  } catch { return undefined; /* telemetry-exempt: missing/unsafe primary identity withholds optional history binding */ }
}
