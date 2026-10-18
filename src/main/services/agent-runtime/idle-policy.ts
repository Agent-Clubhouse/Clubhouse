/**
 * Whether a chat agent may idle-sleep right now (#2104). An agent bound to a
 * group project with polling on is waiting for board posts, which only reach
 * it when it polls: sleeping it would drop it out of the project.
 */
import { bindingManager } from '../clubhouse-mcp/binding-manager';
import { groupProjectRegistry } from '../group-project-registry';

export function waitsOnPollingGroupProject(agentId: string): boolean {
  return bindingManager.getBindingsForAgent(agentId).some((b) =>
    b.targetKind === 'group-project' && !!groupProjectRegistry.getSync(b.targetId)?.metadata?.pollingEnabled);
}
