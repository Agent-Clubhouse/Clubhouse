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

// Mock shell environment
vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '/usr/local/bin' })),
}));

// Mock log service
vi.mock('./log-service', () => ({
  appLog: vi.fn(),
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

import { IPC } from '../../shared/ipc-channels';
import {
  spawnHeadless,
  isHeadless,
  kill,
  readTranscript,
  getTranscriptSummary,
} from './headless-manager';

describe('headless-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00Z'));
    mockProcess = createMockProcess();
    mockWriteStream.write.mockClear();
    mockWriteStream.end.mockClear();
  });

  afterEach(() => {
    // Clean up any active sessions by killing them
    if (isHeadless('test-agent')) {
      kill('test-agent');
      // Trigger close to clean up
      mockProcess.emit('close', 0);
    }
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

      // CLAUDECODE and CLAUDE_CODE_ENTRYPOINT should be removed
      const envArg = (mockCpSpawn.mock.calls[0] as any[])[2].env;
      expect(envArg.CLAUDECODE).toBeUndefined();
      expect(envArg.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    });
  });
});
