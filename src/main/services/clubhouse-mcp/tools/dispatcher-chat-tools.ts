/**
 * The tools that join the Dispatcher's two agents (#3036), over
 * dispatcher-channel:
 *
 * - start_work, in the `dispatcherChat` group: the chat the user talks to hands
 *   a request to the Dispatcher, which acts on it. Its grant is
 *   `agent.message` on itself: one identity, two agents.
 * - read_memory, in the `dispatcherChat` group: the chat reads the
 *   Dispatcher's memory, read-only (dispatcher-memory-reader).
 * - tell_user, in the `dispatcher` group: the Dispatcher's report to the user,
 *   which reaches the chat as a Clubhouse update.
 *
 * Descriptions speak to the agent as the Dispatcher, so neither agent learns
 * to describe a second one to the user.
 */

import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';
import { deliverToChat, handOffToDispatcher, type ChannelResult } from '../../dispatcher/dispatcher-channel';
import { MemoryReadError, readDispatcherMemory } from '../../dispatcher/dispatcher-memory-reader';
import { optionalString, requireString } from './validation';

/** One request or report: long enough for a plan, short enough to stay a message. */
export const MAX_CHANNEL_TEXT = 8_000;

function text(value: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError && { isError }) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readText(args: Record<string, unknown>, key: string): string | McpToolResult {
  const value = requireString(args, key)?.trim();
  if (!value) return text(`Missing required argument: ${key}`, true);
  if (value.length > MAX_CHANNEL_TEXT) return text(`${key} is too long (${value.length} characters, at most ${MAX_CHANNEL_TEXT}). Keep it to what matters.`, true);
  return value;
}

function failure(result: ChannelResult): McpToolResult | null {
  if (result.outcome === 'delivered' || result.outcome === 'started') return null;
  return text(result.error ?? 'It could not be delivered.', true);
}

export function registerDispatcherChatTools(): void {
  registerGlobalTool(
    'start_work',
    {
      description:
        'Get something done for the user: wake, message, create or connect agents, make or change Actions, ' +
        'or change settings. You don\'t do these from this conversation. Describe what the user wants, with ' +
        'any detail they gave, and it is done in the background. The outcome comes back here as a message ' +
        'from Clubhouse. Tell the user in a few words that it is under way.',
      inputSchema: {
        type: 'object',
        properties: {
          request: { type: 'string', description: 'What the user wants done, in plain words, with what they said about it.' },
        },
        required: ['request'],
      },
    },
    async (agentId, args) => {
      const request = readText(args, 'request');
      if (typeof request !== 'string') return request;
      try {
        const result = await handOffToDispatcher(agentId, request);
        return failure(result) ?? text('Under way. The outcome will come back here as a message from Clubhouse.');
      } catch (err) {
        // telemetry-exempt: logged, and the error reaches the agent as the tool result
        appLog('core:mcp', 'warn', 'start_work failed', { meta: { agentId, error: errorText(err) } });
        return text(`It could not be started: ${errorText(err)}`, true);
      }
    },
    { group: 'dispatcherChat', grant: { actions: ['agent.message'], target: 'self' } },
  );

  registerGlobalTool(
    'read_memory',
    {
      description:
        'Read your memory: what you know about the user\'s agents, what happened when, and each piece of work. ' +
        'With no page, returns the index and the list of pages. With a page, such as agents/webapp-lead.md, ' +
        'returns that page. Read only; it is kept up to date in the background.',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'A page from the list, relative to memory. Leave it out for the index.' },
        },
      },
    },
    async (agentId, args) => {
      try {
        const read = await readDispatcherMemory(optionalString(args, 'page'));
        return { content: [{ type: 'text', text: JSON.stringify(read, null, 2) }] };
      } catch (err) {
        if (err instanceof MemoryReadError) return text(err.message, true);
        // telemetry-exempt: logged, and the error reaches the agent as the tool result
        appLog('core:mcp', 'warn', 'read_memory failed', { meta: { agentId, error: errorText(err) } });
        return text(`Memory could not be read: ${errorText(err)}`, true);
      }
    },
    { group: 'dispatcherChat', grant: { actions: ['agent.read'], target: 'self' } },
  );

  registerGlobalTool(
    'tell_user',
    {
      description:
        'Tell the user something: the outcome of what they asked for, a question that is theirs to answer, or ' +
        'news that needs them. Write plain sentences, with no tool output, JSON or task ids. Don\'t report ' +
        'routine progress. The user reads it in their conversation with you, where it is answered in your voice.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What the user should know, in plain sentences.' },
        },
        required: ['message'],
      },
    },
    async (agentId, args) => {
      const message = readText(args, 'message');
      if (typeof message !== 'string') return message;
      try {
        const result = await deliverToChat(agentId, message);
        return failure(result) ?? text('The user has it.');
      } catch (err) {
        // telemetry-exempt: logged, and the error reaches the agent as the tool result
        appLog('core:mcp', 'warn', 'tell_user failed', { meta: { agentId, error: errorText(err) } });
        return text(`It could not be delivered: ${errorText(err)}`, true);
      }
    },
    { group: 'dispatcher', grant: { actions: ['user.notify'], target: 'app' } },
  );
}
