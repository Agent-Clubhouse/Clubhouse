import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockHandle = vi.fn();
const mockOn = vi.fn();

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, on: mockOn },
}));

const mockRegisterPluginTools = vi.fn();
vi.mock('../services/clubhouse-mcp/plugin-tool-registry', () => ({
  registerPluginTools: (...args: unknown[]) => mockRegisterPluginTools(...args),
  removePluginTools: vi.fn(),
  listPluginTools: vi.fn(),
  resolvePluginToolCall: vi.fn(),
}));

import { registerPluginMcpHandlers } from './plugin-mcp-handlers';

describe('plugin-mcp-handlers', () => {
  let contributeHandler: (...args: unknown[]) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    registerPluginMcpHandlers();
    // The first handle() call registers CONTRIBUTE_TOOLS
    contributeHandler = mockHandle.mock.calls[0][1];
  });

  describe('CONTRIBUTE_TOOLS validation', () => {
    const validTools = [
      { name: 'tool1', description: 'A tool', inputSchema: { type: 'object' } },
    ];

    it('accepts valid pluginId and tools', async () => {
      await contributeHandler({} as any, 'my-plugin', validTools);
      expect(mockRegisterPluginTools).toHaveBeenCalledWith('my-plugin', validTools);
    });

    it('rejects non-string pluginId', async () => {
      await expect(contributeHandler({} as any, 123, validTools)).rejects.toThrow('must be a string');
    });

    it('rejects empty string pluginId', async () => {
      await expect(contributeHandler({} as any, '', validTools)).rejects.toThrow('must be at least 1 character');
    });

    it('rejects non-array tools', async () => {
      await expect(contributeHandler({} as any, 'my-plugin', 'not-an-array')).rejects.toThrow('must be an array');
    });

    it('rejects tool with missing name', async () => {
      const bad = [{ description: 'desc', inputSchema: { type: 'object' } }];
      await expect(contributeHandler({} as any, 'my-plugin', bad)).rejects.toThrow('name must be a non-empty string');
    });

    it('rejects tool with missing description', async () => {
      const bad = [{ name: 'tool', inputSchema: { type: 'object' } }];
      await expect(contributeHandler({} as any, 'my-plugin', bad)).rejects.toThrow('description must be a non-empty string');
    });

    it('rejects tool with missing inputSchema', async () => {
      const bad = [{ name: 'tool', description: 'desc' }];
      await expect(contributeHandler({} as any, 'my-plugin', bad)).rejects.toThrow('inputSchema must be an object');
    });

    it('rejects tool with array inputSchema', async () => {
      const bad = [{ name: 'tool', description: 'desc', inputSchema: [] }];
      await expect(contributeHandler({} as any, 'my-plugin', bad)).rejects.toThrow('inputSchema must be an object');
    });
  });
});
