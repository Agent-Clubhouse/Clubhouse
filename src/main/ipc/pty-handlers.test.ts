import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

vi.mock('../services/pty-manager', () => ({
  spawnShell: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  gracefulKill: vi.fn(),
  getBuffer: vi.fn(async () => 'terminal output'),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerPtyHandlers } from './pty-handlers';
import * as ptyManager from '../services/pty-manager';

describe('pty-handlers', () => {
  let handleHandlers: Map<string, (...args: any[]) => any>;
  let onHandlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handleHandlers = new Map();
    onHandlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handleHandlers.set(channel, handler);
    });
    vi.mocked(ipcMain.on).mockImplementation(((channel: string, handler: any) => {
      onHandlers.set(channel, handler);
    }) as any);
    registerPtyHandlers();
  });

  it('registers handle-based PTY handlers', () => {
    expect(handleHandlers.has(IPC.PTY.SPAWN_SHELL)).toBe(true);
    expect(handleHandlers.has(IPC.PTY.KILL)).toBe(true);
    expect(handleHandlers.has(IPC.PTY.GET_BUFFER)).toBe(true);
  });

  it('registers on-based PTY handlers for fire-and-forget operations', () => {
    expect(onHandlers.has(IPC.PTY.WRITE)).toBe(true);
    expect(onHandlers.has(IPC.PTY.RESIZE)).toBe(true);
  });

  it('SPAWN_SHELL delegates to ptyManager.spawnShell', async () => {
    const handler = handleHandlers.get(IPC.PTY.SPAWN_SHELL)!;
    await handler({}, 'agent-1', '/project');
    expect(ptyManager.spawnShell).toHaveBeenCalledWith('agent-1', '/project');
  });

  it('WRITE delegates to ptyManager.write', () => {
    const handler = onHandlers.get(IPC.PTY.WRITE)!;
    handler({}, 'agent-1', 'ls\n');
    expect(ptyManager.write).toHaveBeenCalledWith('agent-1', 'ls\n');
  });

  it('RESIZE delegates to ptyManager.resize', () => {
    const handler = onHandlers.get(IPC.PTY.RESIZE)!;
    handler({}, 'agent-1', 120, 40);
    expect(ptyManager.resize).toHaveBeenCalledWith('agent-1', 120, 40);
  });

  it('KILL delegates to ptyManager.gracefulKill', async () => {
    const handler = handleHandlers.get(IPC.PTY.KILL)!;
    await handler({}, 'agent-1');
    expect(ptyManager.gracefulKill).toHaveBeenCalledWith('agent-1');
  });

  it('GET_BUFFER delegates to ptyManager.getBuffer', async () => {
    const handler = handleHandlers.get(IPC.PTY.GET_BUFFER)!;
    const result = await handler({}, 'agent-1');
    expect(ptyManager.getBuffer).toHaveBeenCalledWith('agent-1');
    expect(result).toBe('terminal output');
  });
});
