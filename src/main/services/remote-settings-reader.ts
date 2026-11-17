/** Read-only, single-agent host scope for the same member path as read_agent_config (#3656). */
import { resolveAgentConfigTarget } from './agent-config-reader';
import { listSettings, readSettings, SettingsReadError, type SettingsActor } from './settings-read-service';

export async function readRemoteSettings(targetId: string, tool: 'list_settings' | 'read_settings', args: Record<string, unknown>): Promise<unknown> {
  const keys = tool === 'list_settings' ? [] : ['select', 'detail', 'limit', 'cursor'];
  if (Object.keys(args).some((key) => !keys.includes(key))) throw new SettingsReadError('invalid', 'Remote settings reads accept one target and no project or bulk scope.');
  const target = await resolveAgentConfigTarget(targetId);
  const actor: SettingsActor = { scope: 'own', agentId: target.agent.id, projectPath: target.project.path };
  if (tool === 'list_settings') return listSettings(actor);
  if (!Array.isArray(args.select) || args.select.some((key) => typeof key !== 'string')
    || args.detail !== undefined && typeof args.detail !== 'boolean'
    || args.limit !== undefined && typeof args.limit !== 'number'
    || args.cursor !== undefined && typeof args.cursor !== 'string') throw new SettingsReadError('invalid', 'Invalid settings read arguments.');
  return readSettings(actor, {
    select: args.select as string[], detail: args.detail as boolean | undefined,
    limit: args.limit as number | undefined, cursor: args.cursor as string | undefined,
  });
}
