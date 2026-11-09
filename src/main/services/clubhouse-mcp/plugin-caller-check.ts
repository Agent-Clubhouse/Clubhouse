/**
 * What a plugin may do for the agent whose tool call it is answering
 * (D126, #3168, #3174). A plugin acts for the person from its own view; while
 * it answers an agent's call, it can't do for that agent what the agent's own
 * calls couldn't. The plugin API declares, per method, the grant a change
 * needs (renderer plugin-api-grants.ts); this checks one such grant for the
 * agent behind the call, as the agent's own call would be checked, its target
 * resolved the same way. Ask first counts as no: the plugin's change can't
 * wait for the user's answer.
 *
 * A group project's admin holds wake, sleep, message and reset on its members
 * (default grants); the plugin API has no group project to name, so an agent
 * the caller administers a group project with counts as its member here, as
 * the group project's own tools would see it.
 */

import { GRANT_ACTIONS, type GrantAction, type GrantCallTarget } from '../../../shared/agent-grants';
import { isProjectAdmin } from '../../../shared/group-project-admin';
import type { ToolGrantDeclaration } from './tool-grants';
import { resolveArgTargets } from './arg-targets';
import { bindingManager } from './binding-manager';
import { checkToolGrant } from './grant-check';
import { agentOfPluginCall } from './plugin-tool-registry';
import { groupProjectRegistry } from '../group-project-registry';

export type PluginCallerCheck =
  | { action: GrantAction; agentId: string }
  | { action: GrantAction; projectPath: string };

export function isPluginCallerCheck(value: unknown): value is PluginCallerCheck {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.action !== 'string' || !(GRANT_ACTIONS as readonly string[]).includes(v.action)) return false;
  return (typeof v.agentId === 'string') !== (typeof v.projectPath === 'string');
}

/** Main settled the call (answered, timed out, tools removed): what the plugin does now isn't for that agent. */
export const CALL_OVER = 'The agent\'s tool call this plugin was answering is over, so this can\'t run for it.';

/** Whether `callerId` administers a group project `agentId` is a member of. */
function administersGroupWith(callerId: string, agentId: string): boolean {
  const all = bindingManager.getAllBindings();
  return all.some((b) => b.agentId === callerId && b.targetKind === 'group-project'
    && isProjectAdmin(groupProjectRegistry.getSync(b.targetId)?.metadata, callerId)
    && all.some((m) => m.targetKind === 'group-project' && m.targetId === b.targetId && m.agentId === agentId));
}

/** Null when the agent behind `callId` may, else why not, for the plugin to throw. */
export async function checkPluginCaller(pluginId: string, callId: string, check: PluginCallerCheck): Promise<string | null> {
  const agentId = agentOfPluginCall(callId, pluginId);
  // The call was answered or timed out: what the plugin does now isn't for that agent.
  if (!agentId) return CALL_OVER;
  const onAgent = 'agentId' in check;
  const declaration: ToolGrantDeclaration = onAgent
    ? { actions: [check.action], target: 'agent_arg', from: { args: ['agent'] } }
    : { actions: [check.action], target: 'project_arg', from: { args: ['project'] } };
  const args = onAgent ? { agent: check.agentId } : { project: check.projectPath };
  const targets = await resolveArgTargets(agentId, declaration, args);
  const resolved = targets.get(declaration);
  // Something the agent can't name is something it can't reach.
  if (!resolved?.length) return onAgent ? 'The calling agent can\'t reach that agent.' : 'The calling agent can\'t reach that project.';
  if (onAgent && administersGroupWith(agentId, check.agentId)) {
    targets.set(declaration, resolved.map((t): GrantCallTarget => ({ ...t, relations: [...(t.relations ?? []), 'group_member'] })));
  }
  const result = checkToolGrant(agentId, declaration, args, undefined, targets);
  if (!('reason' in result)) return null;
  if (result.reason === 'ask_first') {
    return `The calling agent's Clubhouse permission ${check.action} is set to Ask first, and a plugin acting for it can't wait for an answer. Ask the user.`;
  }
  return `A plugin can't do for an agent what the agent can't: ${result.message}`;
}
