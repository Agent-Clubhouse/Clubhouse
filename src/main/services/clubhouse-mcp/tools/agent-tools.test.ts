import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockUnlink = vi.fn().mockResolvedValue(undefined);
vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

const mockAgentRegistryGet = vi.fn();
vi.mock('../../agent-registry', () => ({
  agentRegistry: {
    get: (id: string) => mockAgentRegistryGet(id),
  },
  getAgentNonce: vi.fn(),
}));

const mockPtyWrite = vi.fn();
const mockPtyGetBuffer = vi.fn();
vi.mock('../../pty-manager', () => ({
  write: (...args: unknown[]) => mockPtyWrite(...args),
  getBuffer: (id: string) => mockPtyGetBuffer(id),
}));

const mockStructuredSendMessage = vi.fn();
vi.mock('../../structured-manager', () => ({
  sendMessage: (...args: unknown[]) => mockStructuredSendMessage(...args),
}));

const mockSpawnAgent = vi.fn().mockResolvedValue(undefined);
vi.mock('../../agent-system', () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
}));

const mockGetDurableConfig = vi.fn();
vi.mock('../../agent-config', () => ({
  getDurableConfig: (...args: unknown[]) => mockGetDurableConfig(...args),
}));

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

const mockGetProvider = vi.fn();
vi.mock('../../../orchestrators', () => ({
  getProvider: (id: string) => mockGetProvider(id),
}));

import { registerAgentTools, writeChunkedBracketedPaste } from './agent-tools';
import { getScopedToolList, callTool, buildToolName, _resetForTesting as resetTools } from '../tool-registry';
import { bindingManager } from '../binding-manager';
import type { McpBinding } from '../types';

function makeBinding(overrides: Partial<McpBinding> & { agentId: string; targetId: string; targetKind: McpBinding['targetKind'] }): McpBinding {
  return { label: 'Test', ...overrides };
}

function agentToolName(binding: McpBinding, suffix: string): string {
  return buildToolName(binding, suffix);
}

/**
 * Helper: call send_message and advance fake timers so the chunked paste
 * delays and the delayed \r retries / buffer checks all resolve.
 * Must be called within a fake-timer context (vi.useFakeTimers).
 *
 * Timeline (default provider):
 *   Paste marker delays: ~100ms (50ms after start + 50ms before end)
 *   Post-end-marker delay: 150ms
 *   Enter sequence: 500ms (1st \r) + 300ms (retry / 2nd \r) + 250ms (final check) = 1050ms
 *   Total: ~1300ms — we advance 1500ms for headroom.
 */
async function sendMessage(agentId: string, toolName: string, args: Record<string, unknown>) {
  const promise = callTool(agentId, toolName, args);
  // Advance through paste delays + post-end-marker delay + all three setTimeout stages
  await vi.advanceTimersByTimeAsync(1500);
  return promise;
}

describe('AgentTools', () => {
  const sourceBinding = makeBinding({
    agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent',
    label: 'Agent 2', agentName: 'mega-camel', targetName: 'scrappy-robin',
    projectName: 'myapp',
  });

  beforeEach(() => {
    vi.useFakeTimers();
    resetTools();
    bindingManager._resetForTesting();
    mockAgentRegistryGet.mockReset();
    mockPtyWrite.mockReset();
    mockPtyGetBuffer.mockReset();
    mockStructuredSendMessage.mockReset();
    mockGetProvider.mockReset();
    mockMkdir.mockReset().mockResolvedValue(undefined);
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockUnlink.mockReset().mockResolvedValue(undefined);
    mockSpawnAgent.mockReset().mockResolvedValue(undefined);
    mockGetDurableConfig.mockReset();

    // Default buffer mock for post-send heuristic
    mockPtyGetBuffer.mockReturnValue('');

    // Default provider mock — returns Claude Code timing with chunking
    mockGetProvider.mockReturnValue({
      getPasteSubmitTiming: () => ({ initialDelayMs: 500, retryDelayMs: 300, finalCheckDelayMs: 250, chunkSize: 512, chunkDelayMs: 50, postEndMarkerDelayMs: 150 }),
    });

    // Default: agent-2 is running (in registry) so all tools appear in scoped list
    mockAgentRegistryGet.mockImplementation((id: string) => {
      if (id === 'agent-2') return { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' };
      return undefined;
    });

    registerAgentTools();
    bindingManager.bind('agent-1', {
      targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
      agentName: 'mega-camel', targetName: 'scrappy-robin', projectName: 'myapp',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('tool registration', () => {
    it('registers all agent-to-agent tools', () => {
      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(6);
      const suffixes = tools.map(t => t.name.split('__').pop());
      expect(suffixes).toContain('send_message');
      expect(suffixes).toContain('get_status');
      expect(suffixes).toContain('read_output');
      expect(suffixes).toContain('check_connectivity');
      expect(suffixes).toContain('send_file');
      expect(suffixes).toContain('wake');
    });

    it('generates clubhouse-prefixed tool names with project and agent name', () => {
      const tools = getScopedToolList('agent-1');
      for (const tool of tools) {
        expect(tool.name).toMatch(/^clubhouse__myapp_scrappy_robin_[a-z0-9]+__/);
      }
    });
  });

  describe('send_message', () => {
    const sendToolName = agentToolName(sourceBinding, 'send_message');

    it('sends single-line message without bracketed paste', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const result = await sendMessage('agent-1', sendToolName, { message: 'hello', task_id: 'test123' });
      expect(result.isError).toBeFalsy();

      // First write: message without bracketed paste (single-line)
      const firstWrite = mockPtyWrite.mock.calls[0];
      expect(firstWrite[0]).toBe('agent-2');
      expect(firstWrite[1]).toContain('[TASK:test123]');
      expect(firstWrite[1]).toContain('[FROM:mega-camel@myapp]');
      expect(firstWrite[1]).toContain('hello');
      expect(firstWrite[1]).not.toContain('\x1b[200~');

      // Second write: delayed \r submit
      const secondWrite = mockPtyWrite.mock.calls[1];
      expect(secondWrite[0]).toBe('agent-2');
      expect(secondWrite[1]).toBe('\r');
    });

    it('wraps multi-line message in chunked bracketed paste', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const result = await sendMessage('agent-1', sendToolName, {
        message: 'line one\nline two\nline three',
        task_id: 'ml1',
      });
      expect(result.isError).toBeFalsy();

      // Chunked paste: start marker, body (fits in single 512-byte chunk), end marker
      const writes = mockPtyWrite.mock.calls.map(c => c[1]);
      expect(writes[0]).toBe('\x1b[200~');
      // Body fits within chunkSize (512) so it's a single write
      expect(writes[1]).toContain('[TASK:ml1]');
      expect(writes[1]).toContain('line one\nline two\nline three');
      expect(writes[2]).toBe('\x1b[201~');

      // Then delayed \r submit
      expect(writes[3]).toBe('\r');
    });

    it('uses chunked bracketed paste for bidirectional messages (reply instructions contain newlines)', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      // Create reverse binding: agent-2 → agent-1
      bindingManager.bind('agent-2', {
        targetId: 'agent-1', targetKind: 'agent', label: 'Agent 1',
        agentName: 'scrappy-robin', targetName: 'mega-camel', projectName: 'myapp',
      });

      const result = await sendMessage('agent-1', sendToolName, { message: 'do something', task_id: 'bidir1' });
      expect(result.isError).toBeFalsy();

      const writes = mockPtyWrite.mock.calls.map(c => c[1]);
      // Chunked: start marker, body, end marker
      expect(writes[0]).toBe('\x1b[200~');
      expect(writes[1]).toContain('Reply to mega-camel via tool');
      expect(writes[1]).toContain('clubhouse__');
      expect(writes[1]).toContain('task_id="bidir1"');
      expect(writes[2]).toBe('\x1b[201~');

      // Result should indicate bidirectional
      expect(result.content[0].text).toContain('Bidirectional');
      expect(result.content[0].text).toContain('scrappy-robin');
    });

    it('does not include reply instructions when unidirectional', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });

      const result = await sendMessage('agent-1', sendToolName, { message: 'do something', task_id: 'uni1' });
      expect(result.isError).toBeFalsy();

      const firstWrite = mockPtyWrite.mock.calls[0][1];
      expect(firstWrite).not.toContain('Reply to');
      // Single-line unidirectional — no bracketed paste
      expect(firstWrite).not.toContain('\x1b[200~');
      expect(result.content[0].text).toContain('poll read_output');
    });

    it('sends delayed \\r and retries with second \\r when buffer does not grow (force_submit=true)', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      // Buffer stays empty → first \r doesn't trigger processing → retry
      mockPtyGetBuffer.mockReturnValue('');
      await sendMessage('agent-1', sendToolName, { message: 'hello', task_id: 'fs1' });

      // Should have 3 writes: message + 1st \r + 2nd \r (retry)
      expect(mockPtyWrite).toHaveBeenCalledTimes(3);
      expect(mockPtyWrite.mock.calls[1][1]).toBe('\r');
      expect(mockPtyWrite.mock.calls[2][1]).toBe('\r');
    });

    it('skips second \\r when first Enter triggers processing (buffer grows)', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      // Simulate buffer growing after first \r
      let callCount = 0;
      mockPtyGetBuffer.mockImplementation(() => {
        callCount++;
        return callCount <= 1 ? 'short' : 'short + agent processed message output';
      });
      await sendMessage('agent-1', sendToolName, { message: 'hello', task_id: 'fs2' });

      // Should have 2 writes: message + 1st \r (no retry needed)
      expect(mockPtyWrite).toHaveBeenCalledTimes(2);
      expect(mockPtyWrite.mock.calls[1][1]).toBe('\r');
    });

    it('skips delayed \\r when force_submit=false', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const result = await sendMessage('agent-1', sendToolName, {
        message: 'hello',
        task_id: 'nosubmit',
        force_submit: false,
      });
      expect(result.isError).toBeFalsy();

      // Only 1 write: the message itself, no \r
      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
      expect(mockPtyWrite.mock.calls[0][1]).not.toContain('\r');

      // Result should note force_submit=false
      expect(result.content[0].text).toContain('force_submit=false');
    });

    it('skips delayed \\r for multi-line when force_submit=false', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const result = await sendMessage('agent-1', sendToolName, {
        message: 'line1\nline2',
        task_id: 'mlnosubmit',
        force_submit: false,
      });
      expect(result.isError).toBeFalsy();

      // 3 writes: start marker, body, end marker — no \r
      expect(mockPtyWrite).toHaveBeenCalledTimes(3);
      const writes = mockPtyWrite.mock.calls.map(c => c[1]);
      expect(writes[0]).toBe('\x1b[200~');
      expect(writes[1]).toContain('line1\nline2');
      expect(writes[2]).toBe('\x1b[201~');
    });

    it('uses provider-specific paste timing for copilot-cli agents', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'copilot-cli' });
      mockGetProvider.mockReturnValue({
        getPasteSubmitTiming: () => ({ initialDelayMs: 1200, retryDelayMs: 600, finalCheckDelayMs: 400 }),
      });

      // Buffer stays empty → retry path
      mockPtyGetBuffer.mockReturnValue('');
      const promise = callTool('agent-1', sendToolName, { message: 'hello', task_id: 'cop1' });

      // After 1100ms only the message write should have happened (no Enter yet)
      await vi.advanceTimersByTimeAsync(1100);
      expect(mockPtyWrite).toHaveBeenCalledTimes(1);

      // At 1200ms the first Enter fires
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPtyWrite).toHaveBeenCalledTimes(2);
      expect(mockPtyWrite.mock.calls[1][1]).toBe('\r');

      // At 1700ms (not yet 1800ms) no second Enter yet
      await vi.advanceTimersByTimeAsync(500);
      expect(mockPtyWrite).toHaveBeenCalledTimes(2);

      // At 1800ms the second Enter fires
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPtyWrite).toHaveBeenCalledTimes(3);
      expect(mockPtyWrite.mock.calls[2][1]).toBe('\r');

      // Drain the final check delay
      await vi.advanceTimersByTimeAsync(400);
      await promise;
    });

    it('falls back to default timing when provider not found', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'unknown-cli' });
      mockGetProvider.mockReturnValue(undefined);

      mockPtyGetBuffer.mockReturnValue('');
      const promise = callTool('agent-1', sendToolName, { message: 'hello', task_id: 'fb1' });

      // Falls back to 500/300/250 — total 1050ms
      await vi.advanceTimersByTimeAsync(1200);
      await promise;

      // message + 2x \r (retry because buffer didn't grow)
      expect(mockPtyWrite).toHaveBeenCalledTimes(3);
    });

    it('performs post-send buffer checks for delivery heuristic', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      // Simulate buffer NOT growing after first \r — same length triggers retry
      let callCount = 0;
      mockPtyGetBuffer.mockImplementation(() => {
        callCount++;
        // Call 1 (before submit): 'short' (length 5)
        // Call 2 (after first \r): still 'short' (length 5) → triggers retry \r
        return callCount <= 2 ? 'short' : 'short + agent processed message output';
      });

      const result = await sendMessage('agent-1', sendToolName, { message: 'hello', task_id: 'buf1' });
      expect(result.isError).toBeFalsy();
      // submitAfterPaste checks buffer: once before submit, once after 1st \r
      expect(mockPtyGetBuffer).toHaveBeenCalledTimes(2);
    });

    it('includes sender name without project when project not set', async () => {
      bindingManager._resetForTesting();
      resetTools();
      registerAgentTools();
      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
        agentName: 'mega-camel', targetName: 'scrappy-robin',
      });
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });

      const toolName = buildToolName(makeBinding({
        agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent',
        targetName: 'scrappy-robin',
      }), 'send_message');

      const result = await sendMessage('agent-1', toolName, { message: 'hello', task_id: 'x1' });
      expect(result.isError).toBeFalsy();
      expect(mockPtyWrite.mock.calls[0][1]).toContain('[FROM:mega-camel]');
    });

    it('auto-generates task_id when not provided', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const result = await sendMessage('agent-1', sendToolName, { message: 'hello' });
      expect(result.isError).toBeFalsy();
      // Should have auto-generated a task_id starting with t_
      expect(result.content[0].text).toMatch(/task_id=t_/);
      // First write should contain the tagged message with FROM (no \r — that's the second write)
      const firstWrite = mockPtyWrite.mock.calls[0];
      expect(firstWrite[1]).toMatch(/^\[TASK:t_[a-z0-9]+\] \[FROM:mega-camel@myapp\] hello$/);
    });

    it('sends tagged message to structured agent', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'structured', orchestrator: 'claude-code' });
      const result = await callTool('agent-1', sendToolName, { message: 'hello', task_id: 'abc' });
      expect(result.isError).toBeFalsy();
      expect(mockStructuredSendMessage).toHaveBeenCalledWith('agent-2', expect.stringContaining('[TASK:abc]'));
      expect(mockStructuredSendMessage).toHaveBeenCalledWith('agent-2', expect.stringContaining('[FROM:mega-camel@myapp]'));
    });

    it('returns error when agent not running', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);
      const result = await callTool('agent-1', sendToolName, { message: 'hello' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('is sleeping');
    });

    it('returns error for headless runtime', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'headless', orchestrator: 'claude-code' });
      const result = await callTool('agent-1', sendToolName, { message: 'hello' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not support input');
    });

    it('returns error when message is missing', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const result = await callTool('agent-1', sendToolName, {});
      expect(result.isError).toBe(true);
    });
  });

  describe('get_status', () => {
    it('returns running status for active agent', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const toolName = agentToolName(sourceBinding, 'get_status');
      const result = await callTool('agent-1', toolName, {});
      expect(result.isError).toBeFalsy();
      const status = JSON.parse(result.content[0].text!);
      expect(status.running).toBe(true);
      expect(status.runtime).toBe('pty');
    });

    it('returns not running for inactive agent', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);
      const toolName = agentToolName(sourceBinding, 'get_status');
      const result = await callTool('agent-1', toolName, {});
      const status = JSON.parse(result.content[0].text!);
      expect(status.running).toBe(false);
    });
  });

  describe('read_output', () => {
    const readToolName = agentToolName(sourceBinding, 'read_output');

    it('reads last N lines from PTY buffer', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      mockPtyGetBuffer.mockReturnValue('line1\nline2\nline3\nline4\nline5');

      const result = await callTool('agent-1', readToolName, { lines: 3 });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('line3\nline4\nline5');
    });

    it('defaults to 50 lines', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
      mockPtyGetBuffer.mockReturnValue(lines);

      const result = await callTool('agent-1', readToolName, {});
      const outputLines = result.content[0].text!.split('\n');
      expect(outputLines).toHaveLength(50);
    });

    it('caps at 500 lines', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const lines = Array.from({ length: 1000 }, (_, i) => `line${i}`).join('\n');
      mockPtyGetBuffer.mockReturnValue(lines);

      const result = await callTool('agent-1', readToolName, { lines: 999 });
      const outputLines = result.content[0].text!.split('\n');
      expect(outputLines).toHaveLength(500);
    });

    it('returns error for non-PTY agents', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'structured', orchestrator: 'claude-code' });
      const result = await callTool('agent-1', readToolName, {});
      expect(result.isError).toBe(true);
    });

    it('returns error when agent not running', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);
      const result = await callTool('agent-1', readToolName, {});
      expect(result.isError).toBe(true);
    });

    it('handles empty buffer', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      mockPtyGetBuffer.mockReturnValue(null);

      const result = await callTool('agent-1', readToolName, {});
      expect(result.content[0].text).toBe('No output available');
    });

    it('handles single-line buffer', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      mockPtyGetBuffer.mockReturnValue('only one line');

      const result = await callTool('agent-1', readToolName, { lines: 5 });
      expect(result.content[0].text).toBe('only one line');
    });

    it('handles empty string buffer', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      mockPtyGetBuffer.mockReturnValue('');

      const result = await callTool('agent-1', readToolName, {});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('send_message error handling', () => {
    const sendToolName = agentToolName(sourceBinding, 'send_message');

    it('handles PTY write failure', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      mockPtyWrite.mockImplementation(() => { throw new Error('PTY write failed'); });

      const result = await callTool('agent-1', sendToolName, { message: 'hello' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('PTY write failed');
    });

    it('handles structured manager failure', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'structured', orchestrator: 'claude-code' });
      mockStructuredSendMessage.mockRejectedValue(new Error('Structured send failed'));

      const result = await callTool('agent-1', sendToolName, { message: 'hello' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Structured send failed');
    });
  });

  describe('multi-agent bindings', () => {
    it('agent can send messages to multiple bound agents', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      bindingManager.bind('agent-1', {
        targetId: 'agent-3', targetKind: 'agent', label: 'Agent 3',
        targetName: 'faithful-urchin', projectName: 'myapp',
      });

      const tools = getScopedToolList('agent-1');
      // 6 tools for agent-2 + 6 tools for agent-3 = 12
      expect(tools).toHaveLength(12);

      const sendToolAgent2 = agentToolName(sourceBinding, 'send_message');
      const sendToolAgent3 = agentToolName(makeBinding({
        agentId: 'agent-1', targetId: 'agent-3', targetKind: 'agent',
        targetName: 'faithful-urchin', projectName: 'myapp',
      }), 'send_message');

      const r1 = await sendMessage('agent-1', sendToolAgent2, { message: 'to-2', task_id: 'x1' });
      const r2 = await sendMessage('agent-1', sendToolAgent3, { message: 'to-3', task_id: 'x2' });
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      expect(mockPtyWrite).toHaveBeenCalledWith('agent-2', expect.stringContaining('[TASK:x1]'));
      expect(mockPtyWrite).toHaveBeenCalledWith('agent-3', expect.stringContaining('[TASK:x2]'));
    });
  });

  describe('writeChunkedBracketedPaste', () => {
    it('sends start, body, end with marker delays even without chunking', async () => {
      const promise = writeChunkedBracketedPaste('agent-2', 'hello\nworld');
      // Default chunkDelayMs=30 → 30ms after start + 30ms before end = 60ms
      // Default postEndMarkerDelayMs=150 → 150ms after end marker
      await vi.advanceTimersByTimeAsync(250);
      await promise;
      expect(mockPtyWrite).toHaveBeenCalledTimes(3);
      expect(mockPtyWrite.mock.calls[0][1]).toBe('\x1b[200~');
      expect(mockPtyWrite.mock.calls[1][1]).toBe('hello\nworld');
      expect(mockPtyWrite.mock.calls[2][1]).toBe('\x1b[201~');
    });

    it('chunks body when chunkSize is set', async () => {
      const body = 'ABCDEFGHIJ'; // 10 chars
      const promise = writeChunkedBracketedPaste('agent-2', body, 4, 10, 50);
      // Need to advance timers for the sleep() calls:
      // 10ms after start marker + 10ms between chunk1-2 + 10ms between chunk2-3 + 10ms before end marker + 50ms post-end = 90ms
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // start + 3 body chunks (4+4+2) + end = 5 writes
      expect(mockPtyWrite).toHaveBeenCalledTimes(5);
      expect(mockPtyWrite.mock.calls[0][1]).toBe('\x1b[200~');
      expect(mockPtyWrite.mock.calls[1][1]).toBe('ABCD');
      expect(mockPtyWrite.mock.calls[2][1]).toBe('EFGH');
      expect(mockPtyWrite.mock.calls[3][1]).toBe('IJ');
      expect(mockPtyWrite.mock.calls[4][1]).toBe('\x1b[201~');
    });

    it('sends body as single write when it fits in one chunk', async () => {
      const promise = writeChunkedBracketedPaste('agent-2', 'hi', 256, 30, 50);
      await vi.advanceTimersByTimeAsync(150);
      await promise;
      expect(mockPtyWrite).toHaveBeenCalledTimes(3);
      expect(mockPtyWrite.mock.calls[1][1]).toBe('hi');
    });

    it('always delays after start marker and before end marker', async () => {
      const body = 'ABCDEF'; // 6 chars, chunkSize=3 → 2 chunks
      const chunkDelayMs = 20;
      const postEndMarkerDelayMs = 40;
      const promise = writeChunkedBracketedPaste('agent-2', body, 3, chunkDelayMs, postEndMarkerDelayMs);

      // At t=0: start marker written immediately
      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
      expect(mockPtyWrite.mock.calls[0][1]).toBe('\x1b[200~');

      // At t=20ms: first chunk written (after post-start delay)
      await vi.advanceTimersByTimeAsync(chunkDelayMs);
      expect(mockPtyWrite).toHaveBeenCalledTimes(2);
      expect(mockPtyWrite.mock.calls[1][1]).toBe('ABC');

      // At t=40ms: second chunk written (after inter-chunk delay)
      await vi.advanceTimersByTimeAsync(chunkDelayMs);
      expect(mockPtyWrite).toHaveBeenCalledTimes(3);
      expect(mockPtyWrite.mock.calls[2][1]).toBe('DEF');

      // At t=60ms: end marker written (after pre-end delay)
      await vi.advanceTimersByTimeAsync(chunkDelayMs);
      expect(mockPtyWrite).toHaveBeenCalledTimes(4);
      expect(mockPtyWrite.mock.calls[3][1]).toBe('\x1b[201~');

      // At t=100ms: post-end-marker delay completes, function resolves
      await vi.advanceTimersByTimeAsync(postEndMarkerDelayMs);
      await promise;
    });

    it('still adds marker delays when body fits in a single write', async () => {
      // Even when body <= chunkSize, marker delays are applied
      const chunkDelayMs = 50;
      const postEndMarkerDelayMs = 80;
      const promise = writeChunkedBracketedPaste('agent-2', 'AB', 256, chunkDelayMs, postEndMarkerDelayMs);

      // At t=0: start marker written
      expect(mockPtyWrite).toHaveBeenCalledTimes(1);

      // At t=50ms: body written (after post-start delay)
      await vi.advanceTimersByTimeAsync(chunkDelayMs);
      expect(mockPtyWrite).toHaveBeenCalledTimes(2);
      expect(mockPtyWrite.mock.calls[1][1]).toBe('AB');

      // At t=100ms: end marker written (after pre-end delay)
      await vi.advanceTimersByTimeAsync(chunkDelayMs);
      expect(mockPtyWrite).toHaveBeenCalledTimes(3);
      expect(mockPtyWrite.mock.calls[2][1]).toBe('\x1b[201~');

      // At t=180ms: post-end-marker delay completes, function resolves
      await vi.advanceTimersByTimeAsync(postEndMarkerDelayMs);
      await promise;
    });

    it('post-end-marker delay prevents \\r from being folded into paste', async () => {
      // Simulates the real flow: writeChunkedBracketedPaste followed by submitAfterPaste
      // The post-end-marker delay ensures the promise doesn't resolve until
      // after the CLI has time to exit paste mode.
      const chunkDelayMs = 20;
      const postEndMarkerDelayMs = 100;
      const promise = writeChunkedBracketedPaste('agent-2', 'A\nB', 256, chunkDelayMs, postEndMarkerDelayMs);

      // Advance through chunk delays but NOT through post-end-marker delay
      // chunkDelay after start (20) + chunkDelay before end (20) = 40ms
      await vi.advanceTimersByTimeAsync(40);
      // End marker should be written
      expect(mockPtyWrite).toHaveBeenCalledTimes(3);
      expect(mockPtyWrite.mock.calls[2][1]).toBe('\x1b[201~');

      // Promise should NOT have resolved yet — post-end-marker delay still pending
      let resolved = false;
      promise.then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(0); // flush microtasks
      expect(resolved).toBe(false);

      // After post-end-marker delay, promise resolves — safe to send \r
      await vi.advanceTimersByTimeAsync(postEndMarkerDelayMs);
      await promise;
    });
  });

  describe('send_file', () => {
    const sendFileToolName = agentToolName(sourceBinding, 'send_file');

    it('writes content to temp file and sends single-line PTY notification', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const promise = callTool('agent-1', sendFileToolName, {
        content: 'multi\nline\ncontent',
        task_id: 'sf1',
      });
      await vi.advanceTimersByTimeAsync(400);
      const result = await promise;

      expect(result.isError).toBeFalsy();
      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('sf1-sf1.md'),
        'multi\nline\ncontent',
        'utf-8',
      );

      // PTY write: single-line notification + Enter
      const writes = mockPtyWrite.mock.calls.map(c => c[1]);
      expect(writes[0]).toContain('[TASK:sf1]');
      expect(writes[0]).toContain('File delivered');
      expect(writes[0]).not.toContain('\n');
      expect(writes[1]).toBe('\r');

      expect(result.content[0].text).toContain('File delivered');
      expect(result.content[0].text).toContain('task_id=sf1');
    });

    it('sends to structured agent', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'structured', orchestrator: 'claude-code' });
      const result = await callTool('agent-1', sendFileToolName, {
        content: 'data',
        task_id: 'sf2',
      });
      expect(result.isError).toBeFalsy();
      expect(mockStructuredSendMessage).toHaveBeenCalledWith(
        'agent-2',
        expect.stringContaining('File delivered'),
      );
    });

    it('returns error when agent not running', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);
      const result = await callTool('agent-1', sendFileToolName, { content: 'test' });
      expect(result.isError).toBe(true);
    });

    it('returns error when content is missing', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const result = await callTool('agent-1', sendFileToolName, {});
      expect(result.isError).toBe(true);
    });

    it('strips path traversal sequences from filename', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const promise = callTool('agent-1', sendFileToolName, {
        content: 'pwned',
        task_id: 'sf_evil',
        filename: '../../etc/passwd',
      });
      await vi.advanceTimersByTimeAsync(400);
      await promise;

      // path.basename('../../etc/passwd') → 'passwd', so file stays in temp dir
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('sf_evil-passwd'),
        'pwned',
        'utf-8',
      );
      // Must NOT contain directory traversal in the written path
      const writtenPath = mockWriteFile.mock.calls[0][0] as string;
      expect(writtenPath).not.toContain('..');
    });

    it('uses custom filename when provided', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const promise = callTool('agent-1', sendFileToolName, {
        content: '{}',
        task_id: 'sf3',
        filename: 'data.json',
      });
      await vi.advanceTimersByTimeAsync(400);
      await promise;

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('sf3-data.json'),
        '{}',
        'utf-8',
      );
    });
  });

  describe('wake', () => {
    const wakeToolName = agentToolName(sourceBinding, 'wake');

    it('returns already running when target agent is active', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code', projectPath: '/project' });
      const result = await callTool('agent-1', wakeToolName, {});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('already running');
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    it('spawns sleeping agent using durable config', async () => {
      // Target agent not running, calling agent is running
      mockAgentRegistryGet.mockImplementation((id: string) => {
        if (id === 'agent-1') return { runtime: 'pty', orchestrator: 'claude-code', projectPath: '/project' };
        return undefined; // agent-2 is sleeping
      });
      mockGetDurableConfig.mockResolvedValue({
        id: 'agent-2',
        name: 'scrappy-robin',
        color: 'blue',
        worktreePath: '/project/.clubhouse/agents/scrappy-robin',
        model: 'claude-sonnet-4.5',
        orchestrator: 'claude-code',
        createdAt: '2025-01-01',
      });

      const result = await callTool('agent-1', wakeToolName, {});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('is waking up');
      expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-2',
        projectPath: '/project',
        cwd: '/project/.clubhouse/agents/scrappy-robin',
        kind: 'durable',
        model: 'claude-sonnet-4.5',
        resume: false,
      }));
    });

    it('spawns with resume=true and passes lastSessionId', async () => {
      mockAgentRegistryGet.mockImplementation((id: string) => {
        if (id === 'agent-1') return { runtime: 'pty', orchestrator: 'claude-code', projectPath: '/project' };
        return undefined;
      });
      mockGetDurableConfig.mockResolvedValue({
        id: 'agent-2',
        name: 'scrappy-robin',
        color: 'blue',
        createdAt: '2025-01-01',
        lastSessionId: 'session-abc-123',
      });

      const result = await callTool('agent-1', wakeToolName, { resume: true });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('is waking up');
      expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-2',
        resume: true,
        sessionId: 'session-abc-123',
      }));
    });

    it('falls back to projectPath as cwd when no worktreePath', async () => {
      mockAgentRegistryGet.mockImplementation((id: string) => {
        if (id === 'agent-1') return { runtime: 'pty', orchestrator: 'claude-code', projectPath: '/project' };
        return undefined;
      });
      mockGetDurableConfig.mockResolvedValue({
        id: 'agent-2', name: 'robin', color: 'red', createdAt: '2025-01-01',
      });

      await callTool('agent-1', wakeToolName, {});
      expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
        cwd: '/project',
      }));
    });

    it('returns error when no durable config found', async () => {
      mockAgentRegistryGet.mockImplementation((id: string) => {
        if (id === 'agent-1') return { runtime: 'pty', orchestrator: 'claude-code', projectPath: '/project' };
        return undefined;
      });
      mockGetDurableConfig.mockResolvedValue(null);

      const result = await callTool('agent-1', wakeToolName, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No durable agent config found');
    });

    it('returns error when caller agent is not registered', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);

      const result = await callTool('agent-1', wakeToolName, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot determine project path');
    });

    it('returns error when spawn fails', async () => {
      mockAgentRegistryGet.mockImplementation((id: string) => {
        if (id === 'agent-1') return { runtime: 'pty', orchestrator: 'claude-code', projectPath: '/project' };
        return undefined;
      });
      mockGetDurableConfig.mockResolvedValue({
        id: 'agent-2', name: 'robin', color: 'red', createdAt: '2025-01-01',
      });
      mockSpawnAgent.mockRejectedValue(new Error('CLI not available'));

      const result = await callTool('agent-1', wakeToolName, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('CLI not available');
    });
  });

  describe('check_connectivity', () => {
    const connectToolName = agentToolName(sourceBinding, 'check_connectivity');

    it('returns unidirectional when no reverse binding exists', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const result = await callTool('agent-1', connectToolName, {});
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text!);
      expect(data.direction).toBe('unidirectional');
      expect(data.guidance).toContain('CANNOT send messages back');
    });

    it('returns bidirectional when reverse binding exists', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      // Create the reverse binding: agent-2 → agent-1
      bindingManager.bind('agent-2', {
        targetId: 'agent-1', targetKind: 'agent', label: 'Agent 1',
        agentName: 'scrappy-robin', targetName: 'mega-camel', projectName: 'myapp',
      });

      const result = await callTool('agent-1', connectToolName, {});
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text!);
      expect(data.direction).toBe('bidirectional');
      expect(data.guidance).toContain('send messages back to you directly');
    });

    it('includes reply tool name when bidirectional', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      bindingManager.bind('agent-2', {
        targetId: 'agent-1', targetKind: 'agent', label: 'Agent 1',
        agentName: 'scrappy-robin', targetName: 'mega-camel', projectName: 'myapp',
      });

      const result = await callTool('agent-1', connectToolName, {});
      const data = JSON.parse(result.content[0].text!);
      expect(data.replyTool).toBeDefined();
      expect(data.replyTool).toMatch(/^clubhouse__/);
      expect(data.replyTool).toContain('send_message');
    });

    it('returns error when target agent not running', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);
      const result = await callTool('agent-1', connectToolName, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('is sleeping');
    });
  });
});
