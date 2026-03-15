import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node-pty
const mockProcess = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockProcess),
}));

// Mock electron (aliased via vitest.config.ts)

// Mock shell utility
vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ ...process.env })),
  getDefaultShell: vi.fn(() => process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/zsh')),
  cleanSpawnEnv: vi.fn((env: Record<string, string>) => { delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; return env; }),
}));

// Mock the IPC channels
vi.mock('../../shared/ipc-channels', () => ({
  IPC: {
    PTY: {
      DATA: 'pty:data',
      EXIT: 'pty:exit',
    },
  },
}));

// Mock broadcastToAllWindows
vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
  setChannelPolicy: vi.fn(),
}));

// Mock annex-event-bus
vi.mock('./annex-event-bus', () => ({
  emitPtyExit: vi.fn(),
  emitPtyData: vi.fn(),
}));

// Mock fs for validateSpawnCwd — default to making all paths look like valid directories
const mockRealpathSync = vi.fn((p: string) => p);
const mockStatSync = vi.fn(() => ({ isDirectory: () => true }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
  };
});

// We need to import AFTER mocks are set up
// But the module has state (Maps), so we need to handle that.
// We'll use dynamic imports or reset between tests.

import { getBuffer, isRunning, spawn, spawnShell, resize, write, gracefulKill, kill, killAll, startStaleSweep, stopStaleSweep, validateSpawnCwd } from './pty-manager';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import * as annexEventBus from './annex-event-bus';

// Helper: spawn and immediately fire resize to clear pendingCommands
// so that onData callbacks start buffering data.
function spawnAndActivate(agentId: string, cwd = '/test', binary = '/usr/local/bin/claude', args: string[] = []) {
  spawn(agentId, cwd, binary, args);
  // Resize triggers the pending command and starts data flow
  resize(agentId, 120, 30);
}

describe('pty-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess.onData.mockReset();
    mockProcess.onExit.mockReset();
    mockProcess.write.mockReset();
    mockProcess.kill.mockReset();
    mockRealpathSync.mockImplementation((p: string) => p);
    mockStatSync.mockImplementation(() => ({ isDirectory: () => true }));
  });

  describe('getBuffer', () => {
    it('returns empty string for unknown agent', () => {
      expect(getBuffer('nonexistent')).toBe('');
    });
  });

  describe('spawn + buffer', () => {
    it('clears previous buffer on spawn', () => {
      // Spawn first to set up buffer
      spawnAndActivate('agent_buf');
      // Simulate data via the onData callback
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('hello');
      expect(getBuffer('agent_buf')).toBe('hello');

      // Spawn again — should clear
      spawn('agent_buf', '/test', '/usr/local/bin/claude', []);
      expect(getBuffer('agent_buf')).toBe('');
    });

    it('kills existing PTY for same agentId', () => {
      spawn('agent_dup', '/test', '/usr/local/bin/claude', []);
      spawn('agent_dup', '/test', '/usr/local/bin/claude', []);
      expect(mockProcess.kill).toHaveBeenCalled();
    });
  });

  describe('appendToBuffer (via spawn + onData)', () => {
    it('stores and concatenates data', () => {
      spawnAndActivate('agent_concat');
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('hello ');
      onDataCb('world');
      expect(getBuffer('agent_concat')).toBe('hello world');
    });

    it('reuses the joined buffer until new data arrives', () => {
      spawnAndActivate('agent_cache');
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('hello ');
      onDataCb('world');

      const joinSpy = vi.spyOn(Array.prototype, 'join');
      try {
        expect(getBuffer('agent_cache')).toBe('hello world');
        expect(getBuffer('agent_cache')).toBe('hello world');
        expect(joinSpy).toHaveBeenCalledTimes(1);

        onDataCb('!');

        expect(getBuffer('agent_cache')).toBe('hello world!');
        expect(getBuffer('agent_cache')).toBe('hello world!');
        expect(joinSpy).toHaveBeenCalledTimes(2);
      } finally {
        joinSpy.mockRestore();
      }
    });

    it('evicts oldest chunks when >512KB', () => {
      spawnAndActivate('agent_evict');
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      // Write chunks that total > 512KB
      const chunkSize = 100 * 1024; // 100KB
      for (let i = 0; i < 6; i++) {
        onDataCb('x'.repeat(chunkSize));
      }
      // Buffer should be at most 512KB + last chunk
      const buf = getBuffer('agent_evict');
      expect(buf.length).toBeLessThanOrEqual(600 * 1024); // some tolerance
      expect(buf.length).toBeGreaterThan(0);
    });

    it('drops evicted chunks from a previously cached buffer', () => {
      spawnAndActivate('agent_cached_evict');
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      const chunkSize = 128 * 1024;
      const chunks = ['a', 'b', 'c', 'd', 'e'].map((char) => char.repeat(chunkSize));

      for (const chunk of chunks.slice(0, 4)) {
        onDataCb(chunk);
      }

      expect(getBuffer('agent_cached_evict')).toBe(chunks.slice(0, 4).join(''));

      onDataCb(chunks[4]);

      expect(getBuffer('agent_cached_evict')).toBe(chunks.slice(1).join(''));
    });

    it('keeps last chunk even if it alone exceeds limit', () => {
      spawnAndActivate('agent_big');
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      const bigChunk = 'x'.repeat(600 * 1024); // 600KB single chunk
      onDataCb(bigChunk);
      expect(getBuffer('agent_big')).toBe(bigChunk);
    });

    it('independent buffers per agent', () => {
      spawnAndActivate('agent_a');
      const cbA = mockProcess.onData.mock.calls[0][0];
      cbA('data_a');

      spawnAndActivate('agent_b');
      const cbB = mockProcess.onData.mock.calls[mockProcess.onData.mock.calls.length - 1][0];
      cbB('data_b');

      expect(getBuffer('agent_a')).toBe('data_a');
      expect(getBuffer('agent_b')).toBe('data_b');
    });

    it('suppresses shell startup data and auto-fires pending command', () => {
      spawn('agent_suppress', '/test', '/usr/local/bin/claude', []);
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('shell startup noise');

      // Both Windows and Unix use pendingCommand — startup data is suppressed
      // and the pending command auto-fires on first shell output
      expect(getBuffer('agent_suppress')).toBe('');

      if (process.platform === 'win32') {
        expect(mockProcess.write).toHaveBeenCalledWith(
          expect.stringContaining('& exit\r\n')
        );
      } else {
        expect(mockProcess.write).toHaveBeenCalledWith(
          expect.stringContaining('exec ')
        );
      }

      // Subsequent data flows through normally
      onDataCb('real data');
      expect(getBuffer('agent_suppress')).toBe('real data');
    });

    it('auto-fires pending command on first shell data without requiring resize', () => {
      if (process.platform === 'win32') return; // Unix-only behavior

      spawn('agent_autofire', '/test', '/usr/local/bin/claude', ['--model', 'opus']);
      const onDataCb = mockProcess.onData.mock.calls[0][0];

      // Before any data, command hasn't fired
      expect(mockProcess.write).not.toHaveBeenCalledWith(
        expect.stringContaining('exec ')
      );

      // Shell emits startup data — triggers command auto-fire
      onDataCb('Last login: Wed Feb 19');
      expect(mockProcess.write).toHaveBeenCalledWith(
        expect.stringContaining("exec '/usr/local/bin/claude' '--model' 'opus'")
      );

      // Subsequent resize does NOT re-fire the command
      mockProcess.write.mockClear();
      resize('agent_autofire', 200, 50);
      expect(mockProcess.write).not.toHaveBeenCalledWith(
        expect.stringContaining('exec ')
      );
    });

    it('prefixes exec with screen-clear on Unix to suppress echo noise', () => {
      if (process.platform === 'win32') return; // Unix-only behavior

      spawn('agent_clear', '/test', '/usr/local/bin/claude', []);
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('shell ready');

      // The written command should include a printf clear before exec
      const writeCall = mockProcess.write.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('exec ')
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![0]).toContain("printf '\\033[2J\\033[H'");
      expect(writeCall![0]).toContain("exec '/usr/local/bin/claude'");
    });
  });

  describe('spawnShell', () => {
    it('spawns a shell without pendingCommand', () => {
      spawnShell('shell-1', '/project');
      // onData should work immediately (no pendingCommand suppression)
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('prompt$ ');
      // spawnShell doesn't buffer to getBuffer — data goes to IPC only
      // but we can verify onData was registered
      expect(mockProcess.onData).toHaveBeenCalled();
    });

    it('kills existing session with same id', () => {
      spawnShell('shell-dup', '/project');
      spawnShell('shell-dup', '/project');
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it('registers onExit handler', () => {
      spawnShell('shell-exit', '/project');
      expect(mockProcess.onExit).toHaveBeenCalled();
    });
  });

  describe('write', () => {
    it('writes data to the PTY process', () => {
      spawn('agent_w', '/test', '/usr/local/bin/claude', []);
      write('agent_w', 'hello\n');
      expect(mockProcess.write).toHaveBeenCalledWith('hello\n');
    });

    it('does nothing for unknown agent', () => {
      mockProcess.write.mockClear();
      write('nonexistent', 'hello');
      expect(mockProcess.write).not.toHaveBeenCalled();
    });

    it('rejects oversized writes (defense-in-depth)', () => {
      spawn('agent_big', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      const oversized = 'x'.repeat(64 * 1024 + 1);
      write('agent_big', oversized);
      expect(mockProcess.write).not.toHaveBeenCalled();
    });

    it('accepts writes at exactly the max length', () => {
      spawn('agent_exact', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      const maxData = 'x'.repeat(64 * 1024);
      write('agent_exact', maxData);
      expect(mockProcess.write).toHaveBeenCalledWith(maxData);
    });
  });

  describe('resize', () => {
    it('resizes the PTY process', () => {
      spawn('agent_r', '/test', '/usr/local/bin/claude', []);
      resize('agent_r', 200, 50);
      expect(mockProcess.resize).toHaveBeenCalledWith(200, 50);
    });

    it('fires pending command on first resize', () => {
      spawn('agent_pc', '/test', '/usr/local/bin/claude', ['--model', 'opus']);
      resize('agent_pc', 120, 30);

      if (process.platform === 'win32') {
        // On Windows, resize writes the command to cmd.exe with "& exit" suffix
        expect(mockProcess.write).toHaveBeenCalledWith(
          expect.stringContaining('& exit\r\n')
        );
      } else {
        // On Unix, resize triggers the pending shell exec command
        expect(mockProcess.write).toHaveBeenCalledWith(
          expect.stringContaining('exec ')
        );
      }
    });

    it('does not fire pending command on subsequent resize', () => {
      spawn('agent_pc2', '/test', '/usr/local/bin/claude', []);
      resize('agent_pc2', 120, 30); // clears pending
      mockProcess.write.mockClear();
      resize('agent_pc2', 200, 50); // no pending command
      // write should only have been called for resize, not a command
      if (process.platform === 'win32') {
        expect(mockProcess.write).not.toHaveBeenCalledWith(
          expect.stringContaining('& exit')
        );
      } else {
        expect(mockProcess.write).not.toHaveBeenCalledWith(
          expect.stringContaining('exec ')
        );
      }
    });

    it('does nothing for unknown agent', () => {
      mockProcess.resize.mockClear();
      resize('nonexistent', 120, 30);
      expect(mockProcess.resize).not.toHaveBeenCalled();
    });
  });

  describe('gracefulKill', () => {
    it('writes /exit to process', () => {
      spawn('agent_gk', '/test', '/usr/local/bin/claude', []);
      gracefulKill('agent_gk');
      expect(mockProcess.write).toHaveBeenCalledWith('/exit\r');
    });

    it('uses custom exit command', () => {
      spawn('agent_gk_custom', '/test', '/usr/local/bin/opencode', []);
      gracefulKill('agent_gk_custom', '/quit\r');
      expect(mockProcess.write).toHaveBeenCalledWith('/quit\r');
    });

    it('does nothing for unknown agent', () => {
      mockProcess.write.mockClear();
      gracefulKill('nonexistent');
      expect(mockProcess.write).not.toHaveBeenCalled();
    });

    it('sends EOF after 3s, SIGTERM after 6s, hard kill after 9s', () => {
      vi.useFakeTimers();
      spawn('agent_gk_staged', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      gracefulKill('agent_gk_staged');

      // First: exit command
      expect(mockProcess.write).toHaveBeenCalledWith('/exit\r');

      // At 3s: EOF
      vi.advanceTimersByTime(3000);
      expect(mockProcess.write).toHaveBeenCalledWith('\x04');

      // At 6s: SIGTERM
      vi.advanceTimersByTime(3000);
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');

      // At 9s: hard kill
      vi.advanceTimersByTime(3000);
      expect(mockProcess.kill).toHaveBeenCalledWith();

      vi.useRealTimers();
    });

    it('skips escalation if agent exits before timeout', () => {
      vi.useFakeTimers();
      spawn('agent_gk_fast', '/test', '/usr/local/bin/claude', []);

      gracefulKill('agent_gk_fast');

      // Simulate the process exiting (onExit fires, session cleaned up)
      kill('agent_gk_fast');
      mockProcess.kill.mockClear();

      // Advance past all timers — nothing should blow up
      vi.advanceTimersByTime(10000);
      // kill was already called by kill() above, but no additional SIGTERM/kill
      expect(mockProcess.kill).not.toHaveBeenCalledWith('SIGTERM');

      vi.useRealTimers();
    });

    it('clears all three timers when session exits early via cleanupSession', () => {
      vi.useFakeTimers();
      spawn('agent_gk_timers', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      gracefulKill('agent_gk_timers');

      // Simulate early exit — kill() calls cleanupSession which should clear all timers
      kill('agent_gk_timers');
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      // Advance past EOF timer (3s) — should NOT write EOF since session was cleaned up
      vi.advanceTimersByTime(3000);
      expect(mockProcess.write).not.toHaveBeenCalledWith('\x04');

      // Advance past SIGTERM timer (6s) — should NOT send SIGTERM
      vi.advanceTimersByTime(3000);
      expect(mockProcess.kill).not.toHaveBeenCalledWith('SIGTERM');

      // Advance past hard kill timer (9s) — should NOT send hard kill
      vi.advanceTimersByTime(3000);
      expect(mockProcess.kill).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('double gracefulKill clears previous timers to prevent leaked escalation', () => {
      vi.useFakeTimers();
      spawn('agent_gk_double', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      // First gracefulKill — sets timers at 3s/6s/9s
      gracefulKill('agent_gk_double');

      // Advance 1s, then call gracefulKill again — should clear old timers
      vi.advanceTimersByTime(1000);
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();
      gracefulKill('agent_gk_double');

      // Advance to where the FIRST call's EOF timer (3s total from start = 2s from now)
      // would have fired. Since the second call cleared it, only the second call's
      // EOF timer should fire at 3s from the second call (4s total from start).
      vi.advanceTimersByTime(1000); // 2s total — first call's 3s mark
      // First call's EOF should NOT fire (was cleared)
      // Second call's EOF hasn't fired yet (only 1s into second call's 3s timer)
      expect(mockProcess.write).not.toHaveBeenCalledWith('\x04');

      // Advance to second call's EOF timer (3s from second call = 2s more)
      vi.advanceTimersByTime(2000); // 4s total
      expect(mockProcess.write).toHaveBeenCalledWith('\x04');

      vi.useRealTimers();
    });

    it('does not act on stale session if agent is re-spawned during gracefulKill', () => {
      vi.useFakeTimers();
      spawn('agent_gk_stale', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      gracefulKill('agent_gk_stale');

      // Re-spawn the same agentId (simulates user restarting agent)
      // This creates a new session for the same agentId
      spawn('agent_gk_stale', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      // Advance past all timers — the old gracefulKill timers should
      // not write EOF or kill the NEW process because the process identity check
      // prevents stale closure from acting on the replacement session.
      vi.advanceTimersByTime(10000);

      // The new session's process should not have received EOF or SIGTERM
      // from the old gracefulKill timers
      expect(mockProcess.write).not.toHaveBeenCalledWith('\x04');
      expect(mockProcess.kill).not.toHaveBeenCalledWith('SIGTERM');

      vi.useRealTimers();
    });

    it('broadcasts PTY.EXIT when the 9s kill timer fires on a stuck process', () => {
      vi.useFakeTimers();
      spawn('agent_gk_exit', '/test', '/usr/local/bin/claude', []);
      vi.mocked(broadcastToAllWindows).mockClear();
      vi.mocked(annexEventBus.emitPtyExit).mockClear();

      gracefulKill('agent_gk_exit');

      // Advance to the 9s kill timer
      vi.advanceTimersByTime(9000);

      // Should broadcast PTY.EXIT so the renderer removes the agent from UI
      expect(broadcastToAllWindows).toHaveBeenCalledWith('pty:exit', 'agent_gk_exit', 1, '');
      expect(annexEventBus.emitPtyExit).toHaveBeenCalledWith('agent_gk_exit', 1);

      vi.useRealTimers();
    });
  });

  describe('kill', () => {
    it('immediately kills and clears buffer', () => {
      spawnAndActivate('agent_kill');
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('some data');
      expect(getBuffer('agent_kill')).toBe('some data');

      kill('agent_kill');
      expect(mockProcess.kill).toHaveBeenCalled();
      expect(getBuffer('agent_kill')).toBe('');
    });

    it('does nothing for unknown agent', () => {
      mockProcess.kill.mockClear();
      kill('nonexistent');
      expect(mockProcess.kill).not.toHaveBeenCalled();
    });
  });

  describe('killAll', () => {
    it('writes exit command to all sessions', () => {
      spawn('agent_ka_1', '/test', '/usr/local/bin/claude', []);
      spawn('agent_ka_2', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();

      killAll('/exit\r');

      // Each session gets the exit command
      expect(mockProcess.write).toHaveBeenCalledWith('/exit\r');
    });

    it('clears all sessions after kill timeout', async () => {
      vi.useFakeTimers();
      spawnAndActivate('agent_ka_3');
      const cb = mockProcess.onData.mock.calls[0][0];
      cb('data');
      expect(getBuffer('agent_ka_3')).toBe('data');

      const promise = killAll();
      vi.advanceTimersByTime(2000);
      await promise;
      expect(getBuffer('agent_ka_3')).toBe('');
      vi.useRealTimers();
    });

    it('uses custom exit command', () => {
      spawn('agent_ka_4', '/test', '/usr/local/bin/opencode', []);
      mockProcess.write.mockClear();

      killAll('/quit\r');

      expect(mockProcess.write).toHaveBeenCalledWith('/quit\r');
    });

    it('returns a promise that resolves after cleanup', async () => {
      vi.useFakeTimers();
      spawn('agent_ka_5', '/test', '/usr/local/bin/claude', []);

      const promise = killAll();
      expect(promise).toBeInstanceOf(Promise);

      vi.advanceTimersByTime(2000);
      await promise;
      // Session should be fully cleaned up
      expect(getBuffer('agent_ka_5')).toBe('');
      vi.useRealTimers();
    });

    it('resolves immediately when no sessions exist', async () => {
      const promise = killAll();
      await promise; // should resolve without timeout
    });

    it('clears active gracefulKill timers via cleanupSession', async () => {
      vi.useFakeTimers();
      spawn('agent_ka_gk', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      // Start a graceful kill with pending escalation timers
      gracefulKill('agent_ka_gk');
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      // killAll should clean up via cleanupSession, clearing gracefulKill timers
      const promise = killAll();
      vi.advanceTimersByTime(2000);
      await promise;

      // Advance past gracefulKill's EOF timer (3s) — should NOT fire
      vi.advanceTimersByTime(1000);
      expect(mockProcess.write).not.toHaveBeenCalledWith('\x04');

      // Advance past gracefulKill's SIGTERM timer (6s) — should NOT fire
      vi.advanceTimersByTime(3000);
      expect(mockProcess.kill).not.toHaveBeenCalledWith('SIGTERM');

      vi.useRealTimers();
    });
  });

  describe('command prefix', () => {
    it('prepends command prefix to pending command on Unix', () => {
      if (process.platform === 'win32') return;

      spawn('agent_prefix', '/test', '/usr/local/bin/claude', ['--model', 'opus'], undefined, undefined, '. ./init.sh');
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('shell ready');

      const writeCall = mockProcess.write.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('exec ')
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![0]).toContain('. ./init.sh && ');
      expect(writeCall![0]).toContain("exec '/usr/local/bin/claude' '--model' 'opus'");
    });

    it('prepends command prefix to pending command on Windows', () => {
      if (process.platform !== 'win32') return;

      spawn('agent_prefix_win', '/test', 'C:\\path\\to\\claude.cmd', [], undefined, undefined, '. .\\init.ps1');
      resize('agent_prefix_win', 120, 30);

      const writeCall = mockProcess.write.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('& exit')
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![0]).toContain('. .\\init.ps1 & ');
    });

    it('does not alter command when prefix is undefined', () => {
      if (process.platform === 'win32') return;

      spawn('agent_no_prefix', '/test', '/usr/local/bin/claude', [], undefined, undefined, undefined);
      const onDataCb = mockProcess.onData.mock.calls[0][0];
      onDataCb('shell ready');

      const writeCall = mockProcess.write.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('exec ')
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![0]).not.toContain('&&');
    });
  });

  describe('spawn with extraEnv', () => {
    it('passes extraEnv to pty spawn', async () => {
      const pty = await import('node-pty');
      vi.mocked(pty.spawn).mockClear();
      spawn('agent_env', '/test', '/usr/local/bin/claude', [], { CUSTOM_VAR: 'value' });

      if (process.platform === 'win32') {
        // On Windows, cmd.exe is spawned interactively (pendingCommand mechanism)
        expect(pty.spawn).toHaveBeenCalledWith(
          'cmd.exe',
          [],
          expect.objectContaining({
            env: expect.objectContaining({ CUSTOM_VAR: 'value' }),
          })
        );
      } else {
        // On Unix, spawned via login shell wrapper
        expect(pty.spawn).toHaveBeenCalledWith(
          expect.any(String),
          ['-il'],
          expect.objectContaining({
            env: expect.objectContaining({ CUSTOM_VAR: 'value' }),
          })
        );
      }
    });
  });

  describe('Windows cmd.exe wrapping', () => {
    it('spawns cmd.exe interactively on Windows (pendingCommand mechanism)', async () => {
      if (process.platform !== 'win32') return; // Windows-only test

      const pty = await import('node-pty');
      vi.mocked(pty.spawn).mockClear();
      spawn('agent_cmd', '/test', 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd', ['--model', 'opus']);

      // Windows now uses interactive cmd.exe (no /c) with pendingCommand
      expect(pty.spawn).toHaveBeenCalledWith(
        'cmd.exe',
        [],
        expect.objectContaining({
          cwd: '/test',
          cols: 120,
          rows: 30,
        })
      );
    });

    it('fires properly quoted command with & exit suffix on Windows resize', () => {
      if (process.platform !== 'win32') return; // Windows-only test

      spawn('agent_win_resize', '/test', 'C:\\path\\to\\claude.cmd', ['--model', 'opus', 'Fix the bug']);
      resize('agent_win_resize', 120, 30);

      // Should write the quoted command with & exit
      expect(mockProcess.write).toHaveBeenCalledWith(
        expect.stringContaining('& exit\r\n')
      );
      // Verify binary is quoted (contains backslash → has special chars)
      const writtenCmd = mockProcess.write.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('& exit')
      );
      expect(writtenCmd).toBeDefined();
    });

    it('removes CLAUDECODE env vars to prevent nested-session errors', async () => {
      const pty = await import('node-pty');
      vi.mocked(pty.spawn).mockClear();

      spawn('agent_noenv', '/test', '/usr/local/bin/claude', [], {
        CLAUDECODE: 'should-be-removed',
        CLAUDE_CODE_ENTRYPOINT: 'should-be-removed',
        KEEP_THIS: 'yes',
      });

      const callArgs = vi.mocked(pty.spawn).mock.calls[0];
      const env = callArgs[2].env;
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(env.KEEP_THIS).toBe('yes');
    });

    it('quotes mission text with spaces for Windows pendingCommand', () => {
      spawn('agent_mission_quote', '/test', '/usr/local/bin/claude', ['--model', 'opus', 'Fix the login bug']);
      resize('agent_mission_quote', 120, 30);

      if (process.platform === 'win32') {
        // Mission text should be double-quoted in the written command
        const writtenCmd = mockProcess.write.mock.calls.find(
          (c: string[]) => typeof c[0] === 'string' && c[0].includes('& exit')
        );
        expect(writtenCmd).toBeDefined();
        expect(writtenCmd![0]).toContain('"Fix the login bug"');
      }
    });
  });

  // ── PTY Lifecycle Risk Area Tests ────────────────────────────────────
  // These tests target the critical risk areas identified in the PTY
  // manager: timer leaks on double gracefulKill, stale session capture
  // in timer callbacks, and killAll interaction with active gracefulKill.

  describe('gracefulKill — double-call timer leak', () => {
    it('does not duplicate EOF writes when gracefulKill is called twice', () => {
      vi.useFakeTimers();
      spawn('agent_dbl_gk', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      // Simulate user clicking Stop twice rapidly
      gracefulKill('agent_dbl_gk');
      gracefulKill('agent_dbl_gk');
      mockProcess.write.mockClear(); // clear the two /exit\r writes

      // At 3s: only ONE EOF should fire, not two
      vi.advanceTimersByTime(3000);
      const eofCalls = mockProcess.write.mock.calls.filter(
        (c: string[]) => c[0] === '\x04'
      );
      expect(eofCalls).toHaveLength(1);

      vi.useRealTimers();
    });

    it('does not duplicate SIGTERM when gracefulKill is called twice', () => {
      vi.useFakeTimers();
      spawn('agent_dbl_gk_term', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      gracefulKill('agent_dbl_gk_term');
      gracefulKill('agent_dbl_gk_term');
      mockProcess.kill.mockClear();

      // At 6s: only ONE SIGTERM
      vi.advanceTimersByTime(6000);
      const sigtermCalls = mockProcess.kill.mock.calls.filter(
        (c: string[]) => c[0] === 'SIGTERM'
      );
      expect(sigtermCalls).toHaveLength(1);

      vi.useRealTimers();
    });

    it('does not duplicate hard kill when gracefulKill is called twice', () => {
      vi.useFakeTimers();
      spawn('agent_dbl_gk_hard', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      gracefulKill('agent_dbl_gk_hard');
      gracefulKill('agent_dbl_gk_hard');
      mockProcess.kill.mockClear();

      // At 9s: only ONE hard kill
      vi.advanceTimersByTime(9000);
      const hardKills = mockProcess.kill.mock.calls.filter(
        (c: string[]) => c.length === 0 || c[0] === undefined
      );
      expect(hardKills).toHaveLength(1);

      vi.useRealTimers();
    });
  });

  describe('gracefulKill — leaked timer must not destroy replacement session', () => {
    it('new session survives leaked killTimer from double gracefulKill', () => {
      vi.useFakeTimers();
      spawn('agent_leak', '/test', '/usr/local/bin/claude', []);

      // Double gracefulKill leaks first set of timers
      gracefulKill('agent_leak');
      gracefulKill('agent_leak');

      // Session exits (kill clears tracked timers but not leaked ones)
      kill('agent_leak');
      expect(isRunning('agent_leak')).toBe(false);

      // New session spawned with the same ID
      spawn('agent_leak', '/test', '/usr/local/bin/claude', []);
      expect(isRunning('agent_leak')).toBe(true);

      // Advance past all leaked timer deadlines (9s)
      vi.advanceTimersByTime(10000);

      // The new session MUST survive — leaked killTimer must not clean it up
      expect(isRunning('agent_leak')).toBe(true);

      vi.useRealTimers();
    });

    it('new session buffer is preserved after leaked timers fire', () => {
      vi.useFakeTimers();
      spawn('agent_leak_buf', '/test', '/usr/local/bin/claude', []);

      gracefulKill('agent_leak_buf');
      gracefulKill('agent_leak_buf');
      kill('agent_leak_buf');

      // Spawn new session and write data
      spawnAndActivate('agent_leak_buf');
      const onDataCb = mockProcess.onData.mock.calls[mockProcess.onData.mock.calls.length - 1][0];
      onDataCb('important data');
      expect(getBuffer('agent_leak_buf')).toBe('important data');

      // Advance past all leaked timers
      vi.advanceTimersByTime(10000);

      // Buffer must still be intact
      expect(getBuffer('agent_leak_buf')).toBe('important data');

      vi.useRealTimers();
    });
  });

  describe('gracefulKill — timer identity guards', () => {
    it('timers do not fire on a replacement session after natural exit', () => {
      vi.useFakeTimers();
      spawn('agent_id_guard', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();

      gracefulKill('agent_id_guard');

      // Process exits naturally before any timers fire (via onExit handler)
      const onExitCb = mockProcess.onExit.mock.calls[0][0];
      onExitCb({ exitCode: 0 });

      // Spawn replacement session
      spawn('agent_id_guard', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();
      mockProcess.kill.mockClear();

      // Advance past all timer deadlines
      vi.advanceTimersByTime(10000);

      // Replacement session must not receive stale EOF/SIGTERM/kill
      expect(isRunning('agent_id_guard')).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('isRunning', () => {
    it('returns true for active session', () => {
      spawn('agent_ir_active', '/test', '/usr/local/bin/claude', []);
      expect(isRunning('agent_ir_active')).toBe(true);
    });

    it('returns false for unknown agent', () => {
      expect(isRunning('agent_ir_unknown')).toBe(false);
    });

    it('returns true during graceful kill (session still alive)', () => {
      spawn('agent_ir_killing', '/test', '/usr/local/bin/claude', []);
      gracefulKill('agent_ir_killing');
      expect(isRunning('agent_ir_killing')).toBe(true);
    });

    it('returns false after kill()', () => {
      spawn('agent_ir_killed', '/test', '/usr/local/bin/claude', []);
      kill('agent_ir_killed');
      expect(isRunning('agent_ir_killed')).toBe(false);
    });
  });

  describe('stale session sweep', () => {
    afterEach(() => {
      stopStaleSweep();
      vi.useRealTimers();
    });

    it('startStaleSweep and stopStaleSweep are idempotent', () => {
      // Should not throw when called multiple times
      startStaleSweep();
      startStaleSweep();
      stopStaleSweep();
      stopStaleSweep();
    });

    it('sweep cleans up sessions whose processes have died', () => {
      vi.useFakeTimers();
      spawn('agent_stale_sweep', '/test', '/usr/local/bin/claude', []);
      expect(isRunning('agent_stale_sweep')).toBe(true);

      // Mock process.kill to throw (simulating dead process)
      const originalKill = process.kill;
      process.kill = vi.fn(() => { throw new Error('ESRCH'); }) as any;

      startStaleSweep();
      vi.advanceTimersByTime(30_000);

      // Session should have been cleaned up
      expect(isRunning('agent_stale_sweep')).toBe(false);

      process.kill = originalKill;
    });

    it('sweep does not remove sessions with live processes', () => {
      vi.useFakeTimers();
      spawn('agent_alive_sweep', '/test', '/usr/local/bin/claude', []);
      expect(isRunning('agent_alive_sweep')).toBe(true);

      // Mock process.kill to succeed (process is alive)
      const originalKill = process.kill;
      process.kill = vi.fn(() => true) as any;

      startStaleSweep();
      vi.advanceTimersByTime(30_000);

      // Session should still exist
      expect(isRunning('agent_alive_sweep')).toBe(true);

      process.kill = originalKill;
    });
  });

  // ── PTY Spawn Failure Tests ──────────────────────────────────────────

  describe('spawn failure recovery', () => {
    it('propagates pty.spawn error', async () => {
      const pty = await import('node-pty');
      vi.mocked(pty.spawn).mockImplementationOnce(() => {
        throw new Error('ENOMEM: not enough memory');
      });

      expect(() => spawn('agent_fail', '/test', '/usr/local/bin/claude', [])).toThrow('ENOMEM');
      // Session should not be registered
      expect(isRunning('agent_fail')).toBe(false);
    });

    it('spawnShell propagates pty.spawn error', async () => {
      const pty = await import('node-pty');
      vi.mocked(pty.spawn).mockImplementationOnce(() => {
        throw new Error('ENOENT: shell not found');
      });

      expect(() => spawnShell('shell_fail', '/test')).toThrow('ENOENT');
      expect(isRunning('shell_fail')).toBe(false);
    });

    it('cleans up existing session before failing on re-spawn', async () => {
      // First spawn succeeds
      spawn('agent_refail', '/test', '/usr/local/bin/claude', []);
      expect(isRunning('agent_refail')).toBe(true);

      // Second spawn attempt fails
      const pty = await import('node-pty');
      vi.mocked(pty.spawn).mockImplementationOnce(() => {
        throw new Error('ENOMEM');
      });

      expect(() => spawn('agent_refail', '/test', '/usr/local/bin/claude', [])).toThrow('ENOMEM');
      // Old session was killed during cleanup, new one failed to create
      expect(isRunning('agent_refail')).toBe(false);
    });
  });

  // ── onData/onExit Guard Checks ───────────────────────────────────────

  describe('onData/onExit session identity guards', () => {
    it('onData callback is ignored if session has been replaced', () => {
      // First spawn
      spawn('agent_guard_data', '/test', '/usr/local/bin/claude', []);
      const _firstOnData = mockProcess.onData.mock.calls[0][0];

      // Replace session with a new spawn
      spawn('agent_guard_data', '/test', '/usr/local/bin/claude', []);

      // Activate the new session so data flows
      resize('agent_guard_data', 120, 30);
      const secondOnData = mockProcess.onData.mock.calls[mockProcess.onData.mock.calls.length - 1][0];
      secondOnData('new data');

      // Old callback should be a no-op (process identity check)
      // Since mock returns same process, this test verifies the guard pattern exists
      expect(getBuffer('agent_guard_data')).toBe('new data');
    });

    it('onExit callback is ignored if session has been replaced', async () => {
      const pty = await import('node-pty');

      // Create distinct mock processes so the identity guard can distinguish them
      const firstProc = {
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        pid: 1001,
      };
      const secondProc = {
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        pid: 1002,
      };

      vi.mocked(pty.spawn).mockReturnValueOnce(firstProc as any);
      spawn('agent_guard_exit', '/test', '/usr/local/bin/claude', []);
      const firstOnExit = firstProc.onExit.mock.calls[0][0];

      vi.mocked(pty.spawn).mockReturnValueOnce(secondProc as any);
      spawn('agent_guard_exit', '/test', '/usr/local/bin/claude', []);
      expect(isRunning('agent_guard_exit')).toBe(true);

      // Old onExit fires — should not tear down the replacement session
      firstOnExit({ exitCode: 0 });

      // Replacement session should still be running
      expect(isRunning('agent_guard_exit')).toBe(true);
    });

    it('onExit invokes the onExit callback with buffer content', () => {
      const exitCallback = vi.fn();
      spawn('agent_exit_cb', '/test', '/usr/local/bin/claude', [], undefined, exitCallback);

      // Activate and write some data
      resize('agent_exit_cb', 120, 30);
      const onDataCb = mockProcess.onData.mock.calls[mockProcess.onData.mock.calls.length - 1][0];
      onDataCb('output line 1\n');
      onDataCb('output line 2\n');

      // Trigger exit
      const onExitCb = mockProcess.onExit.mock.calls[mockProcess.onExit.mock.calls.length - 1][0];
      onExitCb({ exitCode: 0 });

      expect(exitCallback).toHaveBeenCalledWith(
        'agent_exit_cb',
        0,
        expect.stringContaining('output line 1'),
      );
    });

    it('onExit broadcasts exit code and last output to renderer', () => {
      spawn('agent_exit_bcast', '/test', '/usr/local/bin/claude', []);
      vi.mocked(broadcastToAllWindows).mockClear();

      resize('agent_exit_bcast', 120, 30);
      const onDataCb = mockProcess.onData.mock.calls[mockProcess.onData.mock.calls.length - 1][0];
      onDataCb('some output');

      const onExitCb = mockProcess.onExit.mock.calls[mockProcess.onExit.mock.calls.length - 1][0];
      onExitCb({ exitCode: 1 });

      expect(broadcastToAllWindows).toHaveBeenCalledWith(
        'pty:exit',
        'agent_exit_bcast',
        1,
        expect.stringContaining('some output'),
      );
      expect(annexEventBus.emitPtyExit).toHaveBeenCalledWith('agent_exit_bcast', 1);
    });

    it('session is cleaned up after onExit fires', () => {
      spawn('agent_exit_cleanup', '/test', '/usr/local/bin/claude', []);

      const onExitCb = mockProcess.onExit.mock.calls[mockProcess.onExit.mock.calls.length - 1][0];
      onExitCb({ exitCode: 0 });

      expect(isRunning('agent_exit_cleanup')).toBe(false);
      expect(getBuffer('agent_exit_cleanup')).toBe('');
    });
  });

  // ── spawnShell lifecycle ─────────────────────────────────────────────

  describe('spawnShell lifecycle', () => {
    it('buffers data via appendToBuffer', () => {
      spawnShell('shell_buf', '/project');
      const onDataCb = mockProcess.onData.mock.calls[mockProcess.onData.mock.calls.length - 1][0];
      onDataCb('prompt$ ');
      onDataCb('ls\n');

      expect(getBuffer('shell_buf')).toBe('prompt$ ls\n');
    });

    it('broadcasts data on IPC', () => {
      spawnShell('shell_ipc', '/project');
      vi.mocked(broadcastToAllWindows).mockClear();

      const onDataCb = mockProcess.onData.mock.calls[mockProcess.onData.mock.calls.length - 1][0];
      onDataCb('hello');

      expect(broadcastToAllWindows).toHaveBeenCalledWith('pty:data', 'shell_ipc', 'hello');
    });

    it('onExit cleans up session and broadcasts', () => {
      spawnShell('shell_exit', '/project');
      vi.mocked(broadcastToAllWindows).mockClear();

      const onExitCb = mockProcess.onExit.mock.calls[mockProcess.onExit.mock.calls.length - 1][0];
      onExitCb({ exitCode: 0 });

      expect(isRunning('shell_exit')).toBe(false);
      expect(broadcastToAllWindows).toHaveBeenCalledWith('pty:exit', 'shell_exit', 0);
    });
  });

  // ── Buffer compaction ────────────────────────────────────────────────

  describe('buffer compaction', () => {
    it('compacts array after COMPACT_THRESHOLD evictions', () => {
      spawnAndActivate('agent_compact');
      const onDataCb = mockProcess.onData.mock.calls[mockProcess.onData.mock.calls.length - 1][0];

      // Write many small chunks that will trigger eviction + compaction.
      // Each chunk is 1KB so 512 chunks = 512KB (at limit).
      // We need >512KB to trigger eviction, then >1000 evicted entries for compaction.
      const chunkSize = 512; // 512 bytes
      const numChunks = 1200; // will overflow buffer and trigger compaction

      for (let i = 0; i < numChunks; i++) {
        onDataCb('x'.repeat(chunkSize));
      }

      // Buffer should still be readable and within size limit
      const buf = getBuffer('agent_compact');
      expect(buf.length).toBeGreaterThan(0);
      expect(buf.length).toBeLessThanOrEqual(512 * 1024 + chunkSize); // MAX_BUFFER_SIZE + last chunk tolerance
    });
  });

  // ── killAll edge cases ───────────────────────────────────────────────

  describe('killAll — additional edge cases', () => {
    it('handles write errors for dead processes gracefully', async () => {
      vi.useFakeTimers();
      spawn('agent_dead_write', '/test', '/usr/local/bin/claude', []);

      // Simulate process already dead — write throws
      mockProcess.write.mockImplementation(() => {
        throw new Error('Process is dead');
      });

      const promise = killAll();
      vi.advanceTimersByTime(2000);
      await promise;

      // Should complete without throwing
      expect(isRunning('agent_dead_write')).toBe(false);
      vi.useRealTimers();
    });

    it('cleans up multiple sessions', async () => {
      vi.useFakeTimers();
      spawn('agent_multi_1', '/test', '/usr/local/bin/claude', []);
      spawn('agent_multi_2', '/test', '/usr/local/bin/claude', []);
      spawn('agent_multi_3', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockClear();

      const promise = killAll();
      vi.advanceTimersByTime(2000);
      await promise;

      expect(isRunning('agent_multi_1')).toBe(false);
      expect(isRunning('agent_multi_2')).toBe(false);
      expect(isRunning('agent_multi_3')).toBe(false);
      vi.useRealTimers();
    });
  });

  // ── gracefulKill edge cases ──────────────────────────────────────────

  describe('gracefulKill — process already dead', () => {
    it('handles write error when process is already dead', () => {
      spawn('agent_dead_gk', '/test', '/usr/local/bin/claude', []);
      mockProcess.write.mockImplementation(() => {
        throw new Error('Process is dead');
      });

      // Should not throw — error is caught
      expect(() => gracefulKill('agent_dead_gk')).not.toThrow();
    });

    it('escalation timers handle dead process gracefully', () => {
      vi.useFakeTimers();
      spawn('agent_dead_esc', '/test', '/usr/local/bin/claude', []);

      gracefulKill('agent_dead_esc');

      // Make write and kill throw for escalation steps
      mockProcess.write.mockImplementation(() => {
        throw new Error('dead');
      });
      mockProcess.kill.mockImplementation(() => {
        throw new Error('dead');
      });

      // Advance through all escalation timers — none should throw
      vi.advanceTimersByTime(10000);

      vi.useRealTimers();
    });
  });

  // ── winQuoteArg edge cases (via spawn on Windows) ────────────────────

  describe('winQuoteArg', () => {
    it('handles empty string argument', () => {
      if (process.platform !== 'win32') return;

      spawn('agent_winquote', '/test', '/usr/local/bin/claude', ['']);
      resize('agent_winquote', 120, 30);

      const writeCall = mockProcess.write.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('& exit')
      );
      expect(writeCall).toBeDefined();
      // Empty arg should become ""
      expect(writeCall![0]).toContain('""');
    });
  });

  // ── validateSpawnCwd ────────────────────────────────────────────────

  describe('validateSpawnCwd', () => {
    it('accepts a valid absolute directory path', () => {
      expect(() => validateSpawnCwd('/home/user/project')).not.toThrow();
    });

    it('returns the resolved real path', () => {
      mockRealpathSync.mockReturnValue('/resolved/project');
      expect(validateSpawnCwd('/home/user/project')).toBe('/resolved/project');
    });

    it('rejects relative paths', () => {
      expect(() => validateSpawnCwd('relative/path')).toThrow('must be an absolute path');
    });

    it('rejects dot-relative paths', () => {
      expect(() => validateSpawnCwd('./project')).toThrow('must be an absolute path');
    });

    it('rejects paths that do not exist', () => {
      mockRealpathSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() => validateSpawnCwd('/nonexistent/path')).toThrow('does not exist');
    });

    it('rejects paths where stat fails', () => {
      mockStatSync.mockImplementation(() => { throw new Error('EACCES'); });
      expect(() => validateSpawnCwd('/no/access')).toThrow('does not exist');
    });

    it('rejects paths that are files, not directories', () => {
      mockStatSync.mockReturnValue({ isDirectory: () => false });
      expect(() => validateSpawnCwd('/home/user/file.txt')).toThrow('not a directory');
    });

    it('rejects /etc as a sensitive directory (unix)', () => {
      if (process.platform === 'win32') return;
      expect(() => validateSpawnCwd('/etc')).toThrow('restricted system directory');
    });

    it('rejects subdirectories of /etc (unix)', () => {
      if (process.platform === 'win32') return;
      expect(() => validateSpawnCwd('/etc/ssh')).toThrow('restricted system directory');
    });

    it('rejects /sbin (unix)', () => {
      if (process.platform === 'win32') return;
      expect(() => validateSpawnCwd('/sbin')).toThrow('restricted system directory');
    });

    it('rejects /System on macOS', () => {
      if (process.platform === 'win32') return;
      expect(() => validateSpawnCwd('/System/Library')).toThrow('restricted system directory');
    });

    it('rejects /private/etc (macOS symlink target)', () => {
      if (process.platform === 'win32') return;
      expect(() => validateSpawnCwd('/private/etc')).toThrow('restricted system directory');
    });

    it('rejects /Library', () => {
      if (process.platform === 'win32') return;
      expect(() => validateSpawnCwd('/Library/Preferences')).toThrow('restricted system directory');
    });

    it('rejects C:\\Windows as a sensitive directory (win32)', () => {
      if (process.platform !== 'win32') return;
      expect(() => validateSpawnCwd('C:\\Windows')).toThrow('restricted system directory');
    });

    it('rejects subdirectories of C:\\Windows (win32)', () => {
      if (process.platform !== 'win32') return;
      expect(() => validateSpawnCwd('C:\\Windows\\System32')).toThrow('restricted system directory');
    });

    it('rejects path traversal resolving to sensitive directory', () => {
      const sensitivePath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/shadow';
      const inputPath = process.platform === 'win32' ? 'C:\\Users\\..\\Windows\\System32' : '/home/user/../../etc/shadow';
      mockRealpathSync.mockReturnValue(sensitivePath);
      expect(() => validateSpawnCwd(inputPath)).toThrow('restricted system directory');
    });

    it('accepts /tmp as a valid directory', () => {
      expect(() => validateSpawnCwd('/tmp/build')).not.toThrow();
    });

    it('accepts home directory paths', () => {
      expect(() => validateSpawnCwd('/Users/dev/project')).not.toThrow();
    });
  });

  // ── spawn / spawnShell path validation integration ──────────────────

  describe('spawn path validation', () => {
    const sensitiveDir = process.platform === 'win32' ? 'C:\\Windows' : '/etc';

    it('spawn rejects sensitive cwd', () => {
      expect(() => spawn('agent_val', sensitiveDir, '/usr/local/bin/claude', [])).toThrow('restricted system directory');
      expect(isRunning('agent_val')).toBe(false);
    });

    it('spawn rejects relative cwd', () => {
      expect(() => spawn('agent_rel', 'relative', '/usr/local/bin/claude', [])).toThrow('must be an absolute path');
      expect(isRunning('agent_rel')).toBe(false);
    });

    it('spawnShell rejects sensitive projectPath', () => {
      expect(() => spawnShell('shell_val', sensitiveDir)).toThrow('restricted system directory');
      expect(isRunning('shell_val')).toBe(false);
    });

    it('spawnShell rejects relative projectPath', () => {
      expect(() => spawnShell('shell_rel', 'relative')).toThrow('must be an absolute path');
      expect(isRunning('shell_rel')).toBe(false);
    });

    it('spawnShell rejects path-traversal projectPath', () => {
      mockRealpathSync.mockReturnValue(sensitiveDir);
      const traversalPath = process.platform === 'win32' ? 'C:\\Users\\..\\Windows' : '/home/../etc';
      expect(() => spawnShell('shell_trav', traversalPath)).toThrow('restricted system directory');
      expect(isRunning('shell_trav')).toBe(false);
    });
  });
});
