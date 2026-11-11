/**
 * The tools that join the Dispatcher's two agents (#3036), over
 * dispatcher-channel:
 *
 * - start_work, in the `dispatcherChat` group: the chat the user talks to hands
 *   a request to the Dispatcher, which acts on it. Its grant is
 *   `agent.message` on itself: one identity, two agents. Each request gets
 *   an id its outcome comes back under (#3237): success, failure, stopped or
 *   no outcome yet. A retry or follow-up names the id.
 * - read_memory, in both groups: reads recorded by dispatcher-memory-reader.
 * - write_memory, in `dispatcher` only: protected, versioned memory writes.
 * - list_abilities, in the `dispatcherChat` group: what the Dispatcher can do,
 *   built from its live grants (#3048), for "What else can you do?".
 * - tell_user, in the `dispatcher` group: the Dispatcher's report to the user.
 *   It says what kind of news it is, whose, and which request it is for, and
 *   the group chat (dispatcher-news) decides when it shows and how it reads.
 *   `done` notes the steps of that request already finished (#3241), so a
 *   retry resumes instead of repeating them.
 *
 * Descriptions speak to the agent as the Dispatcher, so neither agent learns
 * to describe a second one to the user.
 */

import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';
import { deliverToChat, handOffToDispatcher, type ChannelResult, type HandOffResult } from '../../dispatcher/dispatcher-channel';
import { MemoryReadError, readDispatcherMemory } from '../../dispatcher/dispatcher-memory-reader';
import { writeDispatcherMemory } from '../../dispatcher/dispatcher-memory-writer';
import { optionalString, requireString } from './validation';
import { NEWS_KINDS, isNewsKind, type NewsKind } from '../../dispatcher/dispatcher-triage';
import { readDispatcherAbilities } from '../../dispatcher/dispatcher-teaching';
import { noteRequestDone } from '../../dispatcher/dispatcher-requests';
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

/** A request id an agent passed: short, or nothing. */
function readRequestId(args: Record<string, unknown>): string | undefined | McpToolResult {
  const id = optionalString(args, 'request_id')?.trim();
  if (!id) return undefined;
  return id.length > 100 ? text('request_id is not a request id. Use the one from the hand-off, or leave it out.', true) : id;
}

/** At most this many steps in one tell_user. */
const DONE_MAX = 10;

/** tell_user's `done`: finished steps, one line each, or an error to return. */
function readDone(args: Record<string, unknown>): string[] | McpToolResult {
  if (args.done === undefined) return [];
  const list = typeof args.done === 'string' ? [args.done] : args.done;
  if (!Array.isArray(list) || !list.every((d) => typeof d === 'string')) return text('done must be a list of short lines.', true);
  const steps = list.map((d) => d.trim()).filter(Boolean);
  if (steps.length > DONE_MAX) return text(`done has ${steps.length} steps; send at most ${DONE_MAX}, the ones that matter for a retry.`, true);
  return steps;
}

/** What start_work tells the chat about the request it went as. */
function underWay(result: HandOffResult): string {
  const id = result.requestId ?? 'it';
  const back = 'Its outcome will come back here as a message from Clubhouse, whether it worked, failed or was stopped.';
  if (result.reuse === 'already') return `Request ${id} is already under way, so it wasn't handed off twice. ${back}`;
  return `Request ${id} is under way${result.reuse === 'again' ? ' again' : ''}. ${back}`;
}

export function registerDispatcherChatTools(): void {
  registerGlobalTool(
    'start_work',
    {
      description:
        'Get something done for the user: wake, message, create or connect agents, make or change Actions, ' +
        'or change settings. Describe what they want, with the agents, projects and details they named and ' +
        'what done looks like. It returns a request id; the outcome comes back here as an update with that id. ' +
        'For the user\'s answer to a question about a request, a change to it, or trying it again, pass its request_id. ' +
        'Tell the user in a few words, in the first person, what you\'re doing, such as "I\'ll set that up."',
      inputSchema: {
        type: 'object',
        properties: {
          request: { type: 'string', description: 'What the user wants done, in plain words, with what they said about it.' },
          request_id: { type: 'string', description: 'The id of an earlier request this follows up on or tries again. Leave it out for something new.' },
        },
        required: ['request'],
      },
    },
    async (agentId, args) => {
      const request = readText(args, 'request');
      if (typeof request !== 'string') return request;
      const requestId = readRequestId(args);
      if (typeof requestId === 'object') return requestId;
      try {
        const result = await handOffToDispatcher(agentId, request, requestId);
        return failure(result) ?? text(underWay(result));
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
    { group: ['dispatcher', 'dispatcherChat'], grant: { actions: ['agent.read'], target: 'self' } },
  );

  registerGlobalTool(
    'write_memory',
    {
      description: 'Replace a memory page with plain markdown. Read it first, keep its sources and unknown headers, and edit only Notes on an agent page, never its Card. Topic pages need Status and Source headers; Created is preserved and Updated is stamped for you. Previous versions are kept in bounded history.',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'The .md page relative to memory, such as topics/checkout.md. History and archive are read only.' },
          text: { type: 'string', description: 'The whole page, including its headers and any unchanged sections.' },
        },
        required: ['page', 'text'],
      },
    },
    async (agentId, args) => {
      const page = requireString(args, 'page')?.trim();
      if (!page || typeof args.text !== 'string') return text('write_memory needs page and text.', true);
      try {
        return text(JSON.stringify(await writeDispatcherMemory(page, args.text), null, 2));
      } catch (err) {
        if (err instanceof MemoryReadError) return text(err.message, true);
        // telemetry-exempt: logged, and the error reaches the agent as the tool result
        appLog('core:mcp', 'warn', 'write_memory failed', { meta: { agentId, error: errorText(err) } });
        return text(`Memory could not be written: ${errorText(err)}`, true);
      }
    },
    { group: 'dispatcher', grant: { actions: ['memory.write'], target: 'self' } },
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
        'JSON or task ids. `kind` decides when it shows: needs_user now, answer now for one of their requests, ' +
        'routine at the next check-in, check_in only when news is waiting for it. For an agent\'s news, set ' +
        '`from`: the user hears it in your voice with the agent named. Skip news not worth telling, and keep ' +
        'what passes between you and an agent between you.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'One or two plain sentences. With `from`, the facts from that agent the user needs. For a check-in, what changed overall.' },
          kind: {
            type: 'string',
            enum: [...NEWS_KINDS],
            description: 'needs_user: theirs to answer or decide, or a problem that needs them. answer: the outcome of their request. ' +
              'routine: can wait for a check-in. check_in: your check-in summary. Default needs_user.',
          },
          from: { type: 'string', description: 'The agent whose news this is, by id or name. Leave it out for your own words and check-ins.' },
          request_id: { type: 'string', description: 'The request id from the hand-off this is about. Set it for a request\'s outcome and for a question about one.' },
          done: {
            type: 'array',
            items: { type: 'string' },
            description: 'Steps of the request that are finished, one short line each, such as "Cloned acme/web into ~/src/web". '
              + 'Kept with the request, so trying it again skips them. Needs request_id.',
          },
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
      const request = readRequestId(args);
      if (typeof request === 'object') return request;
      const done = readDone(args);
      if (!Array.isArray(done)) return done;
      if (done.length && !request) return text('done needs request_id: the steps belong to a request.', true);
      try {
        // Noted whatever becomes of the news: the steps are done either way.
        const noted = done.length && request ? noteRequestDone(request, done) : 0;
        if (noted === null) return text(`There is no request ${request}, so the steps weren't noted. Use the id from the hand-off.`, true);
        const result = await deliverToChat(agentId, { message, ...(kind && { kind }), ...(from && { from }), ...(request && { request }) });
        const after = [noted ? `Noted ${noted} step${noted === 1 ? '' : 's'} done for request ${request}.` : '', result.note ?? ''].filter(Boolean).join(' ');
        const withNote = (base: string) => text(after ? `${base} ${after}` : base);
        if (result.held === 'later') return withNote(`Not shown yet. ${result.reason ?? 'Held for the next check-in summary.'}`);
        if (result.held === 'never') return withNote(`Not shown. ${result.reason ?? 'It was held back.'}`);
        return failure(result) ?? withNote('The user has it.');
      } catch (err) {
        // telemetry-exempt: logged, and the error reaches the agent as the tool result
        appLog('core:mcp', 'warn', 'tell_user failed', { meta: { agentId, error: errorText(err) } });
        return text(`It could not be delivered: ${errorText(err)}`, true);
      }
    },
    { group: 'dispatcher', grant: { actions: ['user.notify'], target: 'app' } },
  );
}
