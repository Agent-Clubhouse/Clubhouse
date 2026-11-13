import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listToolGrants, registerGlobalTool, _annotationCatalogKeysForTesting, _resetForTesting } from './tool-registry';
import { registerClubhouseMcpTools } from './tools/register-all';
import { registerPluginTools, _resetForTesting as resetPlugins } from './plugin-tool-registry';

vi.mock('../plugin-manifest-registry', () => ({
  getManifest: vi.fn(() => ({ permissions: ['mcp.tools'] })),
}));

describe('MCP tool annotations (#3367)', () => {
  beforeEach(() => {
    _resetForTesting();
    resetPlugins();
  });

  it('classifies every startup tool, including helpers and group-project tools', () => {
    registerClubhouseMcpTools();
    const tools = listToolGrants();
    expect(tools.length).toBeGreaterThan(100);
    for (const tool of tools) {
      expect(tool.annotations, `${tool.kind}:${tool.name}`).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      if (tool.annotations?.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
    }
    expect(tools.map(({ kind, name, annotations }) => (
      `${kind}:${name} readOnly=${annotations?.readOnlyHint} destructive=${annotations?.destructiveHint} openWorld=${annotations?.openWorldHint}`
    )).join('\n')).toMatchSnapshot();
  });

  it('has no catalog entry for a tool that is no longer registered', () => {
    // A stale entry would hand its hints to any later tool reusing the name.
    registerClubhouseMcpTools();
    const registered = new Set(listToolGrants().map(({ kind, name }) => `${kind}:${name}`));
    expect(_annotationCatalogKeysForTesting().filter((key) => !registered.has(key))).toEqual([]);
  });

  it.each(['read_unreviewed_tool', 'constructor'])('leaves unreviewed tool %s unclassified', (name) => {
    registerGlobalTool(name, {
      description: 'Not reviewed',
      inputSchema: { type: 'object' },
    }, async () => ({ content: [] }), { grant: { actions: ['agent.read'], target: 'self' } });
    expect(listToolGrants()[0].annotations).toBeUndefined();
  });

  it('keeps contributed tools conservative, even when they share an internal read name', () => {
    registerPluginTools('example', [{ name: 'read_settings', description: 'External plugin', inputSchema: {} }]);
    expect(listToolGrants()[0].annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });
});
