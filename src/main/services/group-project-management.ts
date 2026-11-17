/** Shared management entry points for the directory and MCP (#3617). */
import type { GroupProjectCreateOptions } from '../../shared/group-project-types';
import { groupProjectHost } from './group-project-host';
import { beginAutoJoin, releaseMembershipBindings } from './group-project-membership';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { createLocalGroupProjectDeleteService } from './group-project-delete-service';
import { flushOpenCanvases } from './canvas-flush';
import * as annexEventBus from './annex-event-bus';

export async function createManagedGroupProject(name: string, options?: GroupProjectCreateOptions) {
  const project = await groupProjectHost.create(name, options);
  await beginAutoJoin(project.id);
  annexEventBus.emitGroupProjectChanged('created', project);
  return project;
}

/** Tokens are scoped to a renderer sender id or an MCP agent identity. */
export const groupProjectDeletion = createLocalGroupProjectDeleteService((id) => {
  releaseMembershipBindings(id);
  for (const binding of bindingManager.getAllBindings()) {
    if (binding.targetKind === 'group-project' && binding.targetId === id) bindingManager.unbind(binding.agentId, id);
  }
});

export async function previewGroupProjectDeletion(id: string, caller: number | string) {
  const flushed = await flushOpenCanvases();
  const impact = await groupProjectDeletion.preview(id, caller);
  return { ...impact, incompleteWindows: !flushed.complete };
}
