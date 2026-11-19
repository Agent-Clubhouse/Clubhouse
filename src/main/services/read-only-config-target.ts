/** Private admission/final-assembly receipt, never serialized as display data. */
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import type { AgentConfigTarget } from './agent-config-reader';
import { getDispatcherAgentId, getDispatcherChatAgentId } from './dispatcher/dispatcher-service';
import { getDispatcherPath, getDispatcherChatPath } from './dispatcher/dispatcher-paths';
import { captureReadOnlyAgentTargetWitness, captureReadOnlyRoleTargetWitness } from './read-only-agent-target-witness';

export function captureReadOnlyConfigTargetWitness(target: AgentConfigTarget): { current(): boolean } {
  const roles = [
    { id: getDispatcherAgentId(), path: getDispatcherPath(), currentId: getDispatcherAgentId, currentPath: getDispatcherPath },
    { id: getDispatcherChatAgentId(), path: getDispatcherChatPath(), currentId: getDispatcherChatAgentId, currentPath: getDispatcherChatPath },
  ].filter((role) => role.id === target.agent.id);
  if (target.project.id === DISPATCHER_PROJECT_ID || roles.length) {
    if (roles.length !== 1 || target.project.id !== DISPATCHER_PROJECT_ID || roles[0].path !== target.project.path) throw new Error('Selected role identity is unavailable.');
    const role = roles[0];
    return captureReadOnlyRoleTargetWitness(target, () => role.currentId() === role.id && role.currentPath() === role.path
      && [getDispatcherAgentId(), getDispatcherChatAgentId()].filter((id) => id === role.id).length === 1);
  }
  const primary = captureReadOnlyAgentTargetWitness(target);
  return { current: () => ![getDispatcherAgentId(), getDispatcherChatAgentId()].includes(target.agent.id) && primary.current() };
}
