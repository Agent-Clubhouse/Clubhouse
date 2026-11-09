/**
 * What a plugin may do for the agent whose tool call it is answering
 * (D126, #3168). A plugin acts for the person from its own view; while it
 * answers an agent's call, it can't do for that agent what the agent's own
 * calls couldn't: changing a project's agent defaults needs the agent's
 * `project.configure` on that project, and resuming an agent needs its
 * `agent.wake` on it. Each is checked as the agent's own call would be,
 * targets resolved the same way. Ask first counts as no: the plugin's change
 * can't wait for the user's answer.
 */

import type { ToolGrantDeclaration } from './tool-grants';
import { resolveArgTargets } from './arg-targets';
import { checkToolGrant } from './grant-check';
import { agentOfPluginCall } from './plugin-tool-registry';

export type PluginCallerCheck =
  | { kind: 'wake'; agentId: string }
  | { kind: 'project_defaults'; projectPath: string };

const WAKE: ToolGrantDeclaration = { actions: ['agent.wake'], target: 'agent_arg', from: { args: ['agent'] } };
const DEFAULTS: ToolGrantDeclaration = { actions: ['project.configure'], target: 'project_arg', from: { args: ['project'] } };

/** Null when the agent behind `callId` may, else why not, for the plugin to throw. */
export async function checkPluginCaller(pluginId: string, callId: string, check: PluginCallerCheck): Promise<string | null> {
  const agentId = agentOfPluginCall(callId, pluginId);
  // The call was answered or timed out: what the plugin does now isn't for that agent, but the
  // plugin still treats it as open, so it fails closed rather than act with no one to check.
  if (!agentId) return 'The agent\'s tool call this plugin was answering is over, so this can\'t run for it.';
  const declaration = check.kind === 'wake' ? WAKE : DEFAULTS;
  const args = check.kind === 'wake' ? { agent: check.agentId } : { project: check.projectPath };
  const targets = await resolveArgTargets(agentId, declaration, args);
  // Something the agent can't name is something it can't reach.
  if (!targets.get(declaration)?.length) return check.kind === 'wake' ? 'The calling agent can\'t wake that agent.' : 'The calling agent can\'t change that project\'s agent defaults.';
  const result = checkToolGrant(agentId, declaration, args, undefined, targets);
  if (!('reason' in result)) return null;
  const what = check.kind === 'wake' ? 'wake that agent' : 'change that project\'s agent defaults';
  if (result.reason === 'ask_first') {
    return `The calling agent's Clubhouse permission to ${what} is set to Ask first, and a plugin's change for it can't wait for an answer. Ask the user.`;
  }
  return `A plugin can't do for an agent what the agent can't: ${result.message}`;
}
