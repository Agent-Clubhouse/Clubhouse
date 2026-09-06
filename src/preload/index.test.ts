import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, send, exposeInMainWorld } = vi.hoisted(() => ({
  invoke: vi.fn(),
  send: vi.fn(),
  exposeInMainWorld: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, send, on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

import { api } from './index';

describe('preload IPC bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue('bridge-result');
  });

  describe('pty', () => {
    it('marshals shell creation and returns the handler result', async () => {
      await expect(api.pty.spawnShell('agent-1', '/projects/demo')).resolves.toBe('bridge-result');
      expect(invoke).toHaveBeenCalledWith('pty:spawn-shell', 'agent-1', '/projects/demo');
    });

    it('uses send for terminal writes and preserves argument order', () => {
      api.pty.write('agent-1', 'echo hello');
      api.pty.resize('agent-1', 120, 40);

      expect(send).toHaveBeenNthCalledWith(1, 'pty:write', 'agent-1', 'echo hello');
      expect(send).toHaveBeenNthCalledWith(2, 'pty:resize', 'agent-1', 120, 40);
    });

    it('returns buffer data from the exact channel', async () => {
      invoke.mockResolvedValue('buffer contents');

      await expect(api.pty.getBuffer('agent-1')).resolves.toBe('buffer contents');
      expect(invoke).toHaveBeenCalledWith('pty:get-buffer', 'agent-1');
    });
  });

  describe('project', () => {
    it('lists projects without adding arguments', async () => {
      await expect(api.project.list()).resolves.toBe('bridge-result');
      expect(invoke).toHaveBeenCalledWith('project:list');
    });

    it('marshals project updates in order and returns the result', async () => {
      const updates = { name: 'Renamed' };

      await expect(api.project.update('project-1', updates)).resolves.toBe('bridge-result');
      expect(invoke).toHaveBeenCalledWith('project:update', 'project-1', updates);
    });

    it('passes icon data to the crop channel', async () => {
      await expect(api.project.saveCroppedIcon('project-1', 'data:image/png;base64,abc'))
        .resolves.toBe('bridge-result');
      expect(invoke).toHaveBeenCalledWith(
        'project:save-cropped-icon',
        'project-1',
        'data:image/png;base64,abc',
      );
    });
  });

  describe('plugin storage', () => {
    it('passes storage read requests as one request object', async () => {
      const request = { pluginId: 'plugin-1', scope: 'project', key: 'token', projectPath: '/demo' };

      await expect(api.plugin.storageRead(request)).resolves.toBe('bridge-result');
      expect(invoke).toHaveBeenCalledWith('plugin:storage-read', request);
    });

    it('marshals storage writes and preserves the value', async () => {
      const request = { pluginId: 'plugin-1', scope: 'global', key: 'settings', value: { enabled: true } };

      await expect(api.plugin.storageWrite(request)).resolves.toBe('bridge-result');
      expect(invoke).toHaveBeenCalledWith('plugin:storage-write', request);
    });

    it('uses the delete and list storage channels', async () => {
      const request = { pluginId: 'plugin-1', scope: 'global', key: 'settings' };
      const listRequest = { pluginId: 'plugin-1', scope: 'global' };
      invoke
        .mockResolvedValueOnce('delete-result')
        .mockResolvedValueOnce('list-result');

      await expect(api.plugin.storageDelete(request)).resolves.toBe('delete-result');
      await expect(api.plugin.storageList(listRequest)).resolves.toBe('list-result');

      expect(invoke).toHaveBeenNthCalledWith(1, 'plugin:storage-delete', request);
      expect(invoke).toHaveBeenNthCalledWith(2, 'plugin:storage-list', listRequest);
    });
  });

  describe('agents', () => {
    it('lists durable agents with the project path', async () => {
      await expect(api.agent.listDurable('/projects/demo')).resolves.toBe('bridge-result');
      expect(invoke).toHaveBeenCalledWith('agent:list-durable', '/projects/demo');
    });

    it('creates durable agents with every positional option intact', async () => {
      await expect(api.agent.createDurable(
        '/projects/demo',
        'Builder',
        '#ff00aa',
        'model',
        true,
        'orchestrator',
        false,
        ['mcp-1'],
        { 'mcp-1': { mode: 'safe' } },
        true,
        'persona',
      )).resolves.toBe('bridge-result');

      expect(invoke).toHaveBeenCalledWith(
        'agent:create-durable',
        '/projects/demo',
        'Builder',
        '#ff00aa',
        'model',
        true,
        'orchestrator',
        false,
        ['mcp-1'],
        { 'mcp-1': { mode: 'safe' } },
        true,
        'persona',
      );
    });

    it('passes agent updates and returns the handler result', async () => {
      const updates = { name: 'Builder 2', emoji: 'rocket' };

      await expect(api.agent.updateDurable('/projects/demo', 'agent-1', updates))
        .resolves.toBe('bridge-result');
      expect(invoke).toHaveBeenCalledWith(
        'agent:update-durable',
        '/projects/demo',
        'agent-1',
        updates,
      );
    });

    it('marshals transcript page parameters in order', async () => {
      await expect(api.agent.readTranscriptPage('agent-1', 20, 10)).resolves.toBe('bridge-result');
      expect(invoke).toHaveBeenCalledWith(
        'agent:read-transcript-page',
        'agent-1',
        20,
        10,
      );
    });
  });
});
