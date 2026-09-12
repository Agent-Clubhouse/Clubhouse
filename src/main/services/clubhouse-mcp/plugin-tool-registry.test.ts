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
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import {
  _resetForTesting,
  listPluginTools,
  registerPluginTools,
  removePluginTools,
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
});
