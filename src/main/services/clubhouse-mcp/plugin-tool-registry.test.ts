import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('plugin-tool-registry', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('registers tools with namespaced names and definitions', () => {
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
});
