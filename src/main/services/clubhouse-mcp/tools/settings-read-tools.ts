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
import { forwardAgentCall, remoteMachineOf } from '../../annex-agent-calls';

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

async function guarded(tool: string, agentId: string, run: () => unknown, forwarded = false): Promise<McpToolResult> {
  try {
    // Compact: every agent pays for this output in tokens.
    const result = await run();
    return forwarded ? result as McpToolResult : { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
      description: 'List readable settings sections and keys. Names only. agent may be agentId@machine for a single remote target.',
      inputSchema: { type: 'object', properties: { agent: { type: 'string' } } },
    },
    (agentId, args) => guarded('list_settings', agentId, () => {
      if (Object.keys(args).some((key) => key !== 'agent')) throw new McpArgError('list_settings takes only agent.');
      const target = optionalString(args, 'agent');
      return target && remoteMachineOf(target) ? forwardAgentCall(agentId, target, 'That agent', 'list_settings', {}) : listSettings(actorFor(agentId));
    }, typeof args.agent === 'string' && !!remoteMachineOf(args.agent)),
    { grant: [{ actions: ['agent.read'], target: 'agent_arg', allowRemote: true, strictTargets: true, from: { args: ['agent'], missing: 'caller', names: 'registered' } }, { actions: ['settings.app.read'], target: 'app' }] },
  );

  registerGlobalTool(
    'read_settings',
    {
      description:
        'Read effective settings and sources by key. No changes. Local scope: self/project/app defaults (Dispatcher: all). One agentId@machine in agent_ids uses host agent.read and read rules.',
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
    async (agentId, args) => {
      const ids = Array.isArray(args.agent_ids) ? args.agent_ids : [];
      if (ids.some((id) => typeof id === 'string' && remoteMachineOf(id))) {
        return guarded('read_settings', agentId, async () => {
          if (ids.length !== 1 || typeof ids[0] !== 'string' || Object.keys(args).some((key) => !['agent_ids', 'select', 'detail', 'limit', 'cursor'].includes(key))) {
            throw new McpArgError('Remote settings reads take one agent_ids address and no project or bulk scope.');
          }
          const { agent_ids: _ids, ...read } = args;
          return forwardAgentCall(agentId, ids[0], 'That agent', 'read_settings', read);
        }, true);
      }
      return guarded('read_settings', agentId, () => {
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
      });
    },
    { grant: [{ actions: ['agent.read'], target: 'agent_arg', allowRemote: true, strictTargets: true, from: { args: ['agent_ids'], project: 'project', missing: 'caller', all: 'all_agents' } }, { actions: ['project.read'], target: 'project_arg', from: { args: ['project'], missing: 'caller', all: 'all_projects' } }, { actions: ['settings.app.read'], target: 'app' }] },
  );
}
