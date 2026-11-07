import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The whole dependency, through the real resolvers: MCP at app, project and agent
 * level, the Dispatcher's saved values and the layout. Clubhouse mode was
 * MCP's fallback until it was retired (#2901); the startup pass made it explicit (D63). The PR that
 * made the Dispatcher default on carries this table.
 */

const h = vi.hoisted(() => ({ newLayout: true, experimental: {} as Record<string, boolean> }));

vi.mock('../settings-store', () => ({
  createSettingsStore: <T,>(_file: string, defaults: T) => {
    let value = { ...defaults };
    return {
      get: () => value,
      save: async (v: T) => { value = v; },
      update: async (fn: (c: T) => T) => { value = fn(value); return value; },
    };
  },
}));
vi.mock('../experimental-settings', () => ({ getSettings: () => h.experimental }));
vi.mock('../../window-chrome', () => ({ newChromeEnabled: () => h.newLayout }));

import { clubhouseMcpOverride } from '../../../shared/agent-helpers';
import { resolveOrchestrationPolicy } from '../../../shared/orchestration-policy';
import { _resetAgentBridgeNeedForTesting, isMcpEnabled, isMcpEnabledForAny, isMcpOnAtAppLevel, saveSettings as saveMcp } from '../mcp-settings';
import { dispatcherEnablement, updateSettings } from './dispatcher-settings';

const P = 'some-project';
type Tri = boolean | undefined;

interface Row {
  name: string;
  mcp: boolean; mcpProject?: boolean; agent?: boolean;
  /** MCP at app level, and so whether the Dispatcher can be on. */
  app: boolean;
  /** MCP for an agent in the project with nothing of its own. */
  project: boolean;
  /** MCP for this row's agent, with its own override if it has one. */
  own: boolean;
  /** The bridge starts at launch, before any agent starts. */
  bridge: boolean;
}

const row = (name: string, inputs: Pick<Row, 'mcp' | 'mcpProject' | 'agent'>, app: boolean, project: boolean, own: boolean, bridge: boolean): Row =>
  ({ name, ...inputs, app, project, own, bridge });

const TABLE: Row[] = [
  row('MCP on', { mcp: true }, true, true, true, true),
  row('MCP off, nothing else', { mcp: false }, false, false, false, false),
  row('MCP off, project on', { mcp: false, mcpProject: true }, false, true, true, true),
  row('MCP on, project off', { mcp: true, mcpProject: false }, true, false, false, true),
  row('MCP off, agent on', { mcp: false, agent: true }, false, false, true, false),
  row('MCP on, agent off', { mcp: true, agent: false }, true, true, false, true),
  row('MCP on, project off, agent on', { mcp: true, mcpProject: false, agent: true }, true, false, true, true),
  row('MCP off, project on, agent off', { mcp: false, mcpProject: true, agent: false }, false, true, false, true),
];

/** Saved values and layout, and what they say with MCP on at app level. */
const SAVED: Array<{ name: string; saved: Tri; experimental: Tri; newLayout: boolean; savedOn: boolean }> = [
  { name: 'new layout, nothing saved', saved: undefined, experimental: undefined, newLayout: true, savedOn: true },
  { name: 'new layout, saved on', saved: true, experimental: undefined, newLayout: true, savedOn: true },
  { name: 'new layout, saved off', saved: false, experimental: undefined, newLayout: true, savedOn: false },
  { name: 'new layout, experimental false', saved: undefined, experimental: false, newLayout: true, savedOn: false },
  { name: 'new layout, experimental false, saved on', saved: true, experimental: false, newLayout: true, savedOn: true },
  { name: 'classic, nothing saved', saved: undefined, experimental: undefined, newLayout: false, savedOn: false },
  { name: 'classic, saved on', saved: true, experimental: undefined, newLayout: false, savedOn: true },
  { name: 'classic, saved off', saved: false, experimental: undefined, newLayout: false, savedOn: false },
];

describe.each(TABLE)('$name', (r) => {
  beforeEach(async () => {
    _resetAgentBridgeNeedForTesting();
    await saveMcp({ enabled: r.mcp, ...(r.mcpProject !== undefined && { projectOverrides: { [P]: r.mcpProject } }) });
  });

  it('resolves MCP at each level, and whether the bridge starts at launch', () => {
    expect(isMcpOnAtAppLevel()).toBe(r.app);
    expect(isMcpEnabled(P)).toBe(r.project);
    expect(isMcpEnabled(P, clubhouseMcpOverride({ mcpOverride: r.agent }))).toBe(r.own);
    expect(isMcpEnabledForAny()).toBe(r.bridge);
  });

  it('a helper always has MCP, whatever the row says (#2610)', () => {
    expect(isMcpEnabled(P, clubhouseMcpOverride({ parentAgentId: 'lead', mcpOverride: r.agent ?? false }))).toBe(true);
  });

  it('derives switches off where the agent has no MCP, and keeps them', () => {
    const policy = resolveOrchestrationPolicy({ orchestrate: true, crossProjectHelpers: true, connectToDispatcher: true, autoHelpers: true }, { mcpOff: !r.own });
    expect(policy.orchestrate).toBe(r.own);
    expect(policy.connectToDispatcher).toBe(r.own);
    expect(policy.crossProjectHelpers).toBe(r.own);
    expect(policy.autoHelpers).toBe(r.own);
    if (!r.own) expect(policy.mcpOff).toEqual({ orchestrate: true, crossProjectHelpers: true, connectToDispatcher: true, autoHelpers: true });
  });

  it.each(SAVED)('Dispatcher: $name', async ({ saved, experimental, newLayout, savedOn }) => {
    h.newLayout = newLayout;
    h.experimental = experimental === undefined ? {} : { dispatcher: experimental };
    await updateSettings(() => (saved === undefined ? {} : { enabled: saved }));
    const result = dispatcherEnablement();
    expect(result.savedOn).toBe(savedOn);
    expect(result.enabled).toBe(savedOn && r.app);
    if (savedOn && !r.app) expect(result.reason).toBe('mcp_off');
  });
});
