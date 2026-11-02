/**
 * Dispatcher controls over connected orchestrators (#2661), in the `dispatcher`
 * tool group: listed and callable only by the running Dispatcher. The rules live
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
  connectOrchestrators,
  disconnectOrchestrators,
  listOrchestratorControls,
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
  from: { type: 'string', description: 'The orchestrator that gets the tools, by id from list_agents.' },
  to: { type: 'string', description: 'The orchestrator it reaches, by id from list_agents.' },
  two_way: { type: 'boolean', description: 'Both directions, all or nothing. Default false.' },
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
    options,
  );

  registerGlobalTool(
    'connect_orchestrators',
    {
      description:
        'Connect two connected orchestrators directly, so `from` gets tools to message and check on `to`. The link is ' +
        'saved as yours. It is refused if they are already connected some other way, or if the user removed the link.',
      inputSchema: { type: 'object', properties: LINK_PROPERTIES, required: ['from', 'to'] },
    },
    guarded('connect_orchestrators', connectOrchestrators),
    options,
  );

  registerGlobalTool(
    'disconnect_orchestrators',
    {
      description:
        'Remove a link you made with connect_orchestrators. Links the user made and your own wires can\'t be removed here.',
      inputSchema: { type: 'object', properties: LINK_PROPERTIES, required: ['from', 'to'] },
    },
    guarded('disconnect_orchestrators', disconnectOrchestrators),
    options,
  );

  registerGlobalTool(
    'list_orchestrator_controls',
    {
      description:
        'Read connected orchestrators\' helper settings, the links you made with their status, and optionally your recent ' +
        'audit rows. A suspended link has an end that stopped being a connected orchestrator, and returns when it qualifies again.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Just this orchestrator and its links.' },
          limit: { type: 'number', description: `Orchestrators per page: up to ${MAX_CONTROLS_PAGE}, default ${DEFAULT_CONTROLS_PAGE}.` },
          cursor: { type: 'string', description: 'next_cursor from the last page.' },
          audit: { type: 'number', description: 'Newest audit rows to add: 0 to 50, default 0.' },
        },
      },
    },
    guarded('list_orchestrator_controls', listOrchestratorControls),
    options,
  );
}
