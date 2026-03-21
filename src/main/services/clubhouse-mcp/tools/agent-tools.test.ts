import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: { getAllWindows: () => [] },
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

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

const mockGetProvider = vi.fn();
vi.mock('../../../orchestrators', () => ({
  getProvider: (id: string) => mockGetProvider(id),
}));

import { registerAgentTools } from './agent-tools';
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
 * Helper: call send_message and advance fake timers so the delayed \r
 * retries and buffer checks all resolve. Must be called within a
 * fake-timer context (vi.useFakeTimers).
 *
 * Timeline: 200ms (1st \r) + 200ms (retry check / 2nd \r) + 200ms (final buffer check) = 600ms
 */
async function sendMessage(agentId: string, toolName: string, args: Record<string, unknown>) {
  const promise = callTool(agentId, toolName, args);
  // Advance through all three setTimeout stages
  await vi.advanceTimersByTimeAsync(600);
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

    // Default buffer mock for post-send heuristic
    mockPtyGetBuffer.mockReturnValue('');

    // Default provider mock — returns Claude Code timing (200/200/200)
    mockGetProvider.mockReturnValue({
      getPasteSubmitTiming: () => ({ initialDelayMs: 200, retryDelayMs: 200, finalCheckDelayMs: 200 }),
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
    it('registers send_message, get_status, read_output, and check_connectivity tools', () => {
      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(4);
      const suffixes = tools.map(t => t.name.split('__').pop());
      expect(suffixes).toContain('send_message');
      expect(suffixes).toContain('get_status');
      expect(suffixes).toContain('read_output');
      expect(suffixes).toContain('check_connectivity');
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

    it('wraps multi-line message in bracketed paste sequences', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      const result = await sendMessage('agent-1', sendToolName, {
        message: 'line one\nline two\nline three',
        task_id: 'ml1',
      });
      expect(result.isError).toBeFalsy();

      // First write: bracketed paste wrapping
      const firstWrite = mockPtyWrite.mock.calls[0][1] as string;
      expect(firstWrite.startsWith('\x1b[200~')).toBe(true);
      expect(firstWrite.endsWith('\x1b[201~')).toBe(true);
      expect(firstWrite).toContain('[TASK:ml1]');
      expect(firstWrite).toContain('line one\nline two\nline three');

      // Second write: delayed \r submit
      expect(mockPtyWrite.mock.calls[1][1]).toBe('\r');
    });

    it('uses bracketed paste for bidirectional messages (reply instructions contain newlines)', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      // Create reverse binding: agent-2 → agent-1
      bindingManager.bind('agent-2', {
        targetId: 'agent-1', targetKind: 'agent', label: 'Agent 1',
        agentName: 'scrappy-robin', targetName: 'mega-camel', projectName: 'myapp',
      });

      const result = await sendMessage('agent-1', sendToolName, { message: 'do something', task_id: 'bidir1' });
      expect(result.isError).toBeFalsy();

      const firstWrite = mockPtyWrite.mock.calls[0][1] as string;
      // Bidirectional appends \n\n---\n... so it should use bracketed paste
      expect(firstWrite.startsWith('\x1b[200~')).toBe(true);
      expect(firstWrite.endsWith('\x1b[201~')).toBe(true);
      expect(firstWrite).toContain('Reply to mega-camel via tool');
      expect(firstWrite).toContain('clubhouse__');
      expect(firstWrite).toContain('task_id="bidir1"');

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

      // Only 1 write: bracketed paste, no \r
      expect(mockPtyWrite).toHaveBeenCalledTimes(1);
      const written = mockPtyWrite.mock.calls[0][1] as string;
      expect(written.startsWith('\x1b[200~')).toBe(true);
      expect(written.endsWith('\x1b[201~')).toBe(true);
    });

    it('uses provider-specific paste timing for copilot-cli agents', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'copilot-cli' });
      mockGetProvider.mockReturnValue({
        getPasteSubmitTiming: () => ({ initialDelayMs: 500, retryDelayMs: 500, finalCheckDelayMs: 300 }),
      });

      // Buffer stays empty → retry path
      mockPtyGetBuffer.mockReturnValue('');
      const promise = callTool('agent-1', sendToolName, { message: 'hello', task_id: 'cop1' });

      // After 400ms only the message write should have happened (no Enter yet)
      await vi.advanceTimersByTimeAsync(400);
      expect(mockPtyWrite).toHaveBeenCalledTimes(1);

      // At 500ms the first Enter fires
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPtyWrite).toHaveBeenCalledTimes(2);
      expect(mockPtyWrite.mock.calls[1][1]).toBe('\r');

      // At 900ms (not yet 1000ms) no second Enter yet
      await vi.advanceTimersByTimeAsync(400);
      expect(mockPtyWrite).toHaveBeenCalledTimes(2);

      // At 1000ms the second Enter fires
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPtyWrite).toHaveBeenCalledTimes(3);
      expect(mockPtyWrite.mock.calls[2][1]).toBe('\r');

      // Drain the final check delay
      await vi.advanceTimersByTimeAsync(300);
      await promise;
    });

    it('falls back to default timing when provider not found', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'unknown-cli' });
      mockGetProvider.mockReturnValue(undefined);

      mockPtyGetBuffer.mockReturnValue('');
      const promise = callTool('agent-1', sendToolName, { message: 'hello', task_id: 'fb1' });

      // Falls back to 200/200/200 — total 600ms
      await vi.advanceTimersByTimeAsync(600);
      await promise;

      // message + 2x \r (retry because buffer didn't grow)
      expect(mockPtyWrite).toHaveBeenCalledTimes(3);
    });

    it('performs post-send buffer checks for delivery heuristic', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty', orchestrator: 'claude-code' });
      // Simulate buffer NOT growing after first \r, then growing after second
      let callCount = 0;
      mockPtyGetBuffer.mockImplementation(() => {
        callCount++;
        // Calls 1-2 (before + after first \r): same length → triggers retry
        // Call 3 (after second \r): longer
        return callCount <= 2 ? 'short' : 'short + agent processed message output';
      });

      const result = await sendMessage('agent-1', sendToolName, { message: 'hello', task_id: 'buf1' });
      expect(result.isError).toBeFalsy();
      // getBuffer: once before submit, once after 1st \r, once after 2nd \r
      expect(mockPtyGetBuffer).toHaveBeenCalledTimes(3);
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
      expect(result.content[0].text).toContain('not running');
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
      // 4 tools for agent-2 + 4 tools for agent-3 = 8
      expect(tools).toHaveLength(8);

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
      expect(result.content[0].text).toContain('not running');
    });
  });
});
