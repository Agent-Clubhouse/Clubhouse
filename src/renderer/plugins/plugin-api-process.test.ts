import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProcessAPI } from './plugin-api-process';
import type { PluginContext } from '../../shared/plugin-types';

const mockExec = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).clubhouse = {
    process: { exec: mockExec },
  };
});

describe('createProcessAPI', () => {
  const ctx: PluginContext = {
    pluginId: 'my-plugin',
    projectPath: '/project/path',
    projectId: 'proj_1',
    scope: 'project',
  };

  it('exec delegates to window.clubhouse.process.exec with pluginId', async () => {
    mockExec.mockResolvedValue({ stdout: 'output', stderr: '', exitCode: 0 });

    const api = createProcessAPI(ctx);
    const result = await api.exec('ls', ['-la']);

    expect(mockExec).toHaveBeenCalledWith({
      pluginId: 'my-plugin',
      command: 'ls',
      args: ['-la'],
      projectPath: '/project/path',
      options: undefined,
    });
    expect(result).toEqual({ stdout: 'output', stderr: '', exitCode: 0 });
  });

  it('exec passes options when provided', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    const api = createProcessAPI(ctx);
    await api.exec('node', ['script.js'], { cwd: '/other/path', timeout: 5000 });

    expect(mockExec).toHaveBeenCalledWith({
      pluginId: 'my-plugin',
      command: 'node',
      args: ['script.js'],
      projectPath: '/project/path',
      options: { cwd: '/other/path', timeout: 5000 },
    });
  });

  it('exec propagates errors from IPC', async () => {
    mockExec.mockRejectedValue(new Error('Permission denied'));

    const api = createProcessAPI(ctx);
    await expect(api.exec('rm', ['-rf', '/'])).rejects.toThrow('Permission denied');
  });

  it('uses the pluginId from context', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    const otherCtx: PluginContext = { ...ctx, pluginId: 'other-plugin' };
    const api = createProcessAPI(otherCtx);
    await api.exec('echo', ['hello']);

    expect(mockExec).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'other-plugin' }),
    );
  });
});
