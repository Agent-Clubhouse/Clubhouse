/**
 * search_memory (#3039): one search over the Dispatcher's memory and its past
 * conversations, offered to both of its agents (the `dispatcher` and
 * `dispatcherChat` groups). It reads only, so its grant is `agent.read` on
 * itself, like read_memory. The search is dispatcher-search.
 */

import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';
import { MAX_SEARCH_LIMIT, searchDispatcher, type SearchScope } from '../../dispatcher/dispatcher-search';
import { McpArgError, optionalNumber, optionalString, requireString } from './validation';

/** The longest query taken. */
export const MAX_QUERY_CHARS = 500;

const SCOPES: readonly SearchScope[] = ['all', 'memory', 'transcripts'];

function text(value: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError && { isError }) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerDispatcherSearchTools(): void {
  registerGlobalTool(
    'search_memory',
    {
      description:
        'Search your memory and your past conversations for words or "a phrase". Every word must appear in a ' +
        'hit. Memory hits name the page and line (a page is what read_memory takes); conversation hits name ' +
        'the transcript file and line, newest first, so you can point back to where something was said.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to find. Put "quotes" around a phrase that must appear as written.' },
          scope: { type: 'string', enum: [...SCOPES], description: 'memory, transcripts, or all (the default).' },
          limit: { type: 'number', description: `Hits per source at most (default 10, at most ${MAX_SEARCH_LIMIT}).` },
        },
        required: ['query'],
      },
    },
    async (agentId, args) => {
      let query: string;
      let scope: SearchScope;
      let limit: number | undefined;
      try {
        query = requireString(args, 'query').trim();
        const s = optionalString(args, 'scope') ?? 'all';
        if (!SCOPES.includes(s as SearchScope)) return text(`scope must be one of ${SCOPES.join(', ')}.`, true);
        scope = s as SearchScope;
        limit = optionalNumber(args, 'limit');
      } catch (err) {
        if (err instanceof McpArgError) return text(err.message, true);
        throw err;
      }
      if (!query) return text('Missing required argument: query', true);
      if (query.length > MAX_QUERY_CHARS) return text(`query is too long (${query.length} characters, at most ${MAX_QUERY_CHARS}).`, true);
      try {
        const result = await searchDispatcher(query, { scope, limit });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        // telemetry-exempt: logged, and the error reaches the agent as the tool result
        appLog('core:mcp', 'warn', 'search_memory failed', { meta: { agentId, error: errorText(err) } });
        return text(`The search failed: ${errorText(err)}`, true);
      }
    },
    { group: ['dispatcher', 'dispatcherChat'], grant: { actions: ['agent.read'], target: 'self' } },
  );
}
