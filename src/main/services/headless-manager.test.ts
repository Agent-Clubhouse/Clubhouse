import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

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
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    writeFileSync: vi.fn(),
    createWriteStream: vi.fn(() => mockWriteStream),
  };
});

// Mock fs/promises for async transcript APIs
const mockFsPromises = vi.hoisted(() => ({
  stat: vi.fn((): Promise<{ size: number }> => Promise.reject(new Error('ENOENT'))),
  readFile: vi.fn((): Promise<string> => Promise.reject(new Error('ENOENT'))),
}));
vi.mock('fs/promises', () => mockFsPromises);

// Mock shell environment
vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '/usr/local/bin' })),
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

// Create a mock child process
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: { end: ReturnType<typeof vi.fn> } | null;
    stdout: EventEmitter | null;
    stderr: EventEmitter | null;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.pid = 12345;
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

import * as fs from 'fs';
import { IPC } from '../../shared/ipc-channels';
import { appLog } from './log-service';
import {
  spawnHeadless,
  isHeadless,
  kill,
  readTranscript,
  getTranscriptSummary,
  getTranscriptInfo,
  readTranscriptPage,
  setMaxTranscriptBytes,
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
    vi.useRealTimers();
  });

  // ============================================================
  // stream-json mode (existing behavior, regression tests)
  // ============================================================
  describe('stream-json mode', () => {
    it('creates session and tracks agent as headless', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);
      expect(isHeadless('test-agent')).toBe(true);
    });

    it('closes stdin immediately after spawn', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);
      expect(mockProcess.stdin!.end).toHaveBeenCalled();
    });

    it('parses JSONL from stdout and persists to transcript', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      // Transcript should be persisted to log stream
      expect(mockWriteStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"assistant"')
      );
    });

    it('emits pre_tool hook events for tool_use in assistant messages', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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

    it('emits stop hook event for result events', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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

    it('emits PTY.EXIT on process close and cleans up session', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);
      expect(isHeadless('test-agent')).toBe(true);

      mockProcess.emit('close', 0);

      expect(mockSend).toHaveBeenCalledWith(IPC.PTY.EXIT, 'test-agent', 0);
      expect(isHeadless('test-agent')).toBe(false);
    });

    it('flushes parser on close to capture final incomplete line', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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

    it('does NOT emit text-mode notification for stream-json', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const notificationCalls = mockSend.mock.calls.filter(
        (call) => call[0] === IPC.AGENT.HOOK_EVENT &&
          call[2]?.message?.includes('text output')
      );
      expect(notificationCalls).toHaveLength(0);
    });

    it('forwards stderr as notification events', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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

    it('handles multiple events in a single chunk', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event1 = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } };
      const event2 = { type: 'result', result: 'Done' };
      const chunk = JSON.stringify(event1) + '\n' + JSON.stringify(event2) + '\n';

      mockProcess.stdout!.emit('data', Buffer.from(chunk));

      // Both events should be written to transcript
      expect(mockWriteStream.write).toHaveBeenCalledTimes(2);
    });

    it('emits post_tool for tool_result in user messages', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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
    it('creates session and tracks agent as headless', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');
      expect(isHeadless('test-agent')).toBe(true);
    });

    it('emits initial notification for text mode', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      expect(mockSend).toHaveBeenCalledWith(
        IPC.AGENT.HOOK_EVENT,
        'test-agent',
        expect.objectContaining({
          kind: 'notification',
          message: expect.stringContaining('text output'),
        })
      );
    });

    it('buffers stdout instead of parsing as JSONL', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

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

    it('does not crash on non-JSON stdout in text mode', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      // This would throw in stream-json mode if fed to JsonlParser incorrectly
      expect(() => {
        mockProcess.stdout!.emit('data', Buffer.from('This is {not} valid JSON!\n'));
        mockProcess.stdout!.emit('data', Buffer.from('Neither is <this>.\n'));
      }).not.toThrow();
    });

    it('synthesizes result event on close from buffered text', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

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

    it('emits stop hook event on close with truncated message', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

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

    it('truncates stop message to 500 chars for large text output', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      const longOutput = 'x'.repeat(1000);
      mockProcess.stdout!.emit('data', Buffer.from(longOutput));
      mockProcess.emit('close', 0);

      const stopCall = mockSend.mock.calls.find(
        (call) => call[0] === IPC.AGENT.HOOK_EVENT && call[2]?.kind === 'stop'
      );
      expect(stopCall).toBeDefined();
      expect(stopCall![2].message.length).toBe(500);
    });

    it('does not synthesize result when text buffer is empty', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      // No stdout data emitted
      mockProcess.emit('close', 0);

      // Should not write any result event
      const resultWrite = mockWriteStream.write.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('"type":"result"')
      );
      expect(resultWrite).toBeUndefined();
    });

    it('emits PTY.EXIT on close just like stream-json mode', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      mockProcess.emit('close', 0);
      expect(mockSend).toHaveBeenCalledWith(IPC.PTY.EXIT, 'test-agent', 0);
    });

    it('cleans up session on close', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');
      expect(isHeadless('test-agent')).toBe(true);

      mockProcess.emit('close', 0);
      expect(isHeadless('test-agent')).toBe(false);
    });

    it('closes log stream on close', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      mockProcess.emit('close', 0);
      expect(mockWriteStream.end).toHaveBeenCalled();
    });

    it('still forwards stderr as notification in text mode', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

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

    it('handles non-zero exit code', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

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
    it('defaults to stream-json when outputKind not specified', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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
    it('kills existing session before spawning new one with same agentId', () => {
      const proc1 = createMockProcess();
      mockProcess = proc1;
      spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'text');

      const proc2 = createMockProcess();
      mockProcess = proc2;
      spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test2'], {}, 'text');

      // First process should have been killed
      expect(proc1.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('kill() sends SIGTERM to process', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'text');
      kill('test-agent');
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('kill() is a no-op for unknown agentId', () => {
      expect(() => kill('nonexistent-agent')).not.toThrow();
    });

    it('handles process error event', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test']);

      mockProcess.emit('error', new Error('spawn failed'));

      expect(mockSend).toHaveBeenCalledWith(IPC.PTY.EXIT, 'test-agent', 1);
      expect(isHeadless('test-agent')).toBe(false);
    });

    it('error handler calls onExit callback', () => {
      const onExit = vi.fn();
      spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'stream-json', onExit);

      mockProcess.emit('error', new Error('spawn failed'));

      expect(onExit).toHaveBeenCalledWith('test-agent', 1);
    });

    it('does not double-cleanup when both error and close fire', () => {
      const onExit = vi.fn();
      spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'stream-json', onExit);

      // Both events fire (race condition)
      mockProcess.emit('error', new Error('spawn failed'));
      mockProcess.emit('close', 1);

      // onExit and logStream.end should each be called exactly once
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(mockWriteStream.end).toHaveBeenCalledTimes(1);
    });

    it('does not double-cleanup when close fires before error', () => {
      const onExit = vi.fn();
      spawnHeadless('test-agent', '/project', '/usr/bin/claude', ['-p', 'test'], {}, 'stream-json', onExit);

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
    it('returns null for unknown agent', () => {
      expect(readTranscript('unknown-agent')).toBeNull();
    });

    it('returns in-memory transcript for active session', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'result', result: 'ok' };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      const transcript = readTranscript('test-agent');
      expect(transcript).not.toBeNull();
      expect(transcript).toContain('"type":"result"');
    });

    it('returns in-memory transcript for text mode active session', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      // In text mode, transcript is empty until close
      const transcript = readTranscript('test-agent');
      expect(transcript).toBe(''); // empty array mapped to empty string
    });
  });

  // ============================================================
  // getTranscriptSummary
  // ============================================================
  describe('getTranscriptSummary', () => {
    it('returns summary for active stream-json session', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'result', result: 'Fixed the bug', cost_usd: 0.02, duration_ms: 5000 };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      const summary = getTranscriptSummary('test-agent');
      expect(summary).not.toBeNull();
      expect(summary!.summary).toBe('Fixed the bug');
      expect(summary!.costUsd).toBe(0.02);
      expect(summary!.durationMs).toBe(5000);
    });

    it('returns null for unknown agent', () => {
      expect(getTranscriptSummary('unknown-agent')).toBeNull();
    });
  });

  // ============================================================
  // Environment handling
  // ============================================================
  describe('environment', () => {
    it('passes extra env vars and removes CLAUDECODE/CLAUDE_CODE_ENTRYPOINT', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test'], {
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
    it('uses cmd.exe with windowsVerbatimArguments on Windows', () => {
      spawnHeadless('test-agent', '/project', 'C:\\npm\\claude.cmd', ['-p', 'test']);

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

    it('non-Windows platforms spawn binary directly without shell', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      if (process.platform !== 'win32') {
        const spawnArgs = (mockCpSpawn.mock.calls[0] as any[]);
        expect(spawnArgs[0]).toBe('/usr/local/bin/claude');
        expect(spawnArgs[1]).toEqual(['-p', 'test']);
        const spawnOpts = spawnArgs[2];
        expect(spawnOpts.shell).toBeUndefined();
        expect(spawnOpts.windowsVerbatimArguments).toBeUndefined();
      }
    });

    it('properly quotes arguments with spaces in Windows command line', () => {
      if (process.platform !== 'win32') return; // Windows-only test

      spawnHeadless('test-agent', '/project', 'C:\\npm\\claude.cmd', ['-p', 'Fix the login bug', '--verbose']);

      const cmdLine = (mockCpSpawn.mock.calls[0] as any[])[1][3] as string;
      // Mission text should be wrapped in double quotes
      expect(cmdLine).toContain('"Fix the login bug"');
    });
  });

  // ============================================================
  // Annex event bus bridge (headless → WebSocket pipeline)
  // ============================================================
  describe('annex event bus bridge', () => {
    it('emits hook events to annex event bus for stream-json tool_use', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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

    it('emits hook events to annex event bus for result/stop', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'result', result: 'Done!', cost_usd: 0.05, duration_ms: 3000 };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({ kind: 'stop', message: 'Done!' })
      );
    });

    it('emits hook events to annex event bus for post_tool (user tool_result)', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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

    it('emits text-mode initial notification to annex event bus', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');

      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({
          kind: 'notification',
          message: expect.stringContaining('text output'),
        })
      );
    });

    it('emits stderr notification to annex event bus', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.stderr!.emit('data', Buffer.from('Warning: rate limit'));

      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({
          kind: 'notification',
          message: 'Warning: rate limit',
        })
      );
    });

    it('emits text-mode stop event to annex event bus on close', () => {
      spawnHeadless('test-agent', '/project', '/usr/bin/copilot', ['-p', 'test'], {}, 'text');
      mockEmitHookEvent.mockClear(); // clear initial notification

      mockProcess.stdout!.emit('data', Buffer.from('Fixed it.'));
      mockProcess.emit('close', 0);

      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({ kind: 'stop', message: 'Fixed it.' })
      );
    });

    it('emits emitPtyExit to annex event bus on normal close', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.emit('close', 0);

      expect(mockEmitPtyExit).toHaveBeenCalledWith('test-agent', 0);
    });

    it('emits emitPtyExit to annex event bus on non-zero close', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.emit('close', 1);

      expect(mockEmitPtyExit).toHaveBeenCalledWith('test-agent', 1);
    });

    it('emits emitPtyExit to annex event bus on process error', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.emit('error', new Error('spawn failed'));

      expect(mockEmitPtyExit).toHaveBeenCalledWith('test-agent', 1);
    });

    it('emits emitPtyExit only once when both error and close fire', () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      mockProcess.emit('error', new Error('spawn failed'));
      mockProcess.emit('close', 1);

      expect(mockEmitPtyExit).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // Transcript memory cap (Issue #319)
  // ============================================================
  describe('transcript memory cap', () => {
    it('tracks transcriptBytes as events are pushed', () => {
      setMaxTranscriptBytes(1024 * 1024); // 1MB — high enough to not trigger eviction
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } };

      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      // readTranscript returns the in-memory transcript; verify it has content
      const transcript = readTranscript('test-agent');
      expect(transcript).toContain('"type":"assistant"');

      // Push a second event and verify both are present
      const event2 = { type: 'result', result: 'Done' };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event2) + '\n'));

      const transcript2 = readTranscript('test-agent');
      expect(transcript2).toContain('"type":"assistant"');
      expect(transcript2).toContain('"type":"result"');
    });

    it('evicts old events when transcript exceeds cap', () => {
      // Set a very small cap to trigger eviction quickly
      setMaxTranscriptBytes(500);
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push events that collectively exceed 500 bytes
      for (let i = 0; i < 10; i++) {
        const event = { type: 'assistant', message: { content: [{ type: 'text', text: `Message ${i} ${'x'.repeat(100)}` }] } };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // The in-memory transcript should have fewer than 10 events due to eviction
      const transcript = readTranscript('test-agent');
      // Since transcriptEvicted is true, readTranscript tries disk first.
      // Mock readFileSync throws ENOENT, so it falls through to partial in-memory.
      // Count events in the returned string
      const lines = transcript!.split('\n').filter(l => l.trim());
      expect(lines.length).toBeLessThan(10);
      expect(lines.length).toBeGreaterThan(0);
    });

    it('keeps most recent events after eviction', () => {
      setMaxTranscriptBytes(500);
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push numbered events
      for (let i = 0; i < 10; i++) {
        const event = { type: 'result', result: `event-${i}-${'x'.repeat(80)}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // readTranscript falls through to partial in-memory (disk mock throws)
      const transcript = readTranscript('test-agent');
      // The last event should still be present
      expect(transcript).toContain('event-9');
      // Early events should have been evicted
      expect(transcript).not.toContain('event-0');
    });

    it('logs warning on first eviction', () => {
      setMaxTranscriptBytes(200);
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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

    it('readTranscript falls back to disk when transcript is evicted', () => {
      setMaxTranscriptBytes(200);
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push enough data to trigger eviction
      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `msg-${i}-${'x'.repeat(100)}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // Now make readFileSync return full transcript data
      const fullTranscript = '{"type":"result","result":"full-disk-data"}\n';
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(fullTranscript);

      const result = readTranscript('test-agent');
      expect(result).toBe(fullTranscript);
      expect(fs.readFileSync).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.jsonl'),
        'utf-8'
      );
    });

    it('getTranscriptSummary falls back to disk when transcript is evicted', () => {
      setMaxTranscriptBytes(200);
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push enough data to trigger eviction
      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `msg-${i}-${'x'.repeat(100)}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // Make readFileSync return a transcript with a result event
      const diskData = '{"type":"result","result":"Disk summary","cost_usd":0.1,"duration_ms":5000}\n';
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(diskData);

      const summary = getTranscriptSummary('test-agent');
      expect(summary).not.toBeNull();
      expect(summary!.summary).toBe('Disk summary');
      expect(summary!.costUsd).toBe(0.1);
    });

    it('does not evict when under the cap', () => {
      setMaxTranscriptBytes(1024 * 1024); // 1MB
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push a few small events — well under 1MB
      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `ok-${i}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      const transcript = readTranscript('test-agent');
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

    it('setMaxTranscriptBytes changes the cap', () => {
      // Start with a high cap
      setMaxTranscriptBytes(1024 * 1024);
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push small events (~40 bytes each) under the high cap
      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `m${i}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      // All 5 should be in memory
      let transcript = readTranscript('test-agent');
      let lines = transcript!.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(5);

      // Lower the cap — next event will push us over and trigger eviction
      // Each event is ~40 bytes, total ~240 bytes for 6 events.
      // With cap=150, target=112. Eviction removes oldest until under 112.
      setMaxTranscriptBytes(150);

      const event = { type: 'result', result: 'trigger' };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      // Some old events should be evicted now
      transcript = readTranscript('test-agent');
      lines = transcript!.split('\n').filter(l => l.trim());
      expect(lines.length).toBeLessThan(6);
      expect(lines.length).toBeGreaterThan(0);
      expect(transcript).toContain('trigger');
    });
  });

  // ============================================================
  // getTranscriptInfo (paginated API)
  // ============================================================
  describe('getTranscriptInfo', () => {
    beforeEach(() => {
      mockFsPromises.stat.mockReset();
      mockFsPromises.readFile.mockReset();
      mockFsPromises.stat.mockRejectedValue(new Error('ENOENT'));
      mockFsPromises.readFile.mockRejectedValue(new Error('ENOENT'));
    });

    it('returns null for unknown agent with no transcript on disk', async () => {
      const info = await getTranscriptInfo('unknown-agent');
      expect(info).toBeNull();
    });

    it('returns in-memory info for active session', async () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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
      mockFsPromises.readFile.mockResolvedValue(diskData);

      const info = await getTranscriptInfo('completed-agent');
      expect(info).not.toBeNull();
      expect(info!.totalEvents).toBe(2);
      expect(info!.fileSizeBytes).toBe(diskData.length);
    });

    it('falls back to disk when session has evicted events', async () => {
      setMaxTranscriptBytes(200);
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      // Push enough to trigger eviction
      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `msg-${i}-${'x'.repeat(100)}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      const diskData = '{"type":"result"}\n{"type":"result"}\n{"type":"result"}\n{"type":"result"}\n{"type":"result"}\n';
      mockFsPromises.stat.mockResolvedValue({ size: diskData.length });
      mockFsPromises.readFile.mockResolvedValue(diskData);

      const info = await getTranscriptInfo('test-agent');
      expect(info).not.toBeNull();
      expect(info!.totalEvents).toBe(5);
    });
  });

  // ============================================================
  // readTranscriptPage (paginated API)
  // ============================================================
  describe('readTranscriptPage', () => {
    beforeEach(() => {
      mockFsPromises.stat.mockReset();
      mockFsPromises.readFile.mockReset();
      mockFsPromises.stat.mockRejectedValue(new Error('ENOENT'));
      mockFsPromises.readFile.mockRejectedValue(new Error('ENOENT'));
    });

    it('returns null for unknown agent with no transcript on disk', async () => {
      const page = await readTranscriptPage('unknown-agent', 0, 10);
      expect(page).toBeNull();
    });

    it('returns sliced events from in-memory session', async () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      const event = { type: 'result', result: 'only' };
      mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));

      const page = await readTranscriptPage('test-agent', 10, 5);
      expect(page).not.toBeNull();
      expect(page!.totalEvents).toBe(1);
      expect(page!.events).toHaveLength(0);
    });

    it('reads page from disk for completed session', async () => {
      const events = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({ type: 'result', result: `disk-${i}` })
      ).join('\n') + '\n';

      mockFsPromises.readFile.mockResolvedValue(events);

      const page = await readTranscriptPage('completed-agent', 2, 2);
      expect(page).not.toBeNull();
      expect(page!.totalEvents).toBe(5);
      expect(page!.events).toHaveLength(2);
      expect(page!.events[0].result).toBe('disk-2');
      expect(page!.events[1].result).toBe('disk-3');
    });

    it('clamps page to available events', async () => {
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

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
      spawnHeadless('test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test']);

      for (let i = 0; i < 5; i++) {
        const event = { type: 'result', result: `msg-${i}-${'x'.repeat(100)}` };
        mockProcess.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
      }

      const diskEvents = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({ type: 'result', result: `disk-${i}` })
      ).join('\n') + '\n';
      mockFsPromises.readFile.mockResolvedValue(diskEvents);

      const page = await readTranscriptPage('test-agent', 0, 3);
      expect(page).not.toBeNull();
      expect(page!.totalEvents).toBe(5);
      expect(page!.events).toHaveLength(3);
      expect(page!.events[0].result).toBe('disk-0');
    });
  });
});
