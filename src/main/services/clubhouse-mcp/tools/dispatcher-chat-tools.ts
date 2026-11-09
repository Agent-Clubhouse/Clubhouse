/**
 * The tools that join the Dispatcher's two agents (#3036), over
 * dispatcher-channel:
 *
 * - start_work, in the `dispatcherChat` group: the chat the user talks to hands
 *   a request to the Dispatcher, which acts on it. Its grant is
 *   `agent.message` on itself: one identity, two agents.
 * - read_memory, in the `dispatcherChat` group: the chat reads the
 *   Dispatcher's memory, read-only (dispatcher-memory-reader).
 * - list_abilities, in the `dispatcherChat` group: what the Dispatcher can do,
 *   built from its live grants (#3048), for "What else can you do?".
 * - tell_user, in the `dispatcher` group: the Dispatcher's report to the user.
 *   It says what kind of news it is and whose, and the group chat
 *   (dispatcher-news) decides when it shows and how it reads.
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
import { NEWS_KINDS, isNewsKind, type NewsKind } from '../../dispatcher/dispatcher-triage';
import { readDispatcherAbilities } from '../../dispatcher/dispatcher-teaching';
import { capabilitiesText } from '../../../../shared/dispatcher-teaching';

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
        'or change settings. Describe what they want, with the agents, projects and details they named and ' +
        'what done looks like. The outcome comes back here as an update. Tell the user in a few words, in the ' +
        'first person, what you\'re doing, such as "I\'ll set that up."',
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
        'Read your memory: notes on the user\'s agents, what happened when, and each piece of work. ' +
        'With no page, returns the index and the list of pages; with a page such as agents/webapp-lead.md, ' +
        'that page. Read only.',
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
    'list_abilities',
    {
      description:
        'What you are allowed to do for the user right now, from your Clubhouse permissions, in groups. ' +
        'Use it to answer "What can you do?": keep its groups, leave nothing out, and offer nothing it doesn\'t list.',
      inputSchema: { type: 'object', properties: {} },
    },
    async (agentId) => {
      try {
        return text(capabilitiesText(await readDispatcherAbilities()));
      } catch (err) {
        // telemetry-exempt: logged, and the error reaches the agent as the tool result
        appLog('core:mcp', 'warn', 'list_abilities failed', { meta: { agentId, error: errorText(err) } });
        return text(`Your permissions could not be read: ${errorText(err)}`, true);
      }
    },
    { group: 'dispatcherChat', grant: { actions: ['agent.read'], target: 'self' } },
  );

  registerGlobalTool(
    'tell_user',
    {
      description:
        'Tell the user something in their conversation with you: one or two plain sentences, no tool output, ' +
        'JSON or task ids. `kind` decides when it shows: needs_user now, answer now while their request is open, ' +
        'routine at the next check-in, check_in only when news is waiting for it. For an agent\'s news, set ' +
        '`from`: it shows under that agent\'s name, rewritten from what it sent you, with `message` as your ' +
        'version in its voice. Skip news not worth telling.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'One or two plain sentences. With `from`, in that agent\'s voice. For a check-in, what changed overall.' },
          kind: {
            type: 'string',
            enum: [...NEWS_KINDS],
            description: 'needs_user: theirs to answer or decide, or a problem that needs them. answer: the outcome of their request. ' +
              'routine: can wait for a check-in. check_in: your check-in summary. Default needs_user.',
          },
          from: { type: 'string', description: 'The agent whose news this is, by id or name. Leave it out for your own words and check-ins.' },
        },
        required: ['message'],
      },
    },
    async (agentId, args) => {
      const message = readText(args, 'message');
      if (typeof message !== 'string') return message;
      if (args.kind !== undefined && !isNewsKind(args.kind)) return text(`kind must be one of ${NEWS_KINDS.join(', ')}.`, true);
      const kind: NewsKind | undefined = isNewsKind(args.kind) ? args.kind : undefined;
      const from = optionalString(args, 'from')?.trim();
      try {
        const result = await deliverToChat(agentId, { message, ...(kind && { kind }), ...(from && { from }) });
        if (result.held === 'later') return text(`Not shown yet. ${result.reason ?? 'Held for the next check-in summary.'}`);
        if (result.held === 'never') return text(`Not shown. ${result.reason ?? 'It was held back.'}`);
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
