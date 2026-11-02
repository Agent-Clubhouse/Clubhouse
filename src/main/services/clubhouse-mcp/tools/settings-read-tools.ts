/**
 * Settings read tools (#2653): list_settings and read_settings, for every
 * agent, in no tool group. The allowlist and the scope live in
 * settings-read-service; these only say who is asking and turn arguments and
 * refusals into tool results. Which agent may read what is decided on each
 * call, so a CLI that keeps its first tool list (ignoresToolListChanged) is no
 * different, and a Dispatcher turned off drops to its own scope at once.
 */

import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { isDispatcherAgent } from '../dispatcher-gate';
import { agentRegistry } from '../../agent-registry';
import { appLog } from '../../log-service';
import { listSettings, readSettings, SettingsReadError, type SettingsActor } from '../../settings-read-service';
import { McpArgError, optionalBoolean, optionalNumber, optionalString } from './validation';

function actorFor(agentId: string): SettingsActor {
  if (isDispatcherAgent(agentId)) return { scope: 'all', agentId };
  const projectPath = agentRegistry.get(agentId)?.projectPath;
  if (!projectPath) throw new SettingsReadError('not_found', 'Clubhouse doesn\'t know this agent.');
  return { scope: 'own', agentId, projectPath };
}

function stringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new McpArgError(`${key} must be a list of strings.`);
  return value as string[];
}

async function guarded(tool: string, agentId: string, run: () => unknown): Promise<McpToolResult> {
  try {
    // Compact: every agent pays for this output in tokens.
    return { content: [{ type: 'text', text: JSON.stringify(await run()) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof SettingsReadError || err instanceof McpArgError)) {
      // telemetry-exempt: logged; the error reaches the agent as the tool result
      appLog('core:mcp', 'warn', `${tool} failed`, { meta: { agentId, error: message } });
    }
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

const READ_ARGS = ['select', 'agent_ids', 'project', 'all_agents', 'all_projects', 'limit', 'cursor', 'detail'];

export function registerSettingsReadTools(): void {
  registerGlobalTool(
    'list_settings',
    {
      description: 'List the settings sections and keys you can read with read_settings. Names only.',
      inputSchema: { type: 'object', properties: {} },
    },
    (agentId) => guarded('list_settings', agentId, () => listSettings(actorFor(agentId))),
  );

  registerGlobalTool(
    'read_settings',
    {
      description:
        'Read settings by section or key: each effective value and its source. Changes nothing. ' +
        'You can read yourself, your project and app defaults; the Dispatcher can read any agent or project.',
      inputSchema: {
        type: 'object',
        properties: {
          select: { type: 'array', items: { type: 'string' }, description: 'Sections or keys from list_settings.' },
          agent_ids: { type: 'array', items: { type: 'string' }, description: 'Defaults to you.' },
          project: { type: 'string', description: 'Name, path or id. Defaults to your own.' },
          all_agents: { type: 'boolean', description: 'Every agent in project.' },
          all_projects: { type: 'boolean' },
          limit: { type: 'number', description: 'Targets per page: up to 25, default 10.' },
          cursor: { type: 'string', description: 'next_cursor from the last page.' },
          detail: { type: 'boolean', description: 'Add stored values.' },
        },
        required: ['select'],
      },
    },
    (agentId, args) => guarded('read_settings', agentId, () => {
      const unknown = Object.keys(args).filter((key) => !READ_ARGS.includes(key));
      if (unknown.length > 0) throw new McpArgError(`read_settings doesn't take ${unknown.join(', ')}.`);
      return readSettings(actorFor(agentId), {
        select: stringList(args, 'select') ?? [],
        agentIds: stringList(args, 'agent_ids'),
        project: optionalString(args, 'project'),
        allAgents: optionalBoolean(args, 'all_agents'),
        allProjects: optionalBoolean(args, 'all_projects'),
        limit: optionalNumber(args, 'limit'),
        cursor: optionalString(args, 'cursor'),
        detail: optionalBoolean(args, 'detail'),
      });
    }),
  );
}
