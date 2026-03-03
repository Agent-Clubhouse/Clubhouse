import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => '/home/user') },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '/usr/bin', HOME: '/home/user' })),
}));

vi.mock('../services/plugin-manifest-registry', () => ({
  getAllowedCommands: vi.fn(() => []),
}));

import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { IPC } from '../../shared/ipc-channels';
import { registerProcessHandlers } from './process-handlers';
import { getAllowedCommands } from '../services/plugin-manifest-registry';

describe('process-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    // Default: no commands allowed
    vi.mocked(getAllowedCommands).mockReturnValue([]);
    registerProcessHandlers();
  });

  it('registers EXEC handler', () => {
    expect(handlers.has(IPC.PROCESS.EXEC)).toBe(true);
  });

  // ── Security: server-side manifest enforcement ─────────────────────

  it('rejects requests with missing pluginId', async () => {
    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      command: 'ls',
      args: [],
      projectPath: '/project',
    });
    expect(result).toEqual({
      stdout: '',
      stderr: 'Missing pluginId',
      exitCode: 1,
    });
  });

  it('looks up allowedCommands from server-side registry, not IPC payload', async () => {
    // Registry says only 'git' is allowed
    vi.mocked(getAllowedCommands).mockReturnValue(['git']);

    const handler = handlers.get(IPC.PROCESS.EXEC)!;

    // Forged payload claims 'rm' is allowed — should be IGNORED
    const result = await handler({}, {
      pluginId: 'malicious-plugin',
      command: 'rm',
      args: ['-rf', '/'],
      allowedCommands: ['rm', 'bash', 'curl'], // forged — must be ignored
      projectPath: '/project',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not allowed');
    expect(getAllowedCommands).toHaveBeenCalledWith('malicious-plugin');
  });

  it('rejects command when server-side manifest has no allowedCommands', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue([]);

    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: 'ls',
      args: [],
      projectPath: '/project',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not allowed');
  });

  it('allows command when server-side manifest permits it', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['node']);
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        callback(null, 'ok', '');
        return {} as any;
      },
    );

    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: 'node',
      args: ['--version'],
      projectPath: '/project',
    });
    expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
  });

  it('rejects command not in server-side manifest even if in forged payload', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['git']);

    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: 'bash',
      args: ['-c', 'echo pwned'],
      allowedCommands: ['bash'], // forged
      projectPath: '/project',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not allowed');
  });

  // ── Command validation ─────────────────────────────────────────────

  it('rejects commands with forward slash path separators', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['/usr/bin/ls']);
    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: '/usr/bin/ls',
      args: [],
      projectPath: '/project',
    });
    expect(result).toEqual({
      stdout: '',
      stderr: 'Invalid command: "/usr/bin/ls"',
      exitCode: 1,
    });
  });

  it('rejects commands with backslash path separators', async () => {
    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: 'dir\\evil',
      args: [],
      projectPath: '/project',
    });
    expect(result).toEqual({
      stdout: '',
      stderr: 'Invalid command: "dir\\evil"',
      exitCode: 1,
    });
  });

  it('rejects commands with path traversal', async () => {
    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: '..evil',
      args: [],
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
      projectPath: '/project',
    });
    expect(result).toEqual({
      stdout: '',
      stderr: 'Invalid command: ""',
      exitCode: 1,
    });
  });

  // ── Execution behavior ─────────────────────────────────────────────

  it('executes valid commands via execFile', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['ls']);
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
      projectPath: '/project',
    });
    expect(result).toEqual({ stdout: 'output', stderr: '', exitCode: 0 });
  });

  it('handles command timeout (killed)', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['sleep']);
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
      projectPath: '/project',
    });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  });

  it('handles non-zero exit codes', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['grep']);
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
      projectPath: '/project',
    });
    expect(result.exitCode).toBe(2);
  });

  it('clamps timeout below MIN_TIMEOUT (100) to 100', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['echo']);
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, opts: any, callback: any) => {
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
      projectPath: '/project',
      options: { timeout: 1 },
    });
  });

  it('clamps timeout above MAX_TIMEOUT (60000) to 60000', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['echo']);
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, opts: any, callback: any) => {
        expect(opts.timeout).toBe(60000);
        callback(null, '', '');
        return {} as any;
      },
    );

    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    await handler({}, {
      pluginId: 'p1',
      command: 'echo',
      args: [],
      projectPath: '/project',
      options: { timeout: 999999 },
    });
  });

  it('uses DEFAULT_TIMEOUT (15000) when no timeout option provided', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['echo']);
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, opts: any, callback: any) => {
        expect(opts.timeout).toBe(15000);
        callback(null, '', '');
        return {} as any;
      },
    );

    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    await handler({}, {
      pluginId: 'p1',
      command: 'echo',
      args: [],
      projectPath: '/project',
    });
  });

  it('falls back to error.message when stderr is empty', async () => {
    vi.mocked(getAllowedCommands).mockReturnValue(['nonexistent']);
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        const err = new Error('command not found') as any;
        err.status = 127;
        callback(err, '', '');
        return {} as any;
      },
    );

    const handler = handlers.get(IPC.PROCESS.EXEC)!;
    const result = await handler({}, {
      pluginId: 'p1',
      command: 'nonexistent',
      args: [],
      projectPath: '/project',
    });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe('command not found');
  });
});
