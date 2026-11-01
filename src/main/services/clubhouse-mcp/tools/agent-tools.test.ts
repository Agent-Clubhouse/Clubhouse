import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIsStopping = vi.hoisted(() => vi.fn((_id?: unknown) => false));
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
  isStopping: (...args: unknown[]) => mockIsStopping(...args),
}));

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

const mockGetProvider = vi.fn();
vi.mock('../../../orchestrators', () => ({
  getProvider: (id: string) => mockGetProvider(id),
}));

vi.mock('../../dispatcher/dispatcher-settings', () => ({
  isDispatcherEnabled: () => true,
}));

const lifecycle = vi.hoisted(() => ({
  sleepAgent: vi.fn(),
  wakeWiredAgent: vi.fn(),
}));
vi.mock('./agent-lifecycle', () => lifecycle);

import { registerAgentTools, writeChunkedBracketedPaste, waitForBufferQuiescence } from './agent-tools';
import { getScopedToolList, callTool, buildToolName, invalidateToolListCache, _resetForTesting as resetTools } from '../tool-registry';
import { mcpAdapter } from '../mcp-adapter';
import { bindingManager } from '../binding-manager';
import { setDispatcherAgent, _resetDispatcherGateForTesting } from '../dispatcher-gate';
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
    mcpAdapter._resetForTesting();
    bindingManager._resetForTesting();
    mockAgentRegistryGet.mockReset();
    mockPtyWrite.mockReset();
    mockPtyGetBuffer.mockReset();
    mockGetProvider.mockReset();
    mockMkdir.mockReset().mockResolvedValue(undefined);
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockUnlink.mockReset().mockResolvedValue(undefined);

    // Default buffer mock for post-send heuristic
    mockPtyGetBuffer.mockReturnValue('');

    // Default provider mock — returns Claude Code timing with chunking
    mockGetProvider.mockReturnValue({
      getCapabilities: () => ({}),
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
      expect(tools).toHaveLength(7);
      const suffixes = tools.map(t => t.name.split('__').pop());
      expect(suffixes).toContain('send_message');
      expect(suffixes).toContain('get_status');
      expect(suffixes).toContain('read_output');
      expect(suffixes).toContain('check_connectivity');
      expect(suffixes).toContain('send_file');
      expect(suffixes).toContain('clear_agent');
      expect(suffixes).toContain('compact_agent');
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

    it('refuses a target whose terminal is shutting down, writing nothing', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      mockIsStopping.mockReturnValue(true);
      try {
        const result = await sendMessage('agent-1', sendToolName, { message: 'hello', task_id: 't-stop' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('is shutting down, so the message was not delivered');
        expect(mockPtyWrite).not.toHaveBeenCalled();
      } finally {
        mockIsStopping.mockReturnValue(false);
      }
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
        getCapabilities: () => ({}),
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
      await vi.advanceTimersByTimeAsync(600);
      await promise;
    });

    it('Claude Code path: fires \\r at exact fixed initialDelayMs and never polls the buffer (regression guard)', async () => {
      // Claude works perfectly on fixed-delay timing. This test pins down
      // that contract: NO quiescence polling, \r at exactly 500ms after the
      // paste sequence ends, and getBuffer called exactly twice (the
      // boundary reads in submitAfterPaste — never inside a poll loop).
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      // Default beforeEach provider mock: 500/300/250, chunk 512/50, postEnd 150, NO quiescenceMs
      mockPtyGetBuffer.mockReturnValue('');

      const promise = callTool('agent-1', sendToolName, { message: 'l1\nl2', task_id: 'r1' });

      // Paste sequence: 50 + 50 + 150 = 250ms before submitAfterPaste runs
      await vi.advanceTimersByTimeAsync(250);
      expect(mockPtyWrite.mock.calls.filter(c => c[1] === '\r')).toHaveLength(0);

      // At paste+499ms: still no \r (fixed 500ms wait, no early-fire from quiescence)
      await vi.advanceTimersByTimeAsync(499);
      expect(mockPtyWrite.mock.calls.filter(c => c[1] === '\r')).toHaveLength(0);

      // At paste+500ms: first \r fires exactly on time
      await vi.advanceTimersByTimeAsync(1);
      expect(mockPtyWrite.mock.calls.filter(c => c[1] === '\r')).toHaveLength(1);

      // Drain retry + final check
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      // CRITICAL regression check: exactly 2 getBuffer calls (bufferBefore +
      // bufferAfterFirst). If quiescence ever leaks onto the Claude path,
      // this jumps to many more from the poll loop and the test fails loud.
      expect(mockPtyGetBuffer).toHaveBeenCalledTimes(2);
    });

    it('uses quiescence wait instead of fixed initialDelayMs when quiescenceMs is set', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'copilot-cli' });
      mockGetProvider.mockReturnValue({
        getCapabilities: () => ({}),
        getPasteSubmitTiming: () => ({
          initialDelayMs: 2000,         // large cap; quiescence should fire well before
          retryDelayMs: 200,
          finalCheckDelayMs: 100,
          chunkSize: 256,
          chunkDelayMs: 30,
          postEndMarkerDelayMs: 50,
          quiescenceMs: 100,
          quiescencePollMs: 25,
        }),
      });

      // Stable buffer from the start — paste preview "already rendered"
      mockPtyGetBuffer.mockReturnValue('settled');

      const promise = callTool('agent-1', sendToolName, { message: 'l1\nl2', task_id: 'q1' });

      // Paste sequence: 30 + 30 + 50 = 110ms before submitAfterPaste runs
      await vi.advanceTimersByTimeAsync(110);
      expect(mockPtyWrite.mock.calls.filter(c => c[1] === '\r')).toHaveLength(0);

      // Quiescence settles ~100ms later (well before the 2000ms cap)
      await vi.advanceTimersByTimeAsync(120);
      expect(mockPtyWrite.mock.calls.filter(c => c[1] === '\r')).toHaveLength(1);

      // Drain retry quiescence + final check
      await vi.advanceTimersByTimeAsync(500);
      await promise;

      // Buffer never grew, so retry sends a 2nd \r
      expect(mockPtyWrite.mock.calls.filter(c => c[1] === '\r')).toHaveLength(2);
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
      mcpAdapter._resetForTesting();
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
      mockAgentRegistryGet.mockReturnValue({ runtime: 'headless', orchestrator: 'claude-code' });
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
  });

  describe('multi-agent bindings', () => {
    it('agent can send messages to multiple bound agents', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      bindingManager.bind('agent-1', {
        targetId: 'agent-3', targetKind: 'agent', label: 'Agent 3',
        targetName: 'faithful-urchin', projectName: 'myapp',
      });

      const tools = getScopedToolList('agent-1');
      // 7 tools for agent-2 + 7 tools for agent-3 = 14
      expect(tools).toHaveLength(14);

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

  describe('Dispatcher wake and sleep (#2577)', () => {
    const toTarget = makeBinding({
      agentId: 'dispatcher-1', targetId: 'orch-1', targetKind: 'agent',
      label: 'boss', agentName: 'Dispatcher', targetName: 'boss', projectName: 'myapp',
    });
    const back = makeBinding({
      agentId: 'orch-1', targetId: 'dispatcher-1', targetKind: 'agent',
      label: 'Dispatcher', agentName: 'boss', targetName: 'Dispatcher', projectName: 'myapp',
    });
    const ok = { content: [{ type: 'text' as const, text: '{}' }] };
    const suffixes = (agentId: string) => getScopedToolList(agentId).map((t) => t.name.split('__').pop());

    beforeEach(() => {
      lifecycle.sleepAgent.mockReset().mockResolvedValue(ok);
      lifecycle.wakeWiredAgent.mockReset().mockResolvedValue(ok);
      _resetDispatcherGateForTesting();
      setDispatcherAgent('dispatcher-1', true);
      bindingManager.bind('dispatcher-1', {
        targetId: 'orch-1', targetKind: 'agent', label: 'boss', agentName: 'Dispatcher', targetName: 'boss', projectName: 'myapp',
      });
      bindingManager.bind('orch-1', {
        targetId: 'dispatcher-1', targetKind: 'agent', label: 'Dispatcher', agentName: 'boss', targetName: 'Dispatcher', projectName: 'myapp',
      });
    });

    afterEach(() => { _resetDispatcherGateForTesting(); });

    it('are registered in the dispatcher group: the Dispatcher sees them by target state', () => {
      expect(suffixes('dispatcher-1')).toEqual(['get_status', 'wake_agent']);
      mockAgentRegistryGet.mockImplementation((id: string) => (id === 'orch-1' ? { runtime: 'chat' } : undefined));
      invalidateToolListCache();
      expect(suffixes('dispatcher-1')).toContain('sleep_agent');
      expect(suffixes('dispatcher-1')).not.toContain('wake_agent');
    });

    it('are not listed for a caller that is not the Dispatcher', () => {
      expect(suffixes('agent-1')).not.toContain('sleep_agent');
      expect(suffixes('agent-1')).not.toContain('wake_agent');
    });

    it('wake_agent tags the message like send_message, with reply instructions', async () => {
      await callTool('dispatcher-1', agentToolName(toTarget, 'wake_agent'), { message: 'ship it' });
      const request = lifecycle.wakeWiredAgent.mock.calls[0][0];
      expect(request).toMatchObject({ callerId: 'dispatcher-1', targetId: 'orch-1', targetName: 'boss' });
      expect(request.mission).toMatch(/^\[TASK:t_\w+\] \[FROM:Dispatcher\] ship it/);
      expect(request.mission).toContain(agentToolName(back, 'send_message'));
      expect(request.missionRouted).toEqual([{ sender: { agentId: 'dispatcher-1', name: 'Dispatcher' }, text: 'ship it' }]);
    });

    it('wake_agent without a message sends no first prompt', async () => {
      await callTool('dispatcher-1', agentToolName(toTarget, 'wake_agent'), {});
      expect(lifecycle.wakeWiredAgent.mock.calls[0][0].mission).toBeUndefined();
    });

    it.each([[{}, false], [{ force: true }, true], [{ force: false }, false]])('sleep_agent %j passes force %s', async (args, force) => {
      await callTool('dispatcher-1', agentToolName(toTarget, 'sleep_agent'), args);
      expect(lifecycle.sleepAgent).toHaveBeenCalledWith({ callerId: 'dispatcher-1', targetId: 'orch-1', targetName: 'boss', force });
    });

    it('sleeping hints point the Dispatcher at wake_agent', async () => {
      const status = JSON.parse((await callTool('dispatcher-1', agentToolName(toTarget, 'get_status'), {})).content[0].text!);
      expect(status.message).toContain('wake_agent');
      expect(status.message).not.toContain('group project');
      const refused = await callTool('dispatcher-1', agentToolName(toTarget, 'send_message'), { message: 'hi' });
      expect(refused.content[0].text).toContain('Call its wake_agent tool');
    });

    it('sleeping hints stay on Clubhouse for other callers', async () => {
      bindingManager.bind('agent-1', { targetId: 'orch-1', targetKind: 'agent', label: 'boss', targetName: 'boss', projectName: 'myapp' });
      const status = JSON.parse((await callTool('agent-1', agentToolName(toTarget, 'get_status'), {})).content[0].text!);
      expect(status.message).toContain('Start it from Clubhouse');
      const refused = await callTool('agent-1', agentToolName(toTarget, 'send_message'), { message: 'hi' });
      expect(refused.content[0].text).toContain('Start it from Clubhouse');
    });
  });

  describe('a client that lists every wire tool (#2603)', () => {
    const wire = makeBinding({
      agentId: 'dispatcher', targetId: 'target', targetKind: 'agent',
      label: 'Boss', agentName: 'Dispatcher', targetName: 'boss', projectName: 'app',
    });
    const call = (suffix: string, args: Record<string, unknown> = {}) => callTool('dispatcher', agentToolName(wire, suffix), args);

    beforeEach(() => {
      setDispatcherAgent('dispatcher', true);
      bindingManager.bind('dispatcher', wire);
      mockAgentRegistryGet.mockImplementation((id: string) => (id === 'dispatcher' ? { orchestrator: 'codex-cli' } : undefined));
      mockGetProvider.mockImplementation((id: string) => ({
        getCapabilities: () => ({ ignoresToolListChanged: id === 'codex-cli' }),
        getPasteSubmitTiming: () => ({ initialDelayMs: 500, retryDelayMs: 300, finalCheckDelayMs: 250, chunkSize: 512, chunkDelayMs: 50, postEndMarkerDelayMs: 150 }),
      }));
      lifecycle.sleepAgent.mockReset();
      lifecycle.wakeWiredAgent.mockReset();
    });

    afterEach(() => _resetDispatcherGateForTesting());

    it('lists them all for a sleeping target', () => {
      const suffixes = getScopedToolList('dispatcher').filter((t) => t.name.startsWith('clubhouse__')).map((t) => t.name.split('__').pop());
      expect(suffixes).toEqual(expect.arrayContaining([
        'send_message', 'get_status', 'read_output', 'check_connectivity', 'send_file', 'clear_agent', 'compact_agent', 'wake_agent', 'sleep_agent',
      ]));
    });

    it.each([
      ['send_message', { message: 'hi' }, 'sending messages'],
      ['read_output', {}, 'reading output'],
      ['check_connectivity', {}, 'checking connectivity'],
      ['send_file', { content: 'x' }, 'sending files'],
      ['clear_agent', {}, 'clearing context'],
      ['compact_agent', {}, 'compacting context'],
    ])('%s on a sleeping target says to call wake_agent', async (suffix, args, action) => {
      const result = await call(suffix, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(`Agent target is sleeping. Call its wake_agent tool before ${action}.`);
      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it('get_status on a sleeping target reports it and points at wake_agent', async () => {
      const status = JSON.parse((await call('get_status')).content[0].text as string);
      expect(status).toMatchObject({ status: 'sleeping', running: false });
      expect(status.message).toContain('wake_agent');
    });

    it('wake_agent and sleep_agent reach the handlers in either state', async () => {
      lifecycle.wakeWiredAgent.mockResolvedValue({ content: [{ type: 'text', text: 'already_running' }] });
      lifecycle.sleepAgent.mockResolvedValue({ content: [{ type: 'text', text: 'already_sleeping' }] });
      expect((await call('wake_agent')).content[0].text).toBe('already_running');
      expect((await call('sleep_agent')).content[0].text).toBe('already_sleeping');
      expect(lifecycle.wakeWiredAgent).toHaveBeenCalledWith(expect.objectContaining({ callerId: 'dispatcher', targetId: 'target' }));
      expect(lifecycle.sleepAgent).toHaveBeenCalledWith(expect.objectContaining({ callerId: 'dispatcher', targetId: 'target', force: false }));
    });

    it('send_message from the first list works after the target wakes, repeatedly', async () => {
      const listed = getScopedToolList('dispatcher').map((t) => t.name);
      const sendTool = agentToolName(wire, 'send_message');
      expect(listed).toContain(sendTool);

      mockAgentRegistryGet.mockImplementation((id: string) =>
        id === 'dispatcher' ? { orchestrator: 'codex-cli' } : { runtime: 'pty', orchestrator: 'claude-code' });

      for (const message of ['message one', 'message two']) {
        const result = await sendMessage('dispatcher', sendTool, { message });
        expect(result.isError).toBeUndefined();
      }
      const written = mockPtyWrite.mock.calls.map(([, data]) => data).join('');
      expect(written).toContain('message one');
      expect(written).toContain('message two');
    });

    describe('call_wire_tool', () => {
      const via = (target: string, tool: string, args?: Record<string, unknown>) =>
        callTool('dispatcher', 'call_wire_tool', { target, tool, ...(args && { arguments: args }) });

      it('reaches a wire added after the session listed its tools', async () => {
        const first = getScopedToolList('dispatcher').map((t) => t.name);
        expect(first).toContain('call_wire_tool');
        const late = makeBinding({ agentId: 'dispatcher', targetId: 'late', targetKind: 'agent', label: 'Late', targetName: 'late', projectName: 'app' });
        bindingManager.bind('dispatcher', late);
        expect(first).not.toContain(agentToolName(late, 'get_status'));

        const status = JSON.parse((await via('late', 'get_status')).content[0].text as string);
        expect(status.status).toBe('sleeping');
        expect((await via('late', 'send_message', { message: 'hi' })).content[0].text).toContain('wake_agent');
      });

      it('validates the inner tool\'s arguments', async () => {
        const result = await via('target', 'send_message');
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('Missing required argument: message');
      });

      it('lists the caller\'s wires when it has none to that target', async () => {
        const result = await via('stranger', 'get_status');
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('You have no wire to stranger. Your wires: boss (target).');
      });

      it('refuses a tool turned off on the wire', async () => {
        bindingManager.setDisabledTools('dispatcher', 'target', ['send_message']);
        const result = await via('target', 'send_message', { message: 'hi' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('send_message is turned off on this wire.');
      });

      it('refuses an unknown tool, and itself', async () => {
        expect((await via('target', 'no_such_tool')).content[0].text).toBe('Unknown tool action: no_such_tool');
        expect((await via('target', 'call_wire_tool')).content[0].text).toBe('Unknown tool action: call_wire_tool');
      });

      it('is not listed for, and refuses, a CLI that refreshes', async () => {
        mockAgentRegistryGet.mockImplementation((id: string) => (id === 'dispatcher' ? { orchestrator: 'claude-code' } : undefined));
        expect(getScopedToolList('dispatcher').map((t) => t.name)).not.toContain('call_wire_tool');
        const result = await via('target', 'get_status');
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('refreshes its tool list');
      });
    });

    it('tells a target on such a CLI how to reply if it lacks the reply tool', async () => {
      const reply = (agent: { runtime: string; orchestrator: string }) => {
        mockPtyWrite.mockClear();
        mockAgentRegistryGet.mockImplementation(() => agent);
        return sendMessage('dispatcher', agentToolName(wire, 'send_message'), { message: 'hi' })
          .then(() => mockPtyWrite.mock.calls.map(([, data]) => data).join(''));
      };
      bindingManager.bind('target', makeBinding({ agentId: 'target', targetId: 'dispatcher', targetKind: 'agent', label: 'D', targetName: 'Dispatcher' }));

      expect(await reply({ runtime: 'pty', orchestrator: 'codex-cli' })).toContain('use call_wire_tool with target="dispatcher" and tool="send_message"');
      expect(await reply({ runtime: 'pty', orchestrator: 'claude-code' })).not.toContain('call_wire_tool');
    });
  });

  describe('Dispatcher sender label (#2548)', () => {
    // The two directions of a Dispatcher <-> orchestrator pair, as
    // dispatcher-wire-source's pairBindings builds them: both carry the
    // orchestrator's project.
    const toOrchestrator = makeBinding({
      agentId: 'dispatcher-1', targetId: 'orch-1', targetKind: 'agent',
      label: 'boss', agentName: 'Dispatcher', targetName: 'boss', projectName: 'myapp',
    });
    const toDispatcher = makeBinding({
      agentId: 'orch-1', targetId: 'dispatcher-1', targetKind: 'agent',
      label: 'Dispatcher', agentName: 'boss', targetName: 'Dispatcher', projectName: 'myapp',
    });

    beforeEach(() => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      for (const b of [toOrchestrator, toDispatcher]) {
        const { agentId, ...rest } = b;
        bindingManager.bind(agentId, rest);
      }
      setDispatcherAgent('dispatcher-1', true);
    });

    afterEach(() => {
      _resetDispatcherGateForTesting();
    });

    it('keeps the orchestrator project in the Dispatcher tool names', () => {
      const names = getScopedToolList('dispatcher-1').map(t => t.name);
      expect(names).toContain(agentToolName(toOrchestrator, 'send_message'));
      expect(agentToolName(toOrchestrator, 'send_message')).toMatch(/^clubhouse__myapp_boss_[a-z0-9]+__send_message$/);
    });

    it('labels a Dispatcher message as just "Dispatcher"', async () => {
      const result = await sendMessage('dispatcher-1', agentToolName(toOrchestrator, 'send_message'), { message: 'hi', task_id: 'd1' });
      expect(result.isError).toBeFalsy();
      // Two-way pairs add reply instructions, so the message goes as a bracketed paste.
      expect(mockPtyWrite.mock.calls[0][0]).toBe('orch-1');
      expect(mockPtyWrite.mock.calls.map(c => c[1]).join('')).not.toContain('Dispatcher@');
      expect(mockPtyWrite.mock.calls.map(c => c[1]).join('')).toContain('[TASK:d1] [FROM:Dispatcher] hi');
    });

    it('labels an orchestrator message to the Dispatcher with its project', async () => {
      const result = await sendMessage('orch-1', agentToolName(toDispatcher, 'send_message'), { message: 'hi', task_id: 'd2' });
      expect(result.isError).toBeFalsy();
      // Two-way pairs add reply instructions, so the message goes as a bracketed paste.
      expect(mockPtyWrite.mock.calls[0][0]).toBe('dispatcher-1');
      expect(mockPtyWrite.mock.calls.map(c => c[1]).join('')).toContain('[TASK:d2] [FROM:boss@myapp] hi');
    });

    it('labels a Dispatcher send_file as just "Dispatcher"', async () => {
      const promise = callTool('dispatcher-1', agentToolName(toOrchestrator, 'send_file'), { content: 'x', task_id: 'd3' });
      await vi.advanceTimersByTimeAsync(600);
      const result = await promise;
      expect(result.isError).toBeFalsy();
      expect(mockPtyWrite.mock.calls[0][1]).toContain('[FROM:Dispatcher] File delivered');
      expect(mockPtyWrite.mock.calls[0][1]).not.toContain('Dispatcher@');
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
      await vi.advanceTimersByTimeAsync(600);
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

    it('returns error for headless runtime', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'headless', orchestrator: 'claude-code' });
      const result = await callTool('agent-1', sendFileToolName, {
        content: 'data',
        task_id: 'sf2',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not support input');
      expect(mockPtyWrite).not.toHaveBeenCalled();
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
      await vi.advanceTimersByTimeAsync(600);
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
      await vi.advanceTimersByTimeAsync(600);
      await promise;

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('sf3-data.json'),
        '{}',
        'utf-8',
      );
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

  describe('waitForBufferQuiescence', () => {
    it('resolves quiet=true after buffer is unchanged for quiescenceMs', async () => {
      mockPtyGetBuffer.mockReturnValue('stable-12345');

      const promise = waitForBufferQuiescence('agent-x', {
        quiescenceMs: 100,
        maxWaitMs: 500,
        pollMs: 25,
      });

      await vi.advanceTimersByTimeAsync(150);
      const result = await promise;

      expect(result.quiet).toBe(true);
      expect(result.waitedMs).toBeLessThan(200);
    });

    it('resolves quiet=false when buffer keeps changing past maxWaitMs', async () => {
      let len = 0;
      mockPtyGetBuffer.mockImplementation(() => 'x'.repeat(++len));

      const promise = waitForBufferQuiescence('agent-x', {
        quiescenceMs: 100,
        maxWaitMs: 200,
        pollMs: 25,
      });

      await vi.advanceTimersByTimeAsync(250);
      const result = await promise;

      expect(result.quiet).toBe(false);
      expect(result.waitedMs).toBeGreaterThanOrEqual(200);
    });

    it('resolves quiet=true after buffer settles following an initial growth burst', async () => {
      let calls = 0;
      mockPtyGetBuffer.mockImplementation(() => {
        calls++;
        // Initial read + first 3 polls show growth, then stable
        const len = calls < 5 ? calls * 10 : 50;
        return 'x'.repeat(len);
      });

      const promise = waitForBufferQuiescence('agent-x', {
        quiescenceMs: 100,
        maxWaitMs: 1000,
        pollMs: 25,
      });

      await vi.advanceTimersByTimeAsync(300);
      const result = await promise;

      expect(result.quiet).toBe(true);
    });
  });

  describe('clear_agent (A2A)', () => {
    let binding: McpBinding;

    beforeEach(() => {
      binding = makeBinding({ agentId: 'caller-1', targetId: 'target-agent', targetKind: 'agent', targetName: 'target', projectName: 'proj' });
      bindingManager.bind(binding.agentId, {
        targetId: binding.targetId,
        targetKind: binding.targetKind,
        label: binding.label,
        targetName: binding.targetName,
        projectName: binding.projectName,
      });
    });

    it('injects /clear into running agent PTY', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code', projectPath: '/test' });
      const toolName = agentToolName(binding, 'clear_agent');
      const result = await callTool('caller-1', toolName, {});

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('/clear');
      expect(mockPtyWrite).toHaveBeenCalledWith('target-agent', '/clear');
    });

    it('returns error when target is sleeping', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);
      const toolName = agentToolName(binding, 'clear_agent');
      const result = await callTool('caller-1', toolName, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sleeping');
    });

    it('returns error for non-pty runtime', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'headless', orchestrator: 'claude-code' });
      const toolName = agentToolName(binding, 'clear_agent');
      const result = await callTool('caller-1', toolName, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not support /clear');
    });
  });

  describe('compact_agent (A2A)', () => {
    let binding: McpBinding;

    beforeEach(() => {
      binding = makeBinding({ agentId: 'caller-1', targetId: 'target-agent', targetKind: 'agent', targetName: 'target', projectName: 'proj' });
      bindingManager.bind(binding.agentId, {
        targetId: binding.targetId,
        targetKind: binding.targetKind,
        label: binding.label,
        targetName: binding.targetName,
        projectName: binding.projectName,
      });
    });

    it('injects /compact into running agent PTY', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code', projectPath: '/test' });
      const toolName = agentToolName(binding, 'compact_agent');
      const result = await callTool('caller-1', toolName, {});

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('/compact');
      expect(mockPtyWrite).toHaveBeenCalledWith('target-agent', '/compact');
    });

    it('returns error when target is sleeping', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);
      const toolName = agentToolName(binding, 'compact_agent');
      const result = await callTool('caller-1', toolName, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sleeping');
    });

    it('returns error for non-pty runtime', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'headless', orchestrator: 'claude-code' });
      const toolName = agentToolName(binding, 'compact_agent');
      const result = await callTool('caller-1', toolName, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not support /compact');
    });
  });
});
