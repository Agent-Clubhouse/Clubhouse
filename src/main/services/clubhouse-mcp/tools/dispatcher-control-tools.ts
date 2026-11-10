/**
 * Dispatcher controls (#2661): a connected orchestrator's helper settings, and
 * direct links between agents (#3248), in the `dispatcher` tool group: listed and callable only by the running Dispatcher. The rules live
 * in dispatcher-controls; these only say who is asking and turn refusals into
 * tool results.
 */

import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';
import {
  DEFAULT_CONTROLS_PAGE,
  DispatcherControlError,
  MAX_CONTROLS_PAGE,
  CONNECTION_SWITCH_NAMES,
  connectOrchestrators,
  disconnectOrchestrators,
  listOrchestratorControls,
  setConnectionToolsForLink,
  setOrchestratorHelpers,
} from '../../dispatcher-controls';

type Handler = (agentId: string, args: Record<string, unknown>) => Promise<unknown>;

function guarded(tool: string, run: Handler): (agentId: string, args: Record<string, unknown>) => Promise<McpToolResult> {
  return async (agentId, args) => {
    try {
      // Compact: readback stays small.
      return { content: [{ type: 'text', text: JSON.stringify(await run(agentId, args)) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof DispatcherControlError)) {
        // telemetry-exempt: logged; the error reaches the Dispatcher as the tool result
        appLog('core:mcp', 'warn', `${tool} failed`, { meta: { agentId, error: message } });
      }
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  };
}

const LINK_PROPERTIES = {
  from: { type: 'string', description: 'The agent that gets the tools, by id from list_agents.' },
  to: { type: 'string', description: 'The agent it reaches, by id from list_agents.' },
  two_way: { type: 'boolean', description: 'Both directions, all or nothing. Default false.' },
};

const ALLOW_DESCRIPTION = `Tool names from: ${CONNECTION_SWITCH_NAMES.join(', ')}.`;

/** The tools to allow on each direction (#3215). */
const ALLOW_PROPERTIES = {
  allow: { type: 'array', items: { type: 'string', enum: [...CONNECTION_SWITCH_NAMES] }, description: `What \`from\` may use on \`to\`; every other tool is off. ${ALLOW_DESCRIPTION}` },
  allow_back: { type: 'array', items: { type: 'string', enum: [...CONNECTION_SWITCH_NAMES] }, description: `With two_way: what \`to\` may use on \`from\`. Default: the same as allow. ${ALLOW_DESCRIPTION}` },
};

export function registerDispatcherControlTools(): void {
  const options = { group: 'dispatcher' as const };

  registerGlobalTool(
    'set_orchestrator_helpers',
    {
      description:
        'Set a connected orchestrator\'s cross-project helpers switch and helper cap. No helper is stopped: ' +
        'a cap below its live helpers returns helpersOverCap and refuses new starts until the count drops. ' +
        'Orchestration, Connect to Dispatcher, access and approvals are the user\'s and can\'t be changed here.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'A connected orchestrator\'s id, from list_agents.' },
          cross_project_helpers: { type: 'boolean' },
          max_helpers: { type: 'number', description: 'Whole number from 1 to the app-wide helper cap.' },
        },
        required: ['agent_id'],
      },
    },
    guarded('set_orchestrator_helpers', setOrchestratorHelpers),
    { ...options, grant: { actions: ['agent.configure'], target: 'agent_arg', from: { args: ['agent_id'] } } },
  );

  registerGlobalTool(
    'connect_orchestrators',
    {
      description:
        'Link two agents directly, so `from` gets tools to message and check on `to`. Each end must be a durable agent ' +
        'connected to you, not a helper; it doesn\'t need to orchestrate. The link is ' +
        'saved as yours. It is refused if they are already connected some other way, or if the user removed the link. ' +
        'A new link can read status and output, send messages and files, and wake; clear_agent and compact_agent stay off ' +
        'unless you name them in allow. Tools the user already set on a direction are kept, and naming tools for it is refused. ' +
        'Each link in the result reads back its tools: allowed, disabled, and tools_yours (whether set_connection_tools can change them).',
      inputSchema: { type: 'object', properties: { ...LINK_PROPERTIES, ...ALLOW_PROPERTIES }, required: ['from', 'to'] },
    },
    guarded('connect_orchestrators', connectOrchestrators),
    { ...options, grant: { actions: ['connection.manage'], target: 'agent_arg', from: { args: ['from', 'to'] } } },
  );

  registerGlobalTool(
    'disconnect_orchestrators',
    {
      description:
        'Remove a link you made with connect_orchestrators. Links the user made and your own wires can\'t be removed here.',
      inputSchema: { type: 'object', properties: LINK_PROPERTIES, required: ['from', 'to'] },
    },
    guarded('disconnect_orchestrators', disconnectOrchestrators),
    { ...options, grant: { actions: ['connection.manage'], target: 'agent_arg' } },
  );

  registerGlobalTool(
    'set_connection_tools',
    {
      description:
        'Set the tools on a link you made with connect_orchestrators: each direction gets exactly the tools in allow. ' +
        'Refused for a link you didn\'t make, and for a direction the user set tools on or also connects another way; ' +
        'nothing changes then. Sleep is never a connection tool. Returns each direction read back.',
      inputSchema: { type: 'object', properties: { ...LINK_PROPERTIES, ...ALLOW_PROPERTIES }, required: ['from', 'to', 'allow'] },
    },
    guarded('set_connection_tools', setConnectionToolsForLink),
    { ...options, grant: { actions: ['connection.manage'], target: 'agent_arg', from: { args: ['from', 'to'] } } },
  );

  registerGlobalTool(
    'list_orchestrator_controls',
    {
      description:
        'Read connected orchestrators\' helper settings, the links you made with their status and tools, and optionally your recent ' +
        'audit rows. A suspended link has an end that is no longer connected to you, and returns when it is connected again.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Just this agent and its links. Any agent connected to you; its helper settings show only if it orchestrates.' },
          limit: { type: 'number', description: `Orchestrators per page: up to ${MAX_CONTROLS_PAGE}, default ${DEFAULT_CONTROLS_PAGE}.` },
          cursor: { type: 'string', description: 'next_cursor from the last page.' },
          audit: { type: 'number', description: 'Newest audit rows to add: 0 to 50, default 0.' },
        },
      },
    },
    guarded('list_orchestrator_controls', listOrchestratorControls),
    { ...options, grant: { actions: ['agent.read'], target: 'connected' } },
  );
}
