import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../dispatcher/dispatcher-paths', () => ({ isDispatcherPath: (p?: string) => p === 'dispatcher-folder' }));

import { _resetMcpCallGateForTesting, forgetMcpCaller, mcpCallAccess, mcpCallerKind, setMcpCaller, setMcpCallerQuick, setMcpCallerUnreadable } from './mcp-call-gate';
import { _resetOrchestrationGateForTesting, onOrchestrationGateChange } from './orchestration-gate';

const P = 'some-project';

beforeEach(() => {
  _resetMcpCallGateForTesting();
  _resetOrchestrationGateForTesting();
});

describe('a known caller: the Clubhouse MCP always runs', () => {
  it('opens a durable agent, a helper, a missing row and a quick agent', () => {
    setMcpCaller('a', P, {});
    setMcpCaller('h', P, { parentAgentId: 'lead' });
    setMcpCaller('m', P, null);
    setMcpCallerQuick('q', P);
    expect(['a', 'h', 'm', 'q'].map((id) => mcpCallAccess(id, P))).toEqual(['open', 'open', 'open', 'open']);
  });

  it('a quick agent stays quick through a refresh', () => {
    setMcpCallerQuick('quick', P);
    setMcpCaller('quick', P, null);
    expect(mcpCallerKind('quick')).toBe('quick');
    expect(mcpCallAccess('quick', P)).toBe('open');
  });

  it('fails closed for a caller that isn\'t running', () => {
    setMcpCaller('a', P, {});
    expect(mcpCallAccess('a', undefined)).toBe('closed');
  });

  it('fails closed for a running caller nothing has recorded: only a real quick agent gets that path', () => {
    expect(mcpCallAccess('nobody', P)).toBe('closed');
    expect(mcpCallerKind('nobody')).toBeUndefined();
  });

  it('names each kind', () => {
    setMcpCallerQuick('q', P);
    setMcpCaller('d', P, {});
    setMcpCaller('m', P, null);
    setMcpCaller('h', P, { parentAgentId: 'lead' });
    setMcpCallerUnreadable('u', P);
    expect(['q', 'd', 'm', 'h', 'u'].map(mcpCallerKind)).toEqual(['quick', 'durable', 'durable', 'helper', 'unreadable']);
  });

  it('forgets an agent that stopped', () => {
    setMcpCaller('a', P, {});
    expect(mcpCallAccess('a', P)).toBe('open');
    forgetMcpCaller('a');
    expect(mcpCallAccess('a', P)).toBe('closed');
    expect(mcpCallerKind('a')).toBeUndefined();
  });
});

describe('a config that couldn\'t be read at start', () => {
  it('is closed, a helper included, since nothing is known', () => {
    setMcpCallerUnreadable('a', P);
    expect(mcpCallAccess('a', P)).toBe('closed');
  });

  it('opens once a read succeeds, and tells its CLI', () => {
    const changed = vi.fn();
    const off = onOrchestrationGateChange(changed);
    setMcpCallerUnreadable('a', P);
    setMcpCaller('a', P, {});
    expect(mcpCallAccess('a', P)).toBe('open');
    expect(changed).toHaveBeenCalledTimes(1);
    off();
  });

  it('a helper opens once it is known to be one', () => {
    setMcpCallerUnreadable('h', P);
    expect(mcpCallAccess('h', P)).toBe('closed');
    setMcpCaller('h', P, { parentAgentId: 'lead' });
    expect(mcpCallAccess('h', P)).toBe('open');
  });

  it('doesn\'t change the Dispatcher, which is known by its folder', () => {
    setMcpCallerUnreadable('d', 'dispatcher-folder');
    expect(mcpCallAccess('d', 'dispatcher-folder')).toBe('open');
  });
});

describe('the Dispatcher', () => {
  it('is always open while it runs', () => {
    setMcpCaller('d', 'dispatcher-folder', {});
    expect(mcpCallAccess('d', 'dispatcher-folder')).toBe('open');
    expect(mcpCallAccess('never-recorded', 'dispatcher-folder')).toBe('open');
  });
});

describe('refreshing tool lists', () => {
  it('tells listeners only when access moved, so a CLI re-lists once', () => {
    const changed = vi.fn();
    const off = onOrchestrationGateChange(changed);
    setMcpCaller('a', P, {});
    expect(changed).not.toHaveBeenCalled();
    setMcpCaller('a', P, {});
    expect(changed).not.toHaveBeenCalled();
    setMcpCallerUnreadable('a', P);
    expect(changed).toHaveBeenCalledTimes(1);
    setMcpCallerUnreadable('a', P);
    expect(changed).toHaveBeenCalledTimes(1);
    setMcpCaller('a', P, {});
    expect(changed).toHaveBeenCalledTimes(2);
    off();
  });
});
