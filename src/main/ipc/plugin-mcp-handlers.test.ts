import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() },
}));

vi.mock('../services/clubhouse-mcp/plugin-tool-registry', () => ({
  registerPluginTools: vi.fn(),
  removePluginTools: vi.fn(),
  listPluginTools: vi.fn(),
  resolvePluginToolCall: vi.fn(),
}));

import { ipcMain } from 'electron';
import { registerPluginTools, resolvePluginToolCall } from '../services/clubhouse-mcp/plugin-tool-registry';
import { IPC } from '../../shared/ipc-channels';
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

describe('registerPluginMcpHandlers registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces its own handlers and listener, so registering again never throws', () => {
    registerPluginMcpHandlers();
    registerPluginMcpHandlers();

    const removed = vi.mocked(ipcMain.removeHandler).mock.calls.map(([ch]) => ch);
    expect(removed).toEqual([
      IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS, IPC.PLUGIN_MCP.REMOVE_TOOLS, IPC.PLUGIN_MCP.LIST_TOOLS,
      IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS, IPC.PLUGIN_MCP.REMOVE_TOOLS, IPC.PLUGIN_MCP.LIST_TOOLS,
    ]);
    // Each removeHandler precedes its handle: a second handle() on a channel throws in Electron.
    const removeOrder = vi.mocked(ipcMain.removeHandler).mock.invocationCallOrder;
    const handleOrder = vi.mocked(ipcMain.handle).mock.invocationCallOrder;
    expect(removeOrder[3]).toBeLessThan(handleOrder[3]);
    // The same listener function is removed and re-added, so results never resolve twice.
    const [[, onListener]] = vi.mocked(ipcMain.on).mock.calls;
    expect(vi.mocked(ipcMain.removeListener).mock.calls[1]).toEqual([IPC.PLUGIN_MCP.TOOL_RESULT, onListener]);
  });

  it('routes a tool result from the renderer to the pending call', () => {
    registerPluginMcpHandlers();
    const [[channel, listener]] = vi.mocked(ipcMain.on).mock.calls;
    expect(channel).toBe(IPC.PLUGIN_MCP.TOOL_RESULT);

    const result = { content: [{ type: 'text' as const, text: 'ok' }] };
    (listener as (e: unknown, d: unknown) => void)({}, { callId: 'ptc_1', result });

    expect(resolvePluginToolCall).toHaveBeenCalledWith('ptc_1', result);
  });
});
