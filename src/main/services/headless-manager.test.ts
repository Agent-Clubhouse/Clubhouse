import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

// --- Mocks ---

// Mock electron
const mockSend = vi.fn();
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: { send: (...args: unknown[]) => mockSend(...args) },
    }],
  },
}));

// Mock fs
const mockWriteStream = {
  write: vi.fn(),
  end: vi.fn(),
};
const mockCreateReadStream = vi.hoisted(() => vi.fn());
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    createWriteStream: vi.fn(() => mockWriteStream),
    createReadStream: mockCreateReadStream,
  };
});

// Mock fs/promises for async transcript APIs
const mockFsPromises = vi.hoisted(() => ({
  mkdir: vi.fn((): Promise<string | undefined> => Promise.resolve(undefined)),
  stat: vi.fn((): Promise<{ size: number }> => Promise.reject(new Error('ENOENT'))),
  readFile: vi.fn((): Promise<string> => Promise.reject(new Error('ENOENT'))),
}));
vi.mock('fs/promises', () => mockFsPromises);

// Mock shell environment
vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '/usr/local/bin' })),
  cleanSpawnEnv: vi.fn((env: Record<string, string>) => { delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; return env; }),
  winQuoteArg: vi.fn((arg: string) => arg.length === 0 ? '""' : '"' + arg.replace(/"/g, '""') + '"'),
}));

// Mock log service
vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

// Mock annex event bus
const mockEmitHookEvent = vi.fn();
const mockEmitPtyExit = vi.fn();
vi.mock('./annex-event-bus', () => ({
  emitHookEvent: (...args: unknown[]) => mockEmitHookEvent(...args),
  emitPtyExit: (...args: unknown[]) => mockEmitPtyExit(...args),
}));

// Mock pty-manager for validateSpawnCwd
const mockValidateSpawnCwd = vi.fn(async () => '/resolved/path');
vi.mock('./pty-manager', () => ({
  validateSpawnCwd: (...args: unknown[]) => mockValidateSpawnCwd(...args),
}));

// Create a mock child process
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    stdin: { end: ReturnType<typeof vi.fn> } | null;
    stdout: EventEmitter | null;
    stderr: EventEmitter | null;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.pid = 12345;
  proc.exitCode = null; // matches real ChildProcess default
  proc.stdin = { end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

let mockProcess: ReturnType<typeof createMockProcess>;

const mockCpSpawn = vi.fn(() => mockProcess);
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockCpSpawn(...args),
}));

import { IPC } from '../../shared/ipc-channels';
import { appLog } from './log-service';
import {
  spawnHeadless,
  isHeadless,
  kill,
  readTranscript,
  getTranscriptInfo,
  readTranscriptPage,
  setMaxTranscriptBytes,
  setMaxStderrBytes,
  startStaleSweep,
  stopStaleSweep,
  _internal,
} from './headless-manager';

describe('headless-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00Z'));
    mockProcess = createMockProcess();
    mockWriteStream.write.mockClear();
    mockWriteStream.end.mockClear();
    mockEmitHookEvent.mockClear();
    mockEmitPtyExit.mockClear();
  });

  afterEach(() => {
    // Clean up any active sessions by killing them
    if (isHeadless('test-agent')) {
      kill('test-agent');
      // Trigger close to clean up
      mockProcess.emit('close', 0);
    }
    // Reset transcript cap to default
    setMaxTranscriptBytes(10 * 1024 * 1024);
    setMaxStderrBytes(64 * 1024);
    stopStaleSweep();
    vi.useRealTimers();
  });

  // ============================================================
  // stream-json mode (existing behavior, regression tests)
  // ============================================================
  describe('stream-json mode', () => {
    it('creates session and tracks agent as headless', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);
      expect(isHeadless('test-agent')).toBe(true);
    });

    it('closes stdin immediately after spawn', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);
      expect(mockProcess.stdin!.end).toHaveBeenCalled();
    });

    it('parses JSONL from stdout and persists to transcript', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      // Transcript should be persisted to log stream
      expect(mockWriteStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"assistant"')
      );
    });

    it('emits pre_tool hook events for tool_use in assistant messages', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/foo.ts' } }],
        },
      };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      expect(mockSend).toHaveBeenCalledWith(
        IPC.AGENT.HOOK_EVENT,
        'test-agent',
        expect.objectContaining({
          kind: 'pre_tool',
          toolName: 'Edit',
          toolInput: { file_path: '/foo.ts' },
        })
      );
    });

    it('emits stop hook event for result events', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'result', result: 'Done!', cost_usd: 0.05, duration_ms: 3000 };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      expect(mockSend).toHaveBeenCalledWith(
        IPC.AGENT.HOOK_EVENT,
        'test-agent',
        expect.objectContaining({
          kind: 'stop',
          message: 'Done!',
        })
      );
    });

    it('emits PTY.EXIT on process close and cleans up session', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);
      expect(isHeadless('test-agent')).toBe(true);

      mockProcess.emit('close', 0);

      expect(mockSend).toHaveBeenCalledWith(IPC.PTY.EXIT, 'test-agent', 0);
      expect(isHeadless('test-agent')).toBe(false);
    });

    it('flushes parser on close to capture final incomplete line', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Send data without trailing newline — should be buffered
      const event = { type: 'result', result: 'Final' };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event)));

      // Not yet written (no newline, still buffered in parser)
      const writesBefore = mockWriteStream.write.mock.calls.length;

      // Close flushes parser
      mockProcess.emit('close', 0);

      // Now the event should have been flushed and written
      expect(mockWriteStream.write.mock.calls.length).toBeGreaterThan(writesBefore);
    });

    it('does NOT emit text-mode notification for stream-json', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const notificationCalls = mockSend.mock.calls.filter(
        (call) => call[0] === IPC.AGENT.HOOK_EVENT &&
          call[2]?.message?.includes('text output')
      );
      expect(notificationCalls).toHaveLength(0);
    });

    it('forwards stderr as notification events', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.stderr!.emit('data', Buffer.from('Warning: something happened'));

      expect(mockSend).toHaveBeenCalledWith(
        IPC.AGENT.HOOK_EVENT,
        'test-agent',
        expect.objectContaining({
          kind: 'notification',
          message: 'Warning: something happened',
        })
      );
    });

    it('handles multiple events in a single chunk', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event1 = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } };
      const event2 = { type: 'result', result: 'Done' };
      const chunk = JSON.stringify(event1) + '\n' + JSON.stringify(event2) + '\n';

      mockProcess.stdout!.emit('data', Buffer.from(chunk));

      // Both events should be written to transcript
      expect(mockWriteStream.write).toHaveBeenCalledTimes(2);
    });

    it('emits post_tool for tool_result in user messages', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu_123' }],
        },
      };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      expect(mockSend).toHaveBeenCalledWith(
        IPC.AGENT.HOOK_EVENT,
        'test-agent',
        expect.objectContaining({ kind: 'post_tool' })
      );
    });
  });

  // ============================================================
  // text mode (NEW — the core change in this stage)
  // ============================================================
  describe('text mode', () => {
    it('creates session and tracks agent as headless', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');
      expect(isHeadless('test-agent')).toBe(true);
    });

    it('emits initial notification for text mode', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      expect(mockSend).toHaveBeenCalledWith(
        IPC.AGENT.HOOK_EVENT,
        'test-agent',
        expect.objectContaining({
          kind: 'notification',
          message: expect.stringContaining('text output'),
        })
      );
    });

    it('buffers stdout instead of parsing as JSONL', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      // Send plain text (not JSON)
      mockProcess.stdout!.emit('data', Buffer.from('Working on fixing the bug...\n'));
      mockProcess.stdout!.emit('data', Buffer.from('Done! The auth issue is resolved.'));

      // Should NOT attempt to parse as JSON — no transcript entries yet
      // (transcript entries only created on close for text mode)
      const transcriptWrites = mockWriteStream.write.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('"type"')
      );
      expect(transcriptWrites).toHaveLength(0);
    });

    it('does not crash on non-JSON stdout in text mode', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      // This would throw in stream-json mode if fed to JsonlParser incorrectly
      expect(() => {
        mockProcess.stdout!.emit('data', Buffer.from('This is {not} valid JSON!\n'));
        mockProcess.stdout!.emit('data', Buffer.from('Neither is <this>.\n'));
      }).not.toThrow();
    });

    it('synthesizes result event on close from buffered text', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      mockProcess.stdout!.emit('data', Buffer.from('Fixed the auth bug.\n'));
      mockProcess.stdout!.emit('data', Buffer.from('Updated 3 files.'));

      mockProcess.emit('close', 0);

      // Should write a synthesized result event to the transcript log
      const resultWrite = mockWriteStream.write.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('"type":"result"')
      );
      expect(resultWrite).toBeDefined();

      const resultEvent = JSON.parse(resultWrite![0] as string);
      expect(resultEvent.type).toBe('result');
      expect(resultEvent.result).toBe('Fixed the auth bug.\nUpdated 3 files.');
      expect(resultEvent.cost_usd).toBe(0);
      expect(resultEvent.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('emits stop hook event on close with truncated message', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      mockProcess.stdout!.emit('data', Buffer.from('Short result.'));
      mockProcess.emit('close', 0);

      expect(mockSend).toHaveBeenCalledWith(
        IPC.AGENT.HOOK_EVENT,
        'test-agent',
        expect.objectContaining({
          kind: 'stop',
          message: 'Short result.',
        })
      );
    });

    it('truncates stop message to 500 chars for large text output', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      const longOutput = 'x'.repeat(1000);
      mockProcess.stdout!.emit('data', Buffer.from(longOutput));
      mockProcess.emit('close', 0);

      const stopCall = mockSend.mock.calls.find(
        (call) => call[0] === IPC.AGENT.HOOK_EVENT && call[2]?.kind === 'stop'
      );
      expect(stopCall).toBeDefined();
      expect(stopCall![2].message.length).toBe(500);
    });

    it('does not synthesize result when text buffer is empty', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      // No stdout data emitted
      mockProcess.emit('close', 0);

      // Should not write any result event
      const resultWrite = mockWriteStream.write.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('"type":"result"')
      );
      expect(resultWrite).toBeUndefined();
    });

    it('emits PTY.EXIT on close just like stream-json mode', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      mockProcess.emit('close', 0);
      expect(mockSend).toHaveBeenCalledWith(IPC.PTY.EXIT, 'test-agent', 0);
    });

    it('cleans up session on close', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');
      expect(isHeadless('test-agent')).toBe(true);

      mockProcess.emit('close', 0);
      expect(isHeadless('test-agent')).toBe(false);
    });

    it('closes log stream on close', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      mockProcess.emit('close', 0);
      expect(mockWriteStream.end).toHaveBeenCalled();
    });

    it('still forwards stderr as notification in text mode', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      mockProcess.stderr!.emit('data', Buffer.from('Error: API key invalid'));

      expect(mockSend).toHaveBeenCalledWith(
        IPC.AGENT.HOOK_EVENT,
        'test-agent',
        expect.objectContaining({
          kind: 'notification',
          message: 'Error: API key invalid',
        })
      );
    });

    it('handles non-zero exit code', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      mockProcess.stdout!.emit('data', Buffer.from('partial output'));
      mockProcess.emit('close', 1);

      expect(mockSend).toHaveBeenCalledWith(IPC.PTY.EXIT, 'test-agent', 1);
      // Should still synthesize result from partial output
      const resultWrite = mockWriteStream.write.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('"type":"result"')
      );
      expect(resultWrite).toBeDefined();
    });
  });

  // ============================================================
  // outputKind defaults
  // ============================================================
  describe('outputKind default', () => {
    it('defaults to stream-json when outputKind not specified', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Should behave as stream-json: parse JSONL, no text-mode notification
      const notificationCalls = mockSend.mock.calls.filter(
        (call) => call[0] === IPC.AGENT.HOOK_EVENT &&
          call[2]?.message?.includes('text output')
      );
      expect(notificationCalls).toHaveLength(0);

      // Valid JSONL should be parsed
      const event = { type: 'result', result: 'ok' };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      expect(mockWriteStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"result"')
      );
    });
  });

  // ============================================================
  // Session lifecycle
  // ============================================================
  describe('session lifecycle', () => {
    it('kills existing session before spawning new one with same agentId', async () => {
      const proc1 = createMockProcess();
      mockProcess = proc1;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'text');

      const proc2 = createMockProcess();
      mockProcess = proc2;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test2'], {}, 'text');

      // First process should have been killed
      expect(proc1.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('kill() sends SIGTERM to process', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'text');
      kill('test-agent');
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('kill() is a no-op for unknown agentId', async () => {
      expect(() => kill('nonexistent-agent')).not.toThrow();
    });

    it('handles process error event', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test']);

      mockProcess.emit('error', new Error('spawn failed'));

      expect(mockSend).toHaveBeenCalledWith(IPC.PTY.EXIT, 'test-agent', 1);
      expect(isHeadless('test-agent')).toBe(false);
    });

    it('error handler calls onExit callback', async () => {
      const onExit = vi.fn();
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'stream-json', onExit);

      mockProcess.emit('error', new Error('spawn failed'));

      expect(onExit).toHaveBeenCalledWith('test-agent', 1);
    });

    it('does not double-cleanup when both error and close fire', async () => {
      const onExit = vi.fn();
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'stream-json', onExit);

      // Both events fire (race condition)
      mockProcess.emit('error', new Error('spawn failed'));
      mockProcess.emit('close', 1);

      // onExit and logStream.end should each be called exactly once
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(mockWriteStream.end).toHaveBeenCalledTimes(1);
    });

    it('does not double-cleanup when close fires before error', async () => {
      const onExit = vi.fn();
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'stream-json', onExit);

      // close fires first, then error
      mockProcess.emit('close', 0);
      mockProcess.emit('error', new Error('late error'));

      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith('test-agent', 0);
      expect(mockWriteStream.end).toHaveBeenCalledTimes(1);

      // PTY.EXIT should only be broadcast once
      const exitCalls = mockSend.mock.calls.filter(
        (call) => call[0] === IPC.PTY.EXIT
      );
      expect(exitCalls).toHaveLength(1);
    });
  });

  // ============================================================
  // Transcript reading
  // ============================================================
  describe('readTranscript', () => {
    it('returns null for unknown agent', async () => {
      expect(await readTranscript('unknown-agent')).toBeNull();
    });

    it('returns in-memory transcript for active session', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'result', result: 'ok' };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      const transcript = await readTranscript('test-agent');
      expect(transcript).not.toBeNull();
      expect(transcript).toContain('"type":"result"');
    });

    it('returns in-memory transcript for text mode active session', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      // In text mode, transcript is empty until close
      const transcript = await readTranscript('test-agent');
      expect(transcript).toBe(''); // empty array mapped to empty string
    });

    it('uses pre-cached serialized lines instead of re-serializing (#637)', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const events = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
        { type: 'result', result: 'Done' },
      ];
      for (const event of events) {
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // Spy on JSON.stringify to verify it is NOT called during readTranscript
      const stringifySpy = vi.spyOn(JSON, 'stringify');
      stringifySpy.mockClear();

      const transcript = await readTranscript('test-agent');

      // readTranscript should not call JSON.stringify (it uses pre-cached lines)
      expect(stringifySpy).not.toHaveBeenCalled();

      // Verify content is still correct
      const lines = transcript!.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('"type":"assistant"');
      expect(lines[1]).toContain('"type":"result"');

      stringifySpy.mockRestore();
    });
  });

  // ============================================================
  // Environment handling
  // ============================================================
  describe('environment', () => {
    it('passes extra env vars and removes CLAUDECODE/CLAUDE_CODE_ENTRYPOINT', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test'], {
        ANTHROPIC_API_KEY: 'sk-test',
        CLUBHOUSE_AGENT_ID: 'test-agent',
      });

      if (process.platform === 'win32') {
        // On Windows, binary is wrapped through cmd.exe
        expect(mockCpSpawn).toHaveBeenCalledWith(
          'cmd.exe',
          expect.arrayContaining(['/d', '/s', '/c']),
          expect.objectContaining({
            cwd: '/project',
            env: expect.objectContaining({
              ANTHROPIC_API_KEY: 'sk-test',
              CLUBHOUSE_AGENT_ID: 'test-agent',
            }),
          })
        );
      } else {
        expect(mockCpSpawn).toHaveBeenCalledWith(
          '/usr/local/bin/claude',
          ['-p', 'test'],
          expect.objectContaining({
            cwd: '/project',
            env: expect.objectContaining({
              ANTHROPIC_API_KEY: 'sk-test',
              CLUBHOUSE_AGENT_ID: 'test-agent',
            }),
          })
        );
      }

      // CLAUDECODE and CLAUDE_CODE_ENTRYPOINT should be removed
      const envArg = (mockCpSpawn.mock.calls[0] as any[])[2].env;
      expect(envArg.CLAUDECODE).toBeUndefined();
      expect(envArg.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    });
  });

  // ============================================================
  // Windows shell wrapping
  // ============================================================
  describe('Windows spawn options', () => {
    it('uses cmd.exe with windowsVerbatimArguments on Windows', async () => {
      await spawnHeadless('test-agent', '/project', 'C:\\npm\\claude.cmd', ['-p', 'test']);

      if (process.platform === 'win32') {
        // On Windows, binary and args are wrapped in cmd.exe /d /s /c "..."
        const spawnArgs = (mockCpSpawn.mock.calls[0] as any[]);
        expect(spawnArgs[0]).toBe('cmd.exe');
        expect(spawnArgs[1][0]).toBe('/d');
        expect(spawnArgs[1][1]).toBe('/s');
        expect(spawnArgs[1][2]).toBe('/c');
        // The 4th arg is the quoted command string
        expect(spawnArgs[1][3]).toContain('claude.cmd');
        expect(spawnArgs[1][3]).toContain('-p');
        expect(spawnArgs[2].windowsVerbatimArguments).toBe(true);
      } else {
        // On non-Windows, binary is called directly
        const spawnArgs = (mockCpSpawn.mock.calls[0] as any[]);
        expect(spawnArgs[0]).toBe('C:\\npm\\claude.cmd');
      }
    });

    it('non-Windows platforms spawn binary directly without shell', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      if (process.platform !== 'win32') {
        const spawnArgs = (mockCpSpawn.mock.calls[0] as any[]);
        expect(spawnArgs[0]).toBe('/usr/local/bin/claude');
        expect(spawnArgs[1]).toEqual(['-p', 'test']);
        const spawnOpts = spawnArgs[2];
        expect(spawnOpts.shell).toBeUndefined();
        expect(spawnOpts.windowsVerbatimArguments).toBeUndefined();
      }
    });

    it('properly quotes arguments with spaces in Windows command line', async () => {
      if (process.platform !== 'win32') return; // Windows-only test

      await spawnHeadless('test-agent', '/project', 'C:\\npm\\claude.cmd', ['-p', 'Fix the login bug', '--verbose']);

      const cmdLine = (mockCpSpawn.mock.calls[0] as any[])[1][3] as string;
      // Mission text should be wrapped in double quotes
      expect(cmdLine).toContain('"Fix the login bug"');
    });
  });

  // ============================================================
  // Annex event bus bridge (headless → WebSocket pipeline)
  // ============================================================
  describe('annex event bus bridge', () => {
    it('emits hook events to annex event bus for stream-json tool_use', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/foo.ts' } }],
        },
      };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({ kind: 'pre_tool', toolName: 'Edit' })
      );
    });

    it('emits hook events to annex event bus for result/stop', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'result', result: 'Done!', cost_usd: 0.05, duration_ms: 3000 };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({ kind: 'stop', message: 'Done!' })
      );
    });

    it('emits hook events to annex event bus for post_tool (user tool_result)', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_123' }] },
      };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({ kind: 'post_tool' })
      );
    });

    it('emits text-mode initial notification to annex event bus', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({
          kind: 'notification',
          message: expect.stringContaining('text output'),
        })
      );
    });

    it('emits stderr notification to annex event bus', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.stderr!.emit('data', Buffer.from('Warning: rate limit'));

      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({
          kind: 'notification',
          message: 'Warning: rate limit',
        })
      );
    });

    it('emits text-mode stop event to annex event bus on close', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');
      mockEmitHookEvent.mockClear(); // clear initial notification

      mockProcess.stdout!.emit('data', Buffer.from('Fixed it.'));
      mockProcess.emit('close', 0);

      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({ kind: 'stop', message: 'Fixed it.' })
      );
    });

    it('emits emitPtyExit to annex event bus on normal close', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.emit('close', 0);

      expect(mockEmitPtyExit).toHaveBeenCalledWith('test-agent', 0);
    });

    it('emits emitPtyExit to annex event bus on non-zero close', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.emit('close', 1);

      expect(mockEmitPtyExit).toHaveBeenCalledWith('test-agent', 1);
    });

    it('emits emitPtyExit to annex event bus on process error', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.emit('error', new Error('spawn failed'));

      expect(mockEmitPtyExit).toHaveBeenCalledWith('test-agent', 1);
    });

    it('emits emitPtyExit only once when both error and close fire', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.emit('error', new Error('spawn failed'));
      mockProcess.emit('close', 1);

      expect(mockEmitPtyExit).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // Transcript memory cap (Issue #319)
  // ============================================================
  describe('transcript memory cap', () => {
    it('tracks transcriptBytes as events are pushed', async () => {
      setMaxTranscriptBytes(1024 * 1024); // 1MB — high enough to not trigger eviction
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } };

      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      // readTranscript returns the in-memory transcript; verify it has content
      const transcript = await readTranscript('test-agent');
      expect(transcript).toContain('"type":"assistant"');

      // Push a second event and verify both are present
      const event2 = { type: 'result', result: 'Done' };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event2) + '\n'));

      const transcript2 = await readTranscript('test-agent');
      expect(transcript2).toContain('"type":"assistant"');
      expect(transcript2).toContain('"type":"result"');
    });

    it('evicts old events when transcript exceeds cap', async () => {
      // Set a very small cap to trigger eviction quickly
      setMaxTranscriptBytes(500);
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push events that collectively exceed 500 bytes
      for (let i = 0; i < 10; i++) {
        const event = { type: 'assistant', message: { content: [{ type: 'text', text: `Message ${i} ${'x'.repeat(100)}` }] } };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // The in-memory transcript should have fewer than 10 events due to eviction
      const transcript = await readTranscript('test-agent');
      // Since transcriptEvicted is true, readTranscript tries disk first.
      // Mock fsPromises.readFile rejects ENOENT, so it falls through to partial in-memory.
      // Count events in the returned string
      const lines = transcript!.split('\n').filter(l => l.trim());
      expect(lines.length).toBeLessThan(10);
      expect(lines.length).toBeGreaterThan(0);
    });

    it('keeps most recent events after eviction', async () => {
      setMaxTranscriptBytes(500);
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push numbered events
      for (let i = 0; i < 10; i++) {
        const event = { type: 'result', result: `event-${i}-${'x'.repeat(80)}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // readTranscript falls through to partial in-memory (disk mock rejects)
      const transcript = await readTranscript('test-agent');
      // The last event should still be present
      expect(transcript).toContain('event-9');
      // Early events should have been evicted
      expect(transcript).not.toContain('event-0');
    });

    it('logs warning on first eviction', async () => {
      setMaxTranscriptBytes(200);
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push enough data to trigger eviction
      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `msg-${i}-${'x'.repeat(100)}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // appLog should have been called with 'warn' about eviction
      expect(appLog).toHaveBeenCalledWith(
        'core:headless',
        'warn',
        expect.stringContaining('evicting old events'),
        expect.objectContaining({
          meta: expect.objectContaining({
            agentId: 'test-agent',
            evictedCount: expect.any(Number),
          }),
        })
      );
    });

    it('readTranscript falls back to disk when transcript is evicted', async () => {
      setMaxTranscriptBytes(200);
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push enough data to trigger eviction
      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `msg-${i}-${'x'.repeat(100)}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // Now make fsPromises.readFile return full transcript data
      const fullTranscript = '{"type":"result","result":"full-disk-data"}\n';
      mockFsPromises.readFile.mockResolvedValueOnce(fullTranscript);

      const result = await readTranscript('test-agent');
      expect(result).toBe(fullTranscript);
      expect(mockFsPromises.readFile).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.jsonl'),
        'utf-8'
      );
    });

    it('does not evict when under the cap', async () => {
      setMaxTranscriptBytes(1024 * 1024); // 1MB
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push a few small events — well under 1MB
      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `ok-${i}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      const transcript = await readTranscript('test-agent');
      const lines = transcript!.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(5); // All events retained

      // No eviction warning should be logged
      expect(appLog).not.toHaveBeenCalledWith(
        'core:headless',
        'warn',
        expect.stringContaining('evicting'),
        expect.anything()
      );
    });

    it('setMaxTranscriptBytes changes the cap', async () => {
      // Start with a high cap
      setMaxTranscriptBytes(1024 * 1024);
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push small events (~40 bytes each) under the high cap
      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `m${i}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // All 5 should be in memory
      let transcript = await readTranscript('test-agent');
      let lines = transcript!.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(5);

      // Lower the cap — next event will push us over and trigger eviction
      // Each event is ~40 bytes, total ~240 bytes for 6 events.
      // With cap=150, target=112. Eviction removes oldest until under 112.
      setMaxTranscriptBytes(150);

      const event = { type: 'result', result: 'trigger' };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      // Some old events should be evicted now
      transcript = await readTranscript('test-agent');
      lines = transcript!.split('\n').filter(l => l.trim());
      expect(lines.length).toBeLessThan(6);
      expect(lines.length).toBeGreaterThan(0);
      expect(transcript).toContain('trigger');
    });
  });

  describe('stderr memory cap', () => {
    it('retains recent stderr output when the buffer exceeds the cap', async () => {
      setMaxStderrBytes(70);
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.stderr!.emit('data', Buffer.from(`first-${'x'.repeat(30)}`));
      mockProcess.stderr!.emit('data', Buffer.from(`second-${'y'.repeat(30)}`));
      mockProcess.stderr!.emit('data', Buffer.from(`third-${'z'.repeat(30)}`));

      mockProcess.emit('close', 1);

      expect(appLog).toHaveBeenCalledWith(
        'core:headless',
        'info',
        'Process exited',
        expect.objectContaining({
          meta: expect.objectContaining({
            agentId: 'test-agent',
            stderr: expect.stringContaining('third-'),
          }),
        }),
      );

      expect(appLog).not.toHaveBeenCalledWith(
        'core:headless',
        'info',
        'Process exited',
        expect.objectContaining({
          meta: expect.objectContaining({
            stderr: expect.stringContaining('first-'),
          }),
        }),
      );
    });

    it('setMaxStderrBytes changes the retention cap', async () => {
      setMaxStderrBytes(20);
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.stderr!.emit('data', Buffer.from('alpha-alpha-alpha'));
      mockProcess.stderr!.emit('data', Buffer.from('beta'));
      mockProcess.emit('close', 1);

      expect(appLog).toHaveBeenCalledWith(
        'core:headless',
        'info',
        'Process exited',
        expect.objectContaining({
          meta: expect.objectContaining({
            stderr: 'beta',
          }),
        }),
      );
    });
  });

  // ============================================================
  // getTranscriptInfo (paginated API)
  // ============================================================
  describe('getTranscriptInfo', () => {
    beforeEach(() => {
      mockFsPromises.stat.mockReset();
      mockFsPromises.stat.mockRejectedValue(new Error('ENOENT'));
      mockCreateReadStream.mockImplementation(() =>
        new Readable({ read() { this.destroy(new Error('ENOENT')); } }),
      );
    });

    it('returns null for unknown agent with no transcript on disk', async () => {
      const info = await getTranscriptInfo('unknown-agent');
      expect(info).toBeNull();
    });

    it('returns in-memory info for active session', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event1 = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } };
      const event2 = { type: 'result', result: 'Done' };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event1) + '\n'));
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event2) + '\n'));

      const info = await getTranscriptInfo('test-agent');
      expect(info).not.toBeNull();
      expect(info!.totalEvents).toBe(2);
      expect(info!.fileSizeBytes).toBeGreaterThan(0);
    });

    it('returns disk info for completed session', async () => {
      const diskData = '{"type":"result","result":"ok"}\n{"type":"assistant","message":{}}\n';
      mockFsPromises.stat.mockResolvedValue({ size: diskData.length });
      mockCreateReadStream.mockReturnValue(Readable.from([diskData]));

      const info = await getTranscriptInfo('completed-agent');
      expect(info).not.toBeNull();
      expect(info!.totalEvents).toBe(2);
      expect(info!.fileSizeBytes).toBe(diskData.length);
    });

    it('uses running counters when session has evicted events (no disk I/O)', async () => {
      setMaxTranscriptBytes(200);
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push enough to trigger eviction
      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `msg-${i}-${'x'.repeat(100)}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // Should NOT read from disk — running counters are used instead
      const info = await getTranscriptInfo('test-agent');
      expect(info).not.toBeNull();
      expect(info!.totalEvents).toBe(5);
      expect(info!.fileSizeBytes).toBeGreaterThan(0);
      // Verify no disk reads were attempted
      expect(mockFsPromises.stat).not.toHaveBeenCalled();
      expect(mockCreateReadStream).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // readTranscriptPage (paginated API)
  // ============================================================
  describe('readTranscriptPage', () => {
    beforeEach(() => {
      mockCreateReadStream.mockImplementation(() =>
        new Readable({ read() { this.destroy(new Error('ENOENT')); } }),
      );
    });

    it('returns null for unknown agent with no transcript on disk', async () => {
      const page = await readTranscriptPage('unknown-agent', 0, 10);
      expect(page).toBeNull();
    });

    it('returns sliced events from in-memory session', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `event-${i}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      const page = await readTranscriptPage('test-agent', 1, 2);
      expect(page).not.toBeNull();
      expect(page!.totalEvents).toBe(5);
      expect(page!.events).toHaveLength(2);
      expect(page!.events[0].result).toBe('event-1');
      expect(page!.events[1].result).toBe('event-2');
    });

    it('returns empty events when offset exceeds total', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'result', result: 'only' };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      const page = await readTranscriptPage('test-agent', 10, 5);
      expect(page).not.toBeNull();
      expect(page!.totalEvents).toBe(1);
      expect(page!.events).toHaveLength(0);
    });

    it('reads page from disk for completed session', async () => {
      const diskData = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({ type: 'result', result: `disk-${i}` })
      ).join('\n') + '\n';

      mockCreateReadStream.mockReturnValue(Readable.from([diskData]));

      const page = await readTranscriptPage('completed-agent', 2, 2);
      expect(page).not.toBeNull();
      expect(page!.totalEvents).toBe(5);
      expect(page!.events).toHaveLength(2);
      expect(page!.events[0].result).toBe('disk-2');
      expect(page!.events[1].result).toBe('disk-3');
    });

    it('clamps page to available events', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      for (let i = 0; i < 3; i++) {
        const event = { type: 'result', result: `e-${i}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // Request more events than available starting from offset 1
      const page = await readTranscriptPage('test-agent', 1, 100);
      expect(page!.events).toHaveLength(2);
      expect(page!.events[0].result).toBe('e-1');
      expect(page!.events[1].result).toBe('e-2');
    });

    it('falls back to disk when session has evicted events', async () => {
      setMaxTranscriptBytes(200);
      await spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `msg-${i}-${'x'.repeat(100)}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      const diskEvents = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({ type: 'result', result: `disk-${i}` })
      ).join('\n') + '\n';
      mockCreateReadStream.mockReturnValue(Readable.from([diskEvents]));

      const page = await readTranscriptPage('test-agent', 0, 3);
      expect(page).not.toBeNull();
      expect(page!.totalEvents).toBe(5);
      expect(page!.events).toHaveLength(3);
      expect(page!.events[0].result).toBe('disk-0');
    });

    it('only parses lines within the requested page window', async () => {
      // Build a transcript where we can verify selective parsing by checking
      // that only the requested page events are returned, while totalEvents
      // reflects the full line count (proving lines outside the window were
      // counted but not necessarily parsed).
      const diskData = Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ type: 'result', result: `event-${i}` })
      ).join('\n') + '\n';

      mockCreateReadStream.mockReturnValue(Readable.from([diskData]));

      const page = await readTranscriptPage('completed-agent', 50, 5);
      expect(page).not.toBeNull();
      expect(page!.totalEvents).toBe(100);
      expect(page!.events).toHaveLength(5);
      expect(page!.events[0].result).toBe('event-50');
      expect(page!.events[4].result).toBe('event-54');
    });

    it('skips malformed JSON lines gracefully', async () => {
      const diskData = [
        '{"type":"result","result":"good-0"}',
        'NOT VALID JSON',
        '{"type":"result","result":"good-1"}',
        '{"type":"result","result":"good-2"}',
      ].join('\n') + '\n';

      mockCreateReadStream.mockReturnValue(Readable.from([diskData]));

      const page = await readTranscriptPage('completed-agent', 0, 10);
      expect(page).not.toBeNull();
      // totalEvents counts all non-empty lines (including malformed)
      expect(page!.totalEvents).toBe(4);
      // But events only contains successfully parsed lines
      expect(page!.events).toHaveLength(3);
      expect(page!.events[0].result).toBe('good-0');
      expect(page!.events[2].result).toBe('good-2');
    });
  });

  // ============================================================
  // kill() timer race condition (Issue #326)
  // ============================================================
  describe('kill() — process identity guard', () => {
    it('does not delete replacement session when old kill timer fires', async () => {
      // Spawn agent → kill it → spawn replacement
      const proc1 = createMockProcess();
      mockProcess = proc1;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test']);
      expect(isHeadless('test-agent')).toBe(true);

      // Kill the first session (starts 5s force-kill timer)
      kill('test-agent');

      // Simulate old process exiting naturally via close event
      proc1.emit('close', 0);

      // Spawn a replacement session with the same agentId
      const proc2 = createMockProcess();
      mockProcess = proc2;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test2']);
      expect(isHeadless('test-agent')).toBe(true);

      // Advance past the 5s force-kill timer from the first kill()
      vi.advanceTimersByTime(5000);

      // The replacement session MUST still exist
      expect(isHeadless('test-agent')).toBe(true);
    });

    it('force-kills the correct process when timer fires on same session', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test']);

      kill('test-agent');
      mockProcess.kill.mockClear();

      // Advance to 5s force-kill timer
      vi.advanceTimersByTime(5000);

      // Process should have received SIGKILL
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
      // Session should be cleaned up
      expect(isHeadless('test-agent')).toBe(false);
    });

    it('clears kill timer when process exits via close event', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test']);

      kill('test-agent');
      mockProcess.kill.mockClear();

      // Simulate process exiting naturally before the 5s timer
      mockProcess.emit('close', 0);
      expect(isHeadless('test-agent')).toBe(false);

      // Advance past timer — should not throw or send extra SIGKILL
      vi.advanceTimersByTime(5000);
      expect(mockProcess.kill).not.toHaveBeenCalledWith('SIGKILL');
    });

    it('double kill() clears the first timer', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test']);

      // Kill twice rapidly
      kill('test-agent');
      kill('test-agent');
      mockProcess.kill.mockClear();

      // Advance to 5s — only one SIGKILL should fire
      vi.advanceTimersByTime(5000);
      const sigkillCalls = mockProcess.kill.mock.calls.filter(
        (c: string[]) => c[0] === 'SIGKILL'
      );
      expect(sigkillCalls.length).toBeLessThanOrEqual(1);
    });
  });

  // ============================================================
  // close/error handler race condition (CQ-2)
  // ============================================================
  describe('close/error handler — session replacement guard', () => {
    it('old process close handler does not delete replacement session', async () => {
      // Spawn first session
      const proc1 = createMockProcess();
      mockProcess = proc1;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test']);
      expect(isHeadless('test-agent')).toBe(true);

      // Spawn replacement — this kills the old process and creates new session
      const proc2 = createMockProcess();
      mockProcess = proc2;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test2']);
      expect(isHeadless('test-agent')).toBe(true);

      // Old process close handler fires AFTER replacement is stored
      proc1.emit('close', 0);

      // The replacement session MUST still exist
      expect(isHeadless('test-agent')).toBe(true);
    });

    it('old process close handler does not broadcast PTY.EXIT for replaced session', async () => {
      const proc1 = createMockProcess();
      mockProcess = proc1;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test']);

      const proc2 = createMockProcess();
      mockProcess = proc2;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test2']);

      mockSend.mockClear();
      mockEmitPtyExit.mockClear();

      // Old process closes after replacement
      proc1.emit('close', 0);

      // No exit broadcast should have been sent
      const exitCalls = mockSend.mock.calls.filter(
        (call) => call[0] === IPC.PTY.EXIT
      );
      expect(exitCalls).toHaveLength(0);
      expect(mockEmitPtyExit).not.toHaveBeenCalled();
    });

    it('old process close handler does not call onExit for replaced session', async () => {
      const onExit = vi.fn();
      const proc1 = createMockProcess();
      mockProcess = proc1;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'stream-json', onExit);

      const proc2 = createMockProcess();
      mockProcess = proc2;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test2'], {}, 'stream-json', onExit);

      // Old process closes after replacement
      proc1.emit('close', 0);

      // onExit should NOT have been called for the replaced session
      expect(onExit).not.toHaveBeenCalled();
    });

    it('old process error handler does not delete replacement session', async () => {
      const proc1 = createMockProcess();
      mockProcess = proc1;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test']);

      const proc2 = createMockProcess();
      mockProcess = proc2;
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test2']);

      // Old process error fires after replacement
      proc1.emit('error', new Error('spawn failed'));

      // The replacement session MUST still exist
      expect(isHeadless('test-agent')).toBe(true);
    });

    it('current session close handler still cleans up normally', async () => {
      const onExit = vi.fn();
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'stream-json', onExit);
      expect(isHeadless('test-agent')).toBe(true);

      mockProcess.emit('close', 0);

      expect(isHeadless('test-agent')).toBe(false);
      expect(onExit).toHaveBeenCalledWith('test-agent', 0);
    });
  });

  // ============================================================
  // Stale session sweep (Issue #326)
  // ============================================================
  describe('stale session sweep', () => {
    it('startStaleSweep and stopStaleSweep are idempotent', async () => {
      startStaleSweep();
      startStaleSweep();
      stopStaleSweep();
      stopStaleSweep();
    });

    it('sweep cleans up sessions whose processes have exited without close event', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test']);
      expect(isHeadless('test-agent')).toBe(true);

      // Simulate process exiting without firing close/error event
      // by setting exitCode directly (as Node.js does when process exits)
      (mockProcess as any).exitCode = 1;

      startStaleSweep();
      vi.advanceTimersByTime(30_000);

      // Sweep should have detected the stale session
      expect(isHeadless('test-agent')).toBe(false);
    });

    it('sweep does not remove sessions with live processes', async () => {
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test']);
      expect(isHeadless('test-agent')).toBe(true);
      // exitCode is null for running processes (set by createMockProcess)
      expect(mockProcess.exitCode).toBeNull();

      startStaleSweep();
      vi.advanceTimersByTime(30_000);

      // Session should still exist — process hasn't exited
      expect(isHeadless('test-agent')).toBe(true);
    });

    it('sweep invokes onExit callback so registry is cleaned up (#566)', async () => {
      const onExit = vi.fn();
      await spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], undefined, 'stream-json', onExit);
      expect(isHeadless('test-agent')).toBe(true);

      // Simulate process exiting without firing close event
      (mockProcess as any).exitCode = 1;

      startStaleSweep();
      vi.advanceTimersByTime(30_000);

      // Session should be cleaned up and onExit should have been called
      expect(isHeadless('test-agent')).toBe(false);
      expect(onExit).toHaveBeenCalledWith('test-agent', 1);
    });
  });

  // ============================================================
  // command prefix
  // ============================================================
  describe('command prefix', () => {
    it('wraps spawn via shell with prefix on Unix', async () => {
      if (process.platform === 'win32') return;

      await spawnHeadless(
        'test-agent', '/project', '/usr/local/bin/claude',
        ['-p', 'test'], undefined, 'stream-json', undefined,
        '. ./init.sh',
      );

      expect(mockCpSpawn).toHaveBeenCalledWith(
        'sh',
        ['-c', '. ./init.sh && exec "$@"', '_', '/usr/local/bin/claude', '-p', 'test'],
        expect.objectContaining({
          cwd: '/project',
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    });

    it('prepends prefix in cmd.exe command line on Windows', async () => {
      if (process.platform !== 'win32') return;

      await spawnHeadless(
        'test-agent', '/project', 'C:\\path\\claude.cmd',
        ['-p', 'test'], undefined, 'stream-json', undefined,
        '. .\\init.ps1',
      );

      const callArgs = mockCpSpawn.mock.calls[0];
      expect(callArgs[0]).toBe('cmd.exe');
      const cmdLine = callArgs[1][3] as string;
      expect(cmdLine).toContain('. .\\init.ps1 & ');
    });

    it('spawns directly when no prefix is set', async () => {
      if (process.platform === 'win32') return;

      await spawnHeadless(
        'test-agent', '/project', '/usr/local/bin/claude',
        ['-p', 'test'], undefined, 'stream-json', undefined,
        undefined,
      );

      expect(mockCpSpawn).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['-p', 'test'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    });
  });
});

// ============================================================
// Extracted helper unit tests
// ============================================================

describe('headless-manager _internal helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00Z'));
    mockProcess = createMockProcess();
    mockWriteStream.write.mockClear();
    mockWriteStream.end.mockClear();
    mockEmitHookEvent.mockClear();
    mockEmitPtyExit.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('prepareSpawnEnv', () => {
    it('merges shell environment with extra env and cleans the result', () => {
      const result = _internal.prepareSpawnEnv({ API_KEY: 'secret' });

      // cleanSpawnEnv removes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT
      expect(result).toHaveProperty('PATH', '/usr/local/bin');
      expect(result).toHaveProperty('API_KEY', 'secret');
      expect(result).not.toHaveProperty('CLAUDECODE');
    });

    it('works without extra env', () => {
      const result = _internal.prepareSpawnEnv();
      expect(result).toHaveProperty('PATH', '/usr/local/bin');
    });
  });

  describe('spawnProcess', () => {
    const env = { PATH: '/usr/bin' };
    const cwd = '/test/project';

    it('spawns directly when no commandPrefix on non-Windows', () => {
      if (process.platform === 'win32') return;

      _internal.spawnProcess('/usr/bin/claude', ['--flag'], cwd, env);

      expect(mockCpSpawn).toHaveBeenCalledWith('/usr/bin/claude', ['--flag'], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    });

    it('spawns via shell with commandPrefix on non-Windows', () => {
      if (process.platform === 'win32') return;

      _internal.spawnProcess('/usr/bin/claude', ['--flag'], cwd, env, '. ./init.sh');

      expect(mockCpSpawn).toHaveBeenCalledWith(
        'sh',
        ['-c', '. ./init.sh && exec "$@"', '_', '/usr/bin/claude', '--flag'],
        { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    });

    it('returns the spawned ChildProcess', () => {
      const proc = _internal.spawnProcess('/usr/bin/claude', [], cwd, env);
      expect(proc).toBe(mockProcess);
    });
  });

  describe('createSessionRecord', () => {
    it('creates a session with stream-json parser', () => {
      const session = _internal.createSessionRecord('agent-1', mockProcess as any, 'stream-json', '/tmp/t.jsonl');

      expect(session.agentId).toBe('agent-1');
      expect(session.process).toBe(mockProcess);
      expect(session.outputKind).toBe('stream-json');
      expect(session.parser).not.toBeNull();
      expect(session.transcript).toEqual([]);
      expect(session.transcriptLines).toEqual([]);
      expect(session.transcriptEventSizes).toEqual([]);
      expect(session.transcriptBytes).toBe(0);
      expect(session.transcriptEvicted).toBe(false);
      expect(session.totalTranscriptEvents).toBe(0);
      expect(session.totalTranscriptBytesWritten).toBe(0);
      expect(session.transcriptPath).toBe('/tmp/t.jsonl');
      expect(session.startedAt).toBeGreaterThan(0);
    });

    it('creates a session without parser for text mode', () => {
      const session = _internal.createSessionRecord('agent-1', mockProcess as any, 'text', '/tmp/t.jsonl');

      expect(session.parser).toBeNull();
      expect(session.outputKind).toBe('text');
    });
  });

  describe('appendTranscriptEvent', () => {
    it('appends event to session arrays and writes to log stream', () => {
      const session = _internal.createSessionRecord('agent-1', mockProcess as any, 'stream-json', '/tmp/t.jsonl');
      const event = { type: 'assistant', message: { role: 'assistant', content: [] } };

      _internal.appendTranscriptEvent(session, event, mockWriteStream as any);

      expect(session.transcript).toHaveLength(1);
      expect(session.transcript[0]).toBe(event);
      expect(session.transcriptLines).toHaveLength(1);
      expect(session.transcriptEventSizes).toHaveLength(1);
      expect(session.transcriptBytes).toBeGreaterThan(0);
      expect(session.totalTranscriptEvents).toBe(1);
      expect(session.totalTranscriptBytesWritten).toBeGreaterThan(0);
      expect(mockWriteStream.write).toHaveBeenCalledWith(JSON.stringify(event) + '\n');
    });

    it('accumulates bytes across multiple events', () => {
      const session = _internal.createSessionRecord('agent-1', mockProcess as any, 'stream-json', '/tmp/t.jsonl');

      _internal.appendTranscriptEvent(session, { type: 'assistant' }, mockWriteStream as any);
      const bytesAfterFirst = session.transcriptBytes;

      _internal.appendTranscriptEvent(session, { type: 'result', result: 'done' }, mockWriteStream as any);
      expect(session.transcriptBytes).toBeGreaterThan(bytesAfterFirst);
      expect(session.totalTranscriptEvents).toBe(2);
      expect(session.transcript).toHaveLength(2);
    });
  });

  describe('emitTextModeNotification', () => {
    it('broadcasts notification for text output mode', () => {
      _internal.emitTextModeNotification('agent-1', 'text');

      expect(mockSend).toHaveBeenCalledWith(
        IPC.AGENT.HOOK_EVENT,
        'agent-1',
        expect.objectContaining({
          kind: 'notification',
          message: 'Agent running (text output — live events unavailable)',
        }),
      );
      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ kind: 'notification' }),
      );
    });

    it('does nothing for stream-json mode', () => {
      _internal.emitTextModeNotification('agent-1', 'stream-json');

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockEmitHookEvent).not.toHaveBeenCalled();
    });
  });

  describe('setupTranscriptPipeline', () => {
    it('wires parser line events to transcript and log stream', () => {
      const session = _internal.createSessionRecord('agent-1', mockProcess as any, 'stream-json', '/tmp/t.jsonl');
      _internal.setupTranscriptPipeline(session, mockWriteStream as any, 'agent-1');

      const event = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } };
      session.parser!.emit('line', event);

      expect(session.transcript).toHaveLength(1);
      expect(mockWriteStream.write).toHaveBeenCalledWith(JSON.stringify(event) + '\n');
    });

    it('emits hook events for tool_use blocks', () => {
      const session = _internal.createSessionRecord('agent-1', mockProcess as any, 'stream-json', '/tmp/t.jsonl');
      _internal.setupTranscriptPipeline(session, mockWriteStream as any, 'agent-1');

      const event = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/foo' } }],
        },
      };
      session.parser!.emit('line', event);

      expect(mockSend).toHaveBeenCalledWith(
        IPC.AGENT.HOOK_EVENT,
        'agent-1',
        expect.objectContaining({ kind: 'pre_tool', toolName: 'Read' }),
      );
    });

    it('does nothing when session has no parser (text mode)', () => {
      const session = _internal.createSessionRecord('agent-1', mockProcess as any, 'text', '/tmp/t.jsonl');
      _internal.setupTranscriptPipeline(session, mockWriteStream as any, 'agent-1');

      // No parser means no listeners attached — nothing to emit
      expect(session.parser).toBeNull();
      expect(mockWriteStream.write).not.toHaveBeenCalled();
    });
  });

  // ── BUG-04: CWD Validation ──────────────────────────────────────────

  describe('spawnHeadless CWD validation', () => {
    it('calls validateSpawnCwd before spawning', async () => {
      await spawnHeadless('cwd-test', '/valid/path', '/usr/bin/agent', []);
      expect(mockValidateSpawnCwd).toHaveBeenCalledWith('/valid/path');
      // Spawn should proceed after validation passes
      expect(mockCpSpawn).toHaveBeenCalled();
    });

    it('rejects relative paths', async () => {
      mockValidateSpawnCwd.mockRejectedValueOnce(new Error('PTY cwd must be an absolute path, received: relative/path'));
      await expect(
        spawnHeadless('cwd-rel', 'relative/path', '/usr/bin/agent', []),
      ).rejects.toThrow('must be an absolute path');
      expect(mockCpSpawn).not.toHaveBeenCalled();
    });

    it('rejects non-existent directories', async () => {
      mockValidateSpawnCwd.mockRejectedValueOnce(new Error('PTY cwd does not exist or is not accessible: /nonexistent'));
      await expect(
        spawnHeadless('cwd-noent', '/nonexistent', '/usr/bin/agent', []),
      ).rejects.toThrow('does not exist');
      expect(mockCpSpawn).not.toHaveBeenCalled();
    });

    it('rejects sensitive system directories', async () => {
      mockValidateSpawnCwd.mockRejectedValueOnce(new Error('PTY cwd points to a restricted system directory: /etc'));
      await expect(
        spawnHeadless('cwd-etc', '/etc', '/usr/bin/agent', []),
      ).rejects.toThrow('restricted system directory');
      expect(mockCpSpawn).not.toHaveBeenCalled();
    });
  });
});
