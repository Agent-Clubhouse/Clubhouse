import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '../../../shared/plugin-types';
import { clear as clearManifestRegistry, registerTrustedManifest } from '../plugin-manifest-registry';

const { registerToolTemplate, unregisterToolTemplate } = vi.hoisted(() => ({
  registerToolTemplate: vi.fn(),
  unregisterToolTemplate: vi.fn(),
}));

vi.mock('./tool-registry', () => ({
  registerToolTemplate,
  unregisterToolTemplate,
  sanitizeId: (id: string) => id.replace(/[^a-zA-Z0-9]/g, '_'),
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
const { getAllWindows } = vi.hoisted(() => ({ getAllWindows: vi.fn((): unknown[] => []) }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows },
}));

import {
  _resetForTesting,
  listPluginTools,
  registerPluginTools,
  removePluginTools,
  resolvePluginToolCall,
} from './plugin-tool-registry';

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

describe('plugin-tool-registry', () => {
  beforeEach(() => {
    clearManifestRegistry();
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('registers tools with namespaced names and definitions', () => {
    registerTrustedManifest('my-plugin', makeManifest('my-plugin', ['mcp.tools']));
    registerPluginTools('my-plugin', [
      {
        name: 'lookup',
        description: 'Look up a value',
        inputSchema: { properties: { key: { type: 'string' } }, required: ['key'] },
      },
    ]);

    expect(listPluginTools('my-plugin')).toEqual(['plugin__my_plugin__lookup']);
    expect(registerToolTemplate).toHaveBeenCalledWith(
      'plugin',
      'lookup',
      {
        description: 'Look up a value',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
      },
      expect.any(Function),
    );
  });

  it("replaces and removes a plugin's existing tools", () => {
    registerTrustedManifest('my-plugin', makeManifest('my-plugin', ['mcp.tools']));
    registerPluginTools('my-plugin', [
      { name: 'old', description: 'Old', inputSchema: {} },
    ]);
    registerPluginTools('my-plugin', [
      { name: 'new', description: 'New', inputSchema: {} },
    ]);

    expect(unregisterToolTemplate).toHaveBeenCalledWith('plugin', 'old');
    expect(listPluginTools('my-plugin')).toEqual(['plugin__my_plugin__new']);

    removePluginTools('my-plugin');
    expect(unregisterToolTemplate).toHaveBeenCalledWith('plugin', 'new');
    expect(listPluginTools('my-plugin')).toEqual([]);
  });

  it('rejects registration when the plugin lacks the mcp.tools permission', () => {
    registerTrustedManifest('test-plugin', makeManifest('test-plugin', ['files']));

    expect(() => registerPluginTools('test-plugin', [
      { name: 'tool1', description: 'A test tool', inputSchema: { type: 'object', properties: {} } },
    ])).toThrow(/requires 'mcp.tools' permission/);
    expect(listPluginTools('test-plugin')).toEqual([]);
  });

  it('registers tools when the plugin has the mcp.tools permission', () => {
    registerTrustedManifest('test-plugin', makeManifest('test-plugin', ['mcp.tools']));

    expect(() => registerPluginTools('test-plugin', [
      { name: 'tool1', description: 'A test tool', inputSchema: { type: 'object', properties: {} } },
    ])).not.toThrow();
    expect(listPluginTools('test-plugin')).toEqual(['plugin__test_plugin__tool1']);
  });

  describe('in-flight tool calls', () => {
    const send = vi.fn();
    beforeEach(() => {
      send.mockReset();
      getAllWindows.mockReturnValue([{ webContents: { send } }]);
    });

    /** Start a call to `pluginId`'s first tool, as an agent would through the MCP bridge. */
    function startCall(pluginId: string) {
      registerTrustedManifest(pluginId, makeManifest(pluginId, ['mcp.tools']));
      registerPluginTools(pluginId, [{ name: 'lookup', description: 'd', inputSchema: {} }]);
      const handler = vi.mocked(registerToolTemplate).mock.calls.at(-1)![3] as (t: string, a: string, args: object) => Promise<unknown>;
      const result = handler('target', 'agent', { key: 'x' });
      const { callId } = send.mock.calls.at(-1)![1] as { callId: string };
      return { result, callId };
    }

    it('uses unguessable call ids', () => {
      const { callId } = startCall('my-plugin');
      expect(callId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('removing a plugin settles its in-flight calls at once instead of after the timeout', async () => {
      vi.useFakeTimers();
      try {
        const mine = startCall('my-plugin');
        const other = startCall('other-plugin');

        removePluginTools('my-plugin');

        await expect(mine.result).resolves.toEqual({
          content: [{ type: 'text', text: 'Plugin my-plugin was removed before answering the tool call' }],
          isError: true,
        });
        // Another plugin's call is untouched and still answerable.
        resolvePluginToolCall(other.callId, { content: [{ type: 'text', text: 'ok' }] });
        await expect(other.result).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
