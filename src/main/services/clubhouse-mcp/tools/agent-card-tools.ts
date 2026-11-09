/**
 * update_my_card (#3041): an agent connected to the Dispatcher writes its own
 * card: what it's for, when to reach it, and what it owns. It has no argument
 * that names an agent, so it can only ever write the caller's card, and the
 * card is the only thing it writes (dispatcher-agent-cards).
 *
 * In the `dispatcherConnected` group: listed while the agent has its wire to
 * the Dispatcher. Its grant is `agent.display` on itself, which every agent
 * holds, like naming or coloring itself.
 */

import { registerGlobalTool, setDispatcherConnectionCheck } from '../tool-registry';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';
import { MAX_CARD_FIELD, UPDATE_CARD_TOOL, type AgentCardFields } from '../../dispatcher/dispatcher-agent-cards';
import { getAgentCards, isWiredToDispatcher } from '../../dispatcher/dispatcher-agent-cards-watch';

function text(value: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError && { isError }) };
}

const ARGS: ReadonlyArray<[string, keyof AgentCardFields]> = [
  ['purpose', 'purpose'],
  ['contact_when', 'contactWhen'],
  ['owns', 'owns'],
];

/** The fields given, or an error result for one that isn't text or is too long. */
export function readCardArgs(args: Record<string, unknown>): Partial<AgentCardFields> | McpToolResult {
  const fields: Partial<AgentCardFields> = {};
  for (const [arg, key] of ARGS) {
    const value = args[arg];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return text(`${arg} must be text.`, true);
    const trimmed = value.trim();
    if (trimmed.length > MAX_CARD_FIELD) {
      return text(`${arg} is too long (${trimmed.length} characters, at most ${MAX_CARD_FIELD}). Keep it to a sentence or two.`, true);
    }
    fields[key] = trimmed;
  }
  if (Object.keys(fields).length === 0) return text('Give at least one of purpose, contact_when or owns.', true);
  return fields;
}

export function registerAgentCardTools(): void {
  setDispatcherConnectionCheck(isWiredToDispatcher);
  // Spelled out: the telemetry tool list test reads registrations from the source.
  registerGlobalTool(
    'update_my_card',
    {
      description:
        'Update your card for the Dispatcher: what you do and when to come to you, a sentence or two per field. ' +
        'Call it when Clubhouse asks and whenever your work changes. Fields you leave out keep their text.',
      inputSchema: {
        type: 'object',
        properties: {
          purpose: { type: 'string', description: 'What you\'re for: your job, in a sentence or two.' },
          contact_when: { type: 'string', description: 'When to reach you: the questions or requests you should get.' },
          owns: { type: 'string', description: 'What you own: repositories, areas, features or decisions.' },
        },
      },
    },
    async (agentId, args) => {
      const fields = readCardArgs(args);
      if ('content' in fields) return fields as McpToolResult;
      try {
        const result = await getAgentCards().saveOwnCard(agentId, fields);
        if ('error' in result) return text(result.error, true);
        return text('Saved your card. The Dispatcher reads it from now on.');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // telemetry-exempt: logged, and the error reaches the agent as the tool result
        appLog('core:mcp', 'warn', `${UPDATE_CARD_TOOL} failed`, { meta: { agentId, error: message } });
        return text(`Your card could not be saved: ${message}`, true);
      }
    },
    { group: 'dispatcherConnected', grant: { actions: ['agent.display'], target: 'self' } },
  );
}
