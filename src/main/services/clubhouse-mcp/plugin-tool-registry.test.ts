import { beforeEach, describe, expect, it } from 'vitest';
import type { PluginManifest } from '../../../shared/plugin-types';
import { clear as clearManifestRegistry, registerTrustedManifest } from '../plugin-manifest-registry';
import { listPluginTools, registerPluginTools, _resetForTesting } from './plugin-tool-registry';

function makeManifest(permissions: PluginManifest['permissions'] = []): PluginManifest {
  return {
    id: 'test-plugin',
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
  });

  it('rejects registration when the plugin lacks the mcp.tools permission', () => {
    registerTrustedManifest('test-plugin', makeManifest(['files']));

    expect(() => registerPluginTools('test-plugin', [
      { name: 'tool1', description: 'A test tool', inputSchema: { type: 'object', properties: {} } },
    ])).toThrow(/requires 'mcp.tools' permission/);
    expect(listPluginTools('test-plugin')).toEqual([]);
  });

  it('registers tools when the plugin has the mcp.tools permission', () => {
    registerTrustedManifest('test-plugin', makeManifest(['mcp.tools']));

    expect(() => registerPluginTools('test-plugin', [
      { name: 'tool1', description: 'A test tool', inputSchema: { type: 'object', properties: {} } },
    ])).not.toThrow();
    expect(listPluginTools('test-plugin')).toEqual(['plugin__test_plugin__tool1']);
  });
});
