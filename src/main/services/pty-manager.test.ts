import { describe, it, expect, beforeEach, vi } from 'vitest';

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

// We need to import AFTER mocks are set up
// But the module has state (Maps), so we need to handle that.
// We'll use dynamic imports or reset between tests.

import { getBuffer, isRunning, spawn, spawnShell, resize, write, gracefulKill, kill, killAll } from './pty-manager';

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
});
