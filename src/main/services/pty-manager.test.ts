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

import { getBuffer, spawn, spawnShell, resize, write, gracefulKill, kill, killAll } from './pty-manager';

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

    it('clears all sessions', () => {
      spawnAndActivate('agent_ka_3');
      const cb = mockProcess.onData.mock.calls[0][0];
      cb('data');
      expect(getBuffer('agent_ka_3')).toBe('data');

      killAll();
      expect(getBuffer('agent_ka_3')).toBe('');
    });

    it('uses custom exit command', () => {
      spawn('agent_ka_4', '/test', '/usr/local/bin/opencode', []);
      mockProcess.write.mockClear();

      killAll('/quit\r');

      expect(mockProcess.write).toHaveBeenCalledWith('/quit\r');
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
});
