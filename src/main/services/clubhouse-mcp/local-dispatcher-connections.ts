import { bindingManager } from './binding-manager';
import { isDispatcherCoordinatorId } from './dispatcher-gate';

export function callerConnectedToLocalDispatcher(agentId: string): boolean {
  return bindingManager.getBindingsForAgent(agentId).some((binding) =>
    binding.targetKind === 'agent' && isDispatcherCoordinatorId(binding.targetId));
}
