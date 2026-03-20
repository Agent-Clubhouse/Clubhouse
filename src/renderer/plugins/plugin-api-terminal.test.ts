import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTerminalAPI } from './plugin-api-terminal';
import { satellitePtyDataBus, satellitePtyExitBus } from '../stores/annexClientStore';

// Mock dependencies
vi.mock('../stores/remoteProjectStore', () => ({
  isRemoteProjectId: (id: string) => id.startsWith('remote||'),
  parseNamespacedId: (id: string) => {
    if (!id.startsWith('remote||')) return null;
    const parts = id.replace('remote||', '').split('||');
    return { satelliteId: parts[0], agentId: parts[1] };
  },
}));

vi.mock('../stores/annexClientStore', () => ({
  satellitePtyDataBus: {
    on: vi.fn(() => vi.fn()),
    emit: vi.fn(),
  },
  satellitePtyExitBus: {
    on: vi.fn(() => vi.fn()),
    emit: vi.fn(),
  },
}));

vi.mock('../features/terminal/ShellTerminal', () => ({
  ShellTerminal: null,
}));

describe('plugin-api-terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Replace window.clubhouse methods with spies
    window.clubhouse.pty.write = vi.fn();
    window.clubhouse.pty.resize = vi.fn();
    window.clubhouse.pty.kill = vi.fn(async () => {});
    window.clubhouse.pty.getBuffer = vi.fn(async () => '');
    window.clubhouse.pty.onData = vi.fn(() => vi.fn());
    window.clubhouse.pty.onExit = vi.fn(() => vi.fn());
    window.clubhouse.pty.spawnShell = vi.fn(async () => {});
    window.clubhouse.annexClient.ptyInput = vi.fn(async () => {});
    window.clubhouse.annexClient.ptyResize = vi.fn(async () => {});
    window.clubhouse.annexClient.ptyGetBuffer = vi.fn(async () => '');
    window.clubhouse.annexClient.ptySpawnShell = vi.fn(async () => {});
  });

  describe('local project', () => {
    it('write() calls local pty.write', () => {
      const api = createTerminalAPI({
        pluginId: 'terminal',
        pluginPath: '/tmp',
        scope: 'project',
        projectId: 'local-proj',
        projectPath: '/project',
        subscriptions: [],
        settings: {},
      });
      api.write('shell-1', 'hello');
      expect(window.clubhouse.pty.write).toHaveBeenCalledWith('plugin:terminal:shell-1', 'hello');
    });

    it('resize() calls local pty.resize', () => {
      const api = createTerminalAPI({
        pluginId: 'terminal',
        pluginPath: '/tmp',
        scope: 'project',
        projectId: 'local-proj',
        projectPath: '/project',
        subscriptions: [],
        settings: {},
      });
      api.resize('shell-1', 80, 24);
      expect(window.clubhouse.pty.resize).toHaveBeenCalledWith('plugin:terminal:shell-1', 80, 24);
    });

    it('onData() subscribes to local pty.onData', () => {
      const api = createTerminalAPI({
        pluginId: 'terminal',
        pluginPath: '/tmp',
        scope: 'project',
        projectId: 'local-proj',
        projectPath: '/project',
        subscriptions: [],
        settings: {},
      });
      const cb = vi.fn();
      api.onData('shell-1', cb);
      expect(window.clubhouse.pty.onData).toHaveBeenCalled();
    });
  });

  describe('remote project', () => {
    const remoteCtx = {
      pluginId: 'terminal',
      pluginPath: '/tmp',
      scope: 'project' as const,
      projectId: 'remote||sat-123||proj-abc',
      projectPath: '__remote__',
      subscriptions: [],
      settings: {},
    };

    it('write() routes through annexClient.ptyInput', () => {
      const api = createTerminalAPI(remoteCtx);
      api.write('shell-1', 'hello');
      expect(window.clubhouse.annexClient.ptyInput).toHaveBeenCalledWith(
        'sat-123',
        'plugin:terminal:shell-1',
        'hello',
      );
    });

    it('resize() routes through annexClient.ptyResize', () => {
      const api = createTerminalAPI(remoteCtx);
      api.resize('shell-1', 80, 24);
      expect(window.clubhouse.annexClient.ptyResize).toHaveBeenCalledWith(
        'sat-123',
        'plugin:terminal:shell-1',
        80,
        24,
      );
    });

    it('getBuffer() routes through annexClient.ptyGetBuffer', async () => {
      const api = createTerminalAPI(remoteCtx);
      await api.getBuffer('shell-1');
      expect(window.clubhouse.annexClient.ptyGetBuffer).toHaveBeenCalledWith(
        'sat-123',
        'plugin:terminal:shell-1',
      );
    });

    it('spawn() routes through annexClient.ptySpawnShell', async () => {
      const api = createTerminalAPI(remoteCtx);
      await api.spawn('shell-1');
      expect(window.clubhouse.annexClient.ptySpawnShell).toHaveBeenCalledWith(
        'sat-123',
        'plugin:terminal:shell-1',
        'proj-abc',
      );
    });

    it('onData() subscribes to satellitePtyDataBus', () => {
      const api = createTerminalAPI(remoteCtx);
      const cb = vi.fn();
      api.onData('shell-1', cb);
      expect(satellitePtyDataBus.on).toHaveBeenCalled();
    });

    it('onExit() subscribes to satellitePtyExitBus', () => {
      const api = createTerminalAPI(remoteCtx);
      const cb = vi.fn();
      api.onExit('shell-1', cb);
      expect(satellitePtyExitBus.on).toHaveBeenCalled();
    });

    it('kill() sends Ctrl+C and exit via ptyInput', async () => {
      const api = createTerminalAPI(remoteCtx);
      await api.kill('shell-1');
      expect(window.clubhouse.annexClient.ptyInput).toHaveBeenCalledWith(
        'sat-123',
        'plugin:terminal:shell-1',
        '\x03\nexit\n',
      );
    });
  });
});
