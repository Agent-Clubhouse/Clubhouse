import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mcp: { enabled: true } as { enabled: boolean; projectOverrides?: Record<string, boolean> },
  clubhouse: { enabled: false } as { enabled: boolean; projectOverrides?: Record<string, boolean> },
}));

vi.mock('../mcp-settings', async () => {
  const resolve = (projectPath?: string, agentOverride?: boolean): boolean => {
    if (agentOverride !== undefined) return agentOverride;
    if (projectPath && h.mcp.projectOverrides?.[projectPath] !== undefined) return h.mcp.projectOverrides[projectPath];
    if (h.mcp.enabled) return true;
    if (projectPath && h.clubhouse.projectOverrides?.[projectPath] !== undefined) return h.clubhouse.projectOverrides[projectPath];
    return h.clubhouse.enabled;
  };
  return { isMcpEnabled: resolve, isMcpOnAtAppLevel: () => resolve() };
});
vi.mock('../dispatcher/dispatcher-paths', () => ({ isDispatcherPath: (p?: string) => p === 'dispatcher-folder' }));

import { clubhouseMcpOverride } from '../../../shared/agent-helpers';
import { _resetMcpCallGateForTesting, forgetMcpCaller, mcpCallAccess, setMcpCaller } from './mcp-call-gate';
import { _resetOrchestrationGateForTesting, onOrchestrationGateChange } from './orchestration-gate';

const P = 'some-project';

beforeEach(() => {
  h.mcp = { enabled: true };
  h.clubhouse = { enabled: false };
  _resetMcpCallGateForTesting();
  _resetOrchestrationGateForTesting();
});

describe('a helper: what it may call, by its raw mcpOverride against project and app', () => {
  // A helper's raw override decides first, then the project, then the app, as for any agent.
  // Without MCP it keeps message_parent. The PR carries this table.
  const TABLE: Array<[raw: boolean | undefined, project: boolean | undefined, app: boolean, access: 'open' | 'report_only']> = [
    [true, undefined, true, 'open'],
    [true, undefined, false, 'open'],
    [true, true, true, 'open'],
    [true, true, false, 'open'],
    [true, false, true, 'open'],
    [true, false, false, 'open'],
    [false, undefined, true, 'report_only'],
    [false, undefined, false, 'report_only'],
    [false, true, true, 'report_only'],
    [false, true, false, 'report_only'],
    [false, false, true, 'report_only'],
    [false, false, false, 'report_only'],
    [undefined, undefined, true, 'open'],
    [undefined, undefined, false, 'report_only'],
    [undefined, true, true, 'open'],
    [undefined, true, false, 'open'],
    [undefined, false, true, 'report_only'],
    [undefined, false, false, 'report_only'],
  ];

  it.each(TABLE)('raw %s, project %s, app %s: %s', (raw, project, app, access) => {
    h.mcp = { enabled: app, ...(project !== undefined && { projectOverrides: { [P]: project } }) };
    setMcpCaller('helper', P, { parentAgentId: 'lead', mcpOverride: raw });
    expect(mcpCallAccess('helper', P)).toBe(access);
  });

  it('the forced override still decides the bridge, in every row: the gate is a separate question', () => {
    for (const [raw] of TABLE) expect(clubhouseMcpOverride({ parentAgentId: 'lead', mcpOverride: raw })).toBe(true);
  });
});

describe('the caller\'s effective MCP', () => {
  it('follows agent, then project, then app, then Clubhouse mode, read live', () => {
    setMcpCaller('a', P, {});
    expect(mcpCallAccess('a', P)).toBe('open');
    h.mcp = { enabled: false };
    expect(mcpCallAccess('a', P)).toBe('closed');
    h.clubhouse = { enabled: true };
    expect(mcpCallAccess('a', P)).toBe('open');
    h.clubhouse = { enabled: true, projectOverrides: { [P]: false } };
    expect(mcpCallAccess('a', P)).toBe('closed');
    h.mcp = { enabled: false, projectOverrides: { [P]: true } };
    expect(mcpCallAccess('a', P)).toBe('open');
    setMcpCaller('a', P, { mcpOverride: false });
    expect(mcpCallAccess('a', P)).toBe('closed');
    h.mcp = { enabled: false };
    h.clubhouse = { enabled: false };
    setMcpCaller('a', P, { mcpOverride: true });
    expect(mcpCallAccess('a', P)).toBe('open');
  });

  it('a quick agent has no config and follows its project', () => {
    expect(mcpCallAccess('quick', P)).toBe('open');
    h.mcp = { enabled: false };
    expect(mcpCallAccess('quick', P)).toBe('closed');
    h.mcp = { enabled: false, projectOverrides: { [P]: true } };
    expect(mcpCallAccess('quick', P)).toBe('open');
  });

  it('fails closed for a caller that isn\'t running', () => {
    setMcpCaller('a', P, { mcpOverride: true });
    expect(mcpCallAccess('a', undefined)).toBe('closed');
  });

  it('forgets an agent that stopped, so a later start isn\'t read with its old override', () => {
    setMcpCaller('a', P, { mcpOverride: true });
    h.mcp = { enabled: false };
    expect(mcpCallAccess('a', P)).toBe('open');
    forgetMcpCaller('a');
    expect(mcpCallAccess('a', P)).toBe('closed');
  });
});

describe('the Dispatcher', () => {
  it('follows MCP at app level, and its own override and project overrides don\'t count', () => {
    setMcpCaller('d', 'dispatcher-folder', { mcpOverride: true });
    expect(mcpCallAccess('d', 'dispatcher-folder')).toBe('open');
    h.mcp = { enabled: false, projectOverrides: { [P]: true, 'dispatcher-folder': true } };
    expect(mcpCallAccess('d', 'dispatcher-folder')).toBe('closed');
    h.clubhouse = { enabled: true };
    expect(mcpCallAccess('d', 'dispatcher-folder')).toBe('open');
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
    h.mcp = { enabled: false };
    setMcpCaller('a', P, {});
    expect(changed).toHaveBeenCalledTimes(1);
    setMcpCaller('a', P, {});
    expect(changed).toHaveBeenCalledTimes(1);
    h.mcp = { enabled: true };
    setMcpCaller('a', P, {});
    expect(changed).toHaveBeenCalledTimes(2);
    off();
  });
});
