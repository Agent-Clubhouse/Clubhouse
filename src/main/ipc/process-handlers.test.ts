import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '/usr/bin', HOME: '/home/user' })),
}));

import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { IPC } from '../../shared/ipc-channels';
import { registerProcessHandlers } from './process-handlers';

describe('process-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerProcessHandlers();
  });

  it('registers EXEC handler', () => {
    expect(handlers.has(IPC.PROCESS.EXEC)).toBe(true);
  });

  it('rejects commands with path separators', async () => {
    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: '/usr/bin/ls',
      args: [],
      allowedCommands: ['/usr/bin/ls'],
      projectPath: '/project',
    });
    expect(result).toEqual({
      stdout: '',
      stderr: 'Invalid command: "/usr/bin/ls"',
      exitCode: 1,
    });
  });

  it('rejects commands with path traversal', async () => {
    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: '..evil',
      args: [],
      allowedCommands: ['..evil'],
      projectPath: '/project',
    });
    expect(result).toEqual({
      stdout: '',
      stderr: 'Invalid command: "..evil"',
      exitCode: 1,
    });
  });

  it('rejects empty commands', async () => {
    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: '',
      args: [],
      allowedCommands: [''],
      projectPath: '/project',
    });
    expect(result).toEqual({
      stdout: '',
      stderr: 'Invalid command: ""',
      exitCode: 1,
    });
  });

  it('rejects commands not in allowedCommands list', async () => {
    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: 'rm',
      args: ['-rf', '/'],
      allowedCommands: ['ls', 'cat'],
      projectPath: '/project',
    });
    expect(result).toEqual({
      stdout: '',
      stderr: 'Command "rm" is not in allowedCommands',
      exitCode: 1,
    });
  });

  it('executes valid commands via execFile', async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        callback(null, 'output', '');
        return {} as any;
      },
    );

    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: 'ls',
      args: ['-la'],
      allowedCommands: ['ls'],
      projectPath: '/project',
    });
    expect(result).toEqual({ stdout: 'output', stderr: '', exitCode: 0 });
  });

  it('handles command timeout (killed)', async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        const err = new Error('timed out') as any;
        err.killed = true;
        callback(err, '', '');
        return {} as any;
      },
    );

    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: 'sleep',
      args: ['999'],
      allowedCommands: ['sleep'],
      projectPath: '/project',
    });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  });

  it('handles non-zero exit codes', async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        const err = new Error('not found') as any;
        err.status = 2;
        callback(err, '', 'not found');
        return {} as any;
      },
    );

    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: 'grep',
      args: ['pattern'],
      allowedCommands: ['grep'],
      projectPath: '/project',
    });
    expect(result.exitCode).toBe(2);
  });

  it('clamps timeout to valid range', async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, opts: any, callback: any) => {
        // Verify timeout was clamped to MIN_TIMEOUT (100)
        expect(opts.timeout).toBe(100);
        callback(null, '', '');
        return {} as any;
      },
    );

    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    await handler({}, {
      pluginId: 'p1',
      command: 'echo',
      args: [],
      allowedCommands: ['echo'],
      projectPath: '/project',
      options: { timeout: 1 },
    });
  });
});
