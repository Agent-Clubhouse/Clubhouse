import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../plugin-manifest-registry', () => ({ getManifest: vi.fn(() => ({ permissions: ['mcp.tools'] })) }));
vi.mock('../../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../../dispatcher/dispatcher-settings')>(),
  isDispatcherEnabled: () => true,
}));
vi.mock('../mcp-call-gate', async (original) => ({ ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
const search = vi.fn();
vi.mock('../../dispatcher/dispatcher-search', async (original) => ({
  ...await original<typeof import('../../dispatcher/dispatcher-search')>(),
  searchDispatcher: (...args: unknown[]) => search(...args),
}));

import { callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { setMcpCaller, _resetMcpCallGateForTesting } from '../mcp-call-gate';
import { _resetDispatcherGateForTesting, setDispatcherAgent, setDispatcherChatAgent } from '../dispatcher-gate';
import { registerDispatcherSearchTools, MAX_QUERY_CHARS } from './dispatcher-search-tools';

/** search_memory (#3039): offered to both of the Dispatcher's agents, and no one else. */

beforeEach(() => {
  search.mockReset();
  search.mockResolvedValue({ query: 'q', memory: [], transcripts: [] });
  _resetForTesting();
  _resetMcpCallGateForTesting();
  _resetDispatcherGateForTesting();
  registerDispatcherSearchTools();
  for (const id of ['chat', 'dispatcher', 'other']) setMcpCaller(id, '/p', {});
  setDispatcherChatAgent('chat', true);
  setDispatcherAgent('dispatcher', true);
});

describe('search_memory', () => {
  it('is offered to the chat and the Dispatcher, and not to other agents', () => {
    const names = (id: string) => getScopedToolList(id).map((t) => t.name);
    expect(names('chat')).toContain('search_memory');
    expect(names('dispatcher')).toContain('search_memory');
    expect(names('other')).not.toContain('search_memory');
  });

  it('runs the search and returns its result as JSON', async () => {
    const hit = { page: 'topics/checkout.md', line: 4, text: 'Safari checkout', link: 'memory/topics/checkout.md#L4' };
    search.mockResolvedValue({ query: 'safari', memory: [hit], transcripts: [] });
    const result = await callTool('chat', 'search_memory', { query: '  safari  ', scope: 'memory', limit: 5 });
    expect(result.isError).toBeFalsy();
    expect(search).toHaveBeenCalledWith('safari', { scope: 'memory', limit: 5 });
    expect(JSON.parse(result.content[0].text!)).toEqual({ query: 'safari', memory: [hit], transcripts: [] });
  });

  it('searches everything by default', async () => {
    await callTool('dispatcher', 'search_memory', { query: 'release' });
    expect(search).toHaveBeenCalledWith('release', { scope: 'all', limit: undefined });
  });

  it('refuses a missing, blank, too long or badly typed query, and an unknown scope', async () => {
    for (const args of [{}, { query: '   ' }, { query: 'x'.repeat(MAX_QUERY_CHARS + 1) }, { query: 3 }, { query: 'a', scope: 'notes' }, { query: 'a', limit: 'ten' }]) {
      const result = await callTool('dispatcher', 'search_memory', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('reports a failed search as an error result', async () => {
    search.mockRejectedValue(new Error('disk gone'));
    const result = await callTool('dispatcher', 'search_memory', { query: 'release' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disk gone');
  });
});
