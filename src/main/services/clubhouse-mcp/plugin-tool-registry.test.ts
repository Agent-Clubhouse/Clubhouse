import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '../../../shared/plugin-types';
import { clear as clearManifestRegistry, registerTrustedManifest } from '../plugin-manifest-registry';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
const { fromId } = vi.hoisted(() => ({ fromId: vi.fn((): unknown => undefined) }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => 'test-clubhouse' },
  webContents: { fromId },
}));

import {
  _resetForTesting,
  listPluginTools,
  registerPluginTools,
  removePluginTools,
  resolvePluginToolCall,
} from './plugin-tool-registry';
import { _resetForTesting as resetToolRegistry, callTool, getScopedToolList } from './tool-registry';
import { bindingManager } from './binding-manager';
import { _resetForTesting as resetTokens, claimIssuer, issueToken } from './plugin-mcp-tokens';

const PAGE = 7;

function makeManifest(id: string, permissions: PluginManifest['permissions'] = []): PluginManifest {
  return {
    id,
    name: 'Test Plugin',
    version: '1.0.0',
    engine: { api: 0.9 },
    scope: 'project',
    permissions,
    contributes: { help: {} },
  };
}

function trust(pluginId: string): void {
  registerTrustedManifest(pluginId, makeManifest(pluginId, ['mcp.tools']));
}

const tool = (name: string) => ({ name, description: `${name} tool`, inputSchema: {} });

/** Bind an agent to one plugin's tools and return the tool names it sees. */
function toolsSeenBy(agentId: string): string[] {
  return getScopedToolList(agentId).map(t => t.name).filter(n => n.startsWith('plugin__'));
}

describe('plugin-tool-registry', () => {
  let secret: string;
  const send = vi.fn();

  beforeEach(() => {
    clearManifestRegistry();
    _resetForTesting();
    resetToolRegistry();
    resetTokens();
    bindingManager._resetForTesting();
    vi.clearAllMocks();
    fromId.mockImplementation((id: unknown) => (id === PAGE ? { send, isDestroyed: () => false } : undefined));
    secret = claimIssuer(PAGE);
  });

  it('registers tools with namespaced names and definitions', () => {
    trust('my-plugin');
    registerPluginTools('my-plugin', [
      { name: 'lookup', description: 'Look up a value', inputSchema: { properties: { key: { type: 'string' } }, required: ['key'] } },
    ]);
    bindingManager.bind('agent-1', { targetId: 'my-plugin', targetKind: 'plugin', label: 'My plugin' });

    expect(listPluginTools('my-plugin')).toEqual(['plugin__my_plugin__lookup']);
    expect(getScopedToolList('agent-1').find(t => t.name === 'plugin__my_plugin__lookup')).toEqual({
      name: 'plugin__my_plugin__lookup',
      description: 'Look up a value',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    });
  });

  it("replaces and removes a plugin's existing tools", () => {
    trust('my-plugin');
    bindingManager.bind('agent-1', { targetId: 'my-plugin', targetKind: 'plugin', label: 'My plugin' });
    registerPluginTools('my-plugin', [tool('old')]);
    registerPluginTools('my-plugin', [tool('new')]);

    expect(listPluginTools('my-plugin')).toEqual(['plugin__my_plugin__new']);
    expect(toolsSeenBy('agent-1')).toEqual(['plugin__my_plugin__new']);

    removePluginTools('my-plugin');
    expect(listPluginTools('my-plugin')).toEqual([]);
    expect(toolsSeenBy('agent-1')).toEqual([]);
  });

  it('rejects registration when the plugin lacks the mcp.tools permission', () => {
    registerTrustedManifest('test-plugin', makeManifest('test-plugin', ['files']));

    expect(() => registerPluginTools('test-plugin', [tool('tool1')])).toThrow(/requires 'mcp.tools' permission/);
    expect(listPluginTools('test-plugin')).toEqual([]);
  });

  describe('collisions (#2065 point 2)', () => {
    it('two plugins can both contribute `lookup`: A lookup, then B [search, lookup]', () => {
      trust('plugin-a');
      trust('plugin-b');
      registerPluginTools('plugin-a', [tool('lookup')]);
      expect(() => registerPluginTools('plugin-b', [tool('search'), tool('lookup')])).not.toThrow();

      expect(listPluginTools('plugin-a')).toEqual(['plugin__plugin_a__lookup']);
      expect(listPluginTools('plugin-b')).toEqual(['plugin__plugin_b__search', 'plugin__plugin_b__lookup']);

      // Removing B removes both of B's, leaving A's lookup: nothing orphaned.
      bindingManager.bind('agent-1', { targetId: 'plugin-a', targetKind: 'plugin', label: 'A' });
      bindingManager.bind('agent-2', { targetId: 'plugin-b', targetKind: 'plugin', label: 'B' });
      removePluginTools('plugin-b');
      expect(toolsSeenBy('agent-2')).toEqual([]);
      expect(toolsSeenBy('agent-1')).toEqual(['plugin__plugin_a__lookup']);
    });

    it.each([
      ['a duplicate name', [tool('search'), tool('lookup'), tool('lookup')]],
      ['an invalid name', [tool('search'), tool('bad name!')]],
    ])('is all or nothing: %s registers none of the set and keeps the previous one', (_label, tools) => {
      trust('plugin-b');
      bindingManager.bind('agent-1', { targetId: 'plugin-b', targetKind: 'plugin', label: 'B' });
      registerPluginTools('plugin-b', [tool('previous')]);

      expect(() => registerPluginTools('plugin-b', tools)).toThrow();

      expect(listPluginTools('plugin-b')).toEqual(['plugin__plugin_b__previous']);
      expect(toolsSeenBy('agent-1')).toEqual(['plugin__plugin_b__previous']);
    });
  });

  describe('per-plugin exposure (#2065 point 3)', () => {
    beforeEach(() => {
      trust('plugin-a');
      trust('plugin-b');
      registerPluginTools('plugin-a', [tool('lookup')]);
      registerPluginTools('plugin-b', [tool('search'), tool('lookup')]);
    });

    it("a binding to one plugin exposes that plugin's tools and no other's", () => {
      bindingManager.bind('agent-1', { targetId: 'plugin-a', targetKind: 'plugin', label: 'A' });
      expect(toolsSeenBy('agent-1')).toEqual(['plugin__plugin_a__lookup']);
    });

    it('a plugin binding whose target is not a plugin exposes nothing', () => {
      bindingManager.bind('agent-1', { targetId: 'anything', targetKind: 'plugin', label: 'X' });
      expect(toolsSeenBy('agent-1')).toEqual([]);
    });

    it("calls reach the bound plugin's handler, and another plugin's tool name is refused", async () => {
      issueToken(PAGE, secret, 'plugin-a');
      bindingManager.bind('agent-1', { targetId: 'plugin-a', targetKind: 'plugin', label: 'A' });

      const call = callTool('agent-1', 'plugin__plugin_a__lookup', { key: 'x' });
      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      const sent = send.mock.calls[0][1] as { callId: string; pluginId: string; toolName: string };
      expect(sent).toMatchObject({ pluginId: 'plugin-a', toolName: 'lookup', args: { key: 'x' } });
      expect(resolvePluginToolCall(sent.callId, { content: [{ type: 'text', text: 'ok' }] }, 'plugin-a')).toBe(true);
      await expect(call).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });

      await expect(callTool('agent-1', 'plugin__plugin_b__search', {})).resolves.toMatchObject({ isError: true });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('a call to a plugin no window holds a token for fails at once', async () => {
      bindingManager.bind('agent-1', { targetId: 'plugin-b', targetKind: 'plugin', label: 'B' });
      await expect(callTool('agent-1', 'plugin__plugin_b__search', {})).resolves.toEqual({
        content: [{ type: 'text', text: 'Plugin plugin-b is not active in any window' }],
        isError: true,
      });
    });
  });

  describe('in-flight tool calls', () => {
    /** Start a call to `pluginId`'s `lookup`, as an agent would through the MCP bridge. */
    async function startCall(pluginId: string, agentId: string) {
      trust(pluginId);
      issueToken(PAGE, secret, pluginId);
      registerPluginTools(pluginId, [tool('lookup')]);
      bindingManager.bind(agentId, { targetId: pluginId, targetKind: 'plugin', label: pluginId });
      const before = send.mock.calls.length;
      const result = callTool(agentId, `plugin__${pluginId.replace(/[^a-zA-Z0-9]/g, '_')}__lookup`, { key: 'x' });
      await vi.waitFor(() => expect(send.mock.calls.length).toBe(before + 1));
      const { callId } = send.mock.calls.at(-1)![1] as { callId: string };
      return { result, callId };
    }

    it('uses unguessable call ids', async () => {
      const { callId } = await startCall('my-plugin', 'agent-1');
      expect(callId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('only the plugin the call was sent to can answer it', async () => {
      const mine = await startCall('my-plugin', 'agent-1');
      expect(resolvePluginToolCall(mine.callId, { content: [{ type: 'text', text: 'spoofed' }] }, 'other-plugin')).toBe(false);
      expect(resolvePluginToolCall(mine.callId, { content: [{ type: 'text', text: 'real' }] }, 'my-plugin')).toBe(true);
      await expect(mine.result).resolves.toEqual({ content: [{ type: 'text', text: 'real' }] });
    });

    it('removing a plugin settles its in-flight calls at once instead of after the timeout', async () => {
      const mine = await startCall('my-plugin', 'agent-1');
      const other = await startCall('other-plugin', 'agent-2');

      removePluginTools('my-plugin');

      await expect(mine.result).resolves.toEqual({
        content: [{ type: 'text', text: 'Plugin my-plugin was removed before answering the tool call' }],
        isError: true,
      });
      // Another plugin's call is untouched and still answerable.
      resolvePluginToolCall(other.callId, { content: [{ type: 'text', text: 'ok' }] }, 'other-plugin');
      await expect(other.result).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    });
  });
});
