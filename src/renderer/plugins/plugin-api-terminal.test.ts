import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTerminalAPI, createRemoteTerminalIO } from './plugin-api-terminal';
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

  // ── Local project ──────────────────────────────────────────────────────

  describe('local project', () => {
    const localCtx = {
      pluginId: 'terminal',
      pluginPath: '/tmp',
      scope: 'project' as const,
      projectId: 'local-proj',
      projectPath: '/project',
      subscriptions: [],
      settings: {},
    };

    it('write() calls local pty.write', () => {
      const api = createTerminalAPI(localCtx);
      api.write('shell-1', 'hello');
      expect(window.clubhouse.pty.write).toHaveBeenCalledWith('plugin:terminal:shell-1', 'hello');
    });

    it('resize() calls local pty.resize', () => {
      const api = createTerminalAPI(localCtx);
      api.resize('shell-1', 80, 24);
      expect(window.clubhouse.pty.resize).toHaveBeenCalledWith('plugin:terminal:shell-1', 80, 24);
    });

    it('onData() subscribes to local pty.onData', () => {
      const api = createTerminalAPI(localCtx);
      const cb = vi.fn();
      api.onData('shell-1', cb);
      expect(window.clubhouse.pty.onData).toHaveBeenCalled();
    });
  });

  // ── Remote project (TerminalAPI layer) ─────────────────────────────────

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

    it('remote write does not call local pty.write', () => {
      const api = createTerminalAPI(remoteCtx);
      api.write('shell-1', 'hello');
      expect(window.clubhouse.pty.write).not.toHaveBeenCalled();
    });

    it('remote resize does not call local pty.resize', () => {
      const api = createTerminalAPI(remoteCtx);
      api.resize('shell-1', 80, 24);
      expect(window.clubhouse.pty.resize).not.toHaveBeenCalled();
    });

    it('remote getBuffer does not call local pty.getBuffer', async () => {
      const api = createTerminalAPI(remoteCtx);
      await api.getBuffer('shell-1');
      expect(window.clubhouse.pty.getBuffer).not.toHaveBeenCalled();
    });

    it('remote spawn does not call local pty.spawnShell', async () => {
      const api = createTerminalAPI(remoteCtx);
      await api.spawn('shell-1');
      expect(window.clubhouse.pty.spawnShell).not.toHaveBeenCalled();
    });
  });

  // ── Remote TerminalIO adapter (ShellTerminal wire-level I/O) ───────────
  // These tests verify that the TerminalIO adapter passed to ShellTerminal
  // for remote projects routes all I/O through the annex client and
  // satellite event buses — the same functional behaviors as local PTY.

  describe('createRemoteTerminalIO', () => {
    const SAT_ID = 'sat-456';

    it('write() routes to annexClient.ptyInput with correct satellite', () => {
      const io = createRemoteTerminalIO(SAT_ID);
      io.write('session-1', 'ls -la\n');
      expect(window.clubhouse.annexClient.ptyInput).toHaveBeenCalledWith(
        SAT_ID,
        'session-1',
        'ls -la\n',
      );
    });

    it('write() does not call local pty.write', () => {
      const io = createRemoteTerminalIO(SAT_ID);
      io.write('session-1', 'hello');
      expect(window.clubhouse.pty.write).not.toHaveBeenCalled();
    });

    it('resize() routes to annexClient.ptyResize with correct satellite', () => {
      const io = createRemoteTerminalIO(SAT_ID);
      io.resize('session-1', 120, 40);
      expect(window.clubhouse.annexClient.ptyResize).toHaveBeenCalledWith(
        SAT_ID,
        'session-1',
        120,
        40,
      );
    });

    it('resize() does not call local pty.resize', () => {
      const io = createRemoteTerminalIO(SAT_ID);
      io.resize('session-1', 80, 24);
      expect(window.clubhouse.pty.resize).not.toHaveBeenCalled();
    });

    it('getBuffer() routes to annexClient.ptyGetBuffer with correct satellite', async () => {
      const io = createRemoteTerminalIO(SAT_ID);
      await io.getBuffer('session-1');
      expect(window.clubhouse.annexClient.ptyGetBuffer).toHaveBeenCalledWith(
        SAT_ID,
        'session-1',
      );
    });

    it('getBuffer() does not call local pty.getBuffer', async () => {
      const io = createRemoteTerminalIO(SAT_ID);
      await io.getBuffer('session-1');
      expect(window.clubhouse.pty.getBuffer).not.toHaveBeenCalled();
    });

    it('onData() subscribes to satellitePtyDataBus', () => {
      const io = createRemoteTerminalIO(SAT_ID);
      const cb = vi.fn();
      io.onData(cb);
      expect(satellitePtyDataBus.on).toHaveBeenCalled();
    });

    it('onData() filters events by satellite ID', () => {
      const io = createRemoteTerminalIO(SAT_ID);
      const cb = vi.fn();
      io.onData(cb);

      const registeredListener = vi.mocked(satellitePtyDataBus.on).mock.calls[0][0];

      // Matching satellite — callback invoked
      registeredListener(SAT_ID, 'session-1', 'output data');
      expect(cb).toHaveBeenCalledWith('session-1', 'output data');

      // Non-matching satellite — callback NOT invoked
      cb.mockClear();
      registeredListener('other-sat', 'session-1', 'other data');
      expect(cb).not.toHaveBeenCalled();
    });

    it('onData() returns an unsubscribe function', () => {
      const unsubFn = vi.fn();
      vi.mocked(satellitePtyDataBus.on).mockReturnValueOnce(unsubFn);

      const io = createRemoteTerminalIO(SAT_ID);
      const unsub = io.onData(vi.fn());
      expect(typeof unsub).toBe('function');
      unsub();
      expect(unsubFn).toHaveBeenCalled();
    });

    it('onData() does not subscribe to local pty.onData', () => {
      const io = createRemoteTerminalIO(SAT_ID);
      io.onData(vi.fn());
      expect(window.clubhouse.pty.onData).not.toHaveBeenCalled();
    });

    it('onExit() subscribes to satellitePtyExitBus', () => {
      const io = createRemoteTerminalIO(SAT_ID);
      const cb = vi.fn();
      io.onExit(cb);
      expect(satellitePtyExitBus.on).toHaveBeenCalled();
    });

    it('onExit() filters events by satellite ID', () => {
      const io = createRemoteTerminalIO(SAT_ID);
      const cb = vi.fn();
      io.onExit(cb);

      const registeredListener = vi.mocked(satellitePtyExitBus.on).mock.calls[0][0];

      // Matching satellite — callback invoked
      registeredListener(SAT_ID, 'session-1', 0);
      expect(cb).toHaveBeenCalledWith('session-1', 0);

      // Non-matching satellite — callback NOT invoked
      cb.mockClear();
      registeredListener('other-sat', 'session-1', 1);
      expect(cb).not.toHaveBeenCalled();
    });

    it('onExit() returns an unsubscribe function', () => {
      const unsubFn = vi.fn();
      vi.mocked(satellitePtyExitBus.on).mockReturnValueOnce(unsubFn);

      const io = createRemoteTerminalIO(SAT_ID);
      const unsub = io.onExit(vi.fn());
      expect(typeof unsub).toBe('function');
      unsub();
      expect(unsubFn).toHaveBeenCalled();
    });

    it('onExit() does not subscribe to local pty.onExit', () => {
      const io = createRemoteTerminalIO(SAT_ID);
      io.onExit(vi.fn());
      expect(window.clubhouse.pty.onExit).not.toHaveBeenCalled();
    });

    it('passes non-zero exit codes through', () => {
      const io = createRemoteTerminalIO(SAT_ID);
      const cb = vi.fn();
      io.onExit(cb);

      const registeredListener = vi.mocked(satellitePtyExitBus.on).mock.calls[0][0];
      registeredListener(SAT_ID, 'session-1', 137);
      expect(cb).toHaveBeenCalledWith('session-1', 137);
    });
  });
});
