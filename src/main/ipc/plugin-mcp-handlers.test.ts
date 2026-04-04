import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

vi.mock('../services/clubhouse-mcp/plugin-tool-registry', () => ({
  registerPluginTools: vi.fn(),
  removePluginTools: vi.fn(),
  listPluginTools: vi.fn(),
  resolvePluginToolCall: vi.fn(),
}));

import { ipcMain } from 'electron';
import { registerPluginTools } from '../services/clubhouse-mcp/plugin-tool-registry';
import { registerPluginMcpHandlers } from './plugin-mcp-handlers';

describe('plugin-mcp-handlers', () => {
  let contributeHandler: (...args: unknown[]) => unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    registerPluginMcpHandlers();
    // The first handle() call registers CONTRIBUTE_TOOLS
    contributeHandler = vi.mocked(ipcMain.handle).mock.calls[0][1];
  });

  describe('CONTRIBUTE_TOOLS validation', () => {
    const validTools = [
      { name: 'tool1', description: 'A tool', inputSchema: { type: 'object' } },
    ];

    it('accepts valid pluginId and tools', async () => {
      await contributeHandler({} as any, 'my-plugin', validTools);
      expect(registerPluginTools).toHaveBeenCalledWith('my-plugin', validTools);
    });

    it('rejects non-string pluginId', () => {
      expect(() => contributeHandler({} as any, 123, validTools)).toThrow('must be a string');
    });

    it('rejects empty string pluginId', () => {
      expect(() => contributeHandler({} as any, '', validTools)).toThrow('must be at least 1 character');
    });

    it('rejects non-array tools', () => {
      expect(() => contributeHandler({} as any, 'my-plugin', 'not-an-array')).toThrow('must be an array');
    });

    it('rejects tool with missing name', () => {
      const bad = [{ description: 'desc', inputSchema: { type: 'object' } }];
      expect(() => contributeHandler({} as any, 'my-plugin', bad)).toThrow('name must be a non-empty string');
    });

    it('rejects tool with missing description', () => {
      const bad = [{ name: 'tool', inputSchema: { type: 'object' } }];
      expect(() => contributeHandler({} as any, 'my-plugin', bad)).toThrow('description must be a non-empty string');
    });

    it('rejects tool with missing inputSchema', () => {
      const bad = [{ name: 'tool', description: 'desc' }];
      expect(() => contributeHandler({} as any, 'my-plugin', bad)).toThrow('inputSchema must be an object');
    });

    it('rejects tool with array inputSchema', () => {
      const bad = [{ name: 'tool', description: 'desc', inputSchema: [] }];
      expect(() => contributeHandler({} as any, 'my-plugin', bad)).toThrow('inputSchema must be an object');
    });
  });
});
