import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { registerAgentTools } from './agent-tools';
import { getScopedToolList, callTool, _resetForTesting as resetTools } from '../tool-registry';
import { bindingManager } from '../binding-manager';

describe('AgentTools', () => {
  beforeEach(() => {
    resetTools();
    bindingManager._resetForTesting();
    mockAgentRegistryGet.mockReset();
    mockPtyWrite.mockReset();
    mockPtyGetBuffer.mockReset();
    mockStructuredSendMessage.mockReset();

    registerAgentTools();
    bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' });
  });

  describe('tool registration', () => {
    it('registers send_message, get_status, read_output, and check_connectivity tools', () => {
      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(4);
      const names = tools.map(t => t.name);
      expect(names).toContain('agent__agent_2__send_message');
      expect(names).toContain('agent__agent_2__get_status');
      expect(names).toContain('agent__agent_2__read_output');
      expect(names).toContain('agent__agent_2__check_connectivity');
    });
  });

  describe('send_message', () => {
    it('sends tagged message to PTY agent with \\r', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      const result = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'hello', task_id: 'test123' });
      expect(result.isError).toBeFalsy();
      expect(mockPtyWrite).toHaveBeenCalledWith('agent-2', '[TASK:test123] hello\r');
      expect(result.content[0].text).toContain('task_id=test123');
    });

    it('auto-generates task_id when not provided', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      const result = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'hello' });
      expect(result.isError).toBeFalsy();
      // Should have auto-generated a task_id starting with t_
      expect(result.content[0].text).toMatch(/task_id=t_/);
      // PTY write should contain the tagged message with \r
      const writeCall = mockPtyWrite.mock.calls[0];
      expect(writeCall[1]).toMatch(/^\[TASK:t_[a-z0-9]+\] hello\r$/);
    });

    it('sends tagged message to structured agent', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'structured' });
      const result = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'hello', task_id: 'abc' });
      expect(result.isError).toBeFalsy();
      expect(mockStructuredSendMessage).toHaveBeenCalledWith('agent-2', '[TASK:abc] hello');
      expect(result.content[0].text).toContain('task_id=abc');
    });

    it('returns error when agent not running', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);
      const result = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'hello' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not running');
    });

    it('returns error for headless runtime', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'headless' });
      const result = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'hello' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not support input');
    });

    it('returns error when message is missing', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      const result = await callTool('agent-1', 'agent__agent_2__send_message', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('get_status', () => {
    it('returns running status for active agent', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      const result = await callTool('agent-1', 'agent__agent_2__get_status', {});
      expect(result.isError).toBeFalsy();
      const status = JSON.parse(result.content[0].text!);
      expect(status.running).toBe(true);
      expect(status.runtime).toBe('pty');
    });

    it('returns not running for inactive agent', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);
      const result = await callTool('agent-1', 'agent__agent_2__get_status', {});
      const status = JSON.parse(result.content[0].text!);
      expect(status.running).toBe(false);
    });
  });

  describe('read_output', () => {
    it('reads last N lines from PTY buffer', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      mockPtyGetBuffer.mockReturnValue('line1\nline2\nline3\nline4\nline5');

      const result = await callTool('agent-1', 'agent__agent_2__read_output', { lines: 3 });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('line3\nline4\nline5');
    });

    it('defaults to 50 lines', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
      mockPtyGetBuffer.mockReturnValue(lines);

      const result = await callTool('agent-1', 'agent__agent_2__read_output', {});
      const outputLines = result.content[0].text!.split('\n');
      expect(outputLines).toHaveLength(50);
    });

    it('caps at 500 lines', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      const lines = Array.from({ length: 1000 }, (_, i) => `line${i}`).join('\n');
      mockPtyGetBuffer.mockReturnValue(lines);

      const result = await callTool('agent-1', 'agent__agent_2__read_output', { lines: 999 });
      const outputLines = result.content[0].text!.split('\n');
      expect(outputLines).toHaveLength(500);
    });

    it('returns error for non-PTY agents', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'structured' });
      const result = await callTool('agent-1', 'agent__agent_2__read_output', {});
      expect(result.isError).toBe(true);
    });

    it('returns error when agent not running', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);
      const result = await callTool('agent-1', 'agent__agent_2__read_output', {});
      expect(result.isError).toBe(true);
    });

    it('handles empty buffer', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      mockPtyGetBuffer.mockReturnValue(null);

      const result = await callTool('agent-1', 'agent__agent_2__read_output', {});
      expect(result.content[0].text).toBe('No output available');
    });

    it('handles single-line buffer', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      mockPtyGetBuffer.mockReturnValue('only one line');

      const result = await callTool('agent-1', 'agent__agent_2__read_output', { lines: 5 });
      expect(result.content[0].text).toBe('only one line');
    });

    it('handles empty string buffer', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      mockPtyGetBuffer.mockReturnValue('');

      const result = await callTool('agent-1', 'agent__agent_2__read_output', {});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('send_message error handling', () => {
    it('handles PTY write failure', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      mockPtyWrite.mockImplementation(() => { throw new Error('PTY write failed'); });

      const result = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'hello' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('PTY write failed');
    });

    it('handles structured manager failure', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'structured' });
      mockStructuredSendMessage.mockRejectedValue(new Error('Structured send failed'));

      const result = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'hello' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Structured send failed');
    });
  });

  describe('multi-agent bindings', () => {
    it('agent can send messages to multiple bound agents', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      bindingManager.bind('agent-1', { targetId: 'agent-3', targetKind: 'agent', label: 'Agent 3' });

      const tools = getScopedToolList('agent-1');
      // 4 tools for agent-2 + 4 tools for agent-3 = 8
      expect(tools).toHaveLength(8);

      const r1 = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'to-2', task_id: 'x1' });
      const r2 = await callTool('agent-1', 'agent__agent_3__send_message', { message: 'to-3', task_id: 'x2' });
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      expect(mockPtyWrite).toHaveBeenCalledWith('agent-2', '[TASK:x1] to-2\r');
      expect(mockPtyWrite).toHaveBeenCalledWith('agent-3', '[TASK:x2] to-3\r');
    });
  });

  describe('check_connectivity', () => {
    it('returns unidirectional when no reverse binding exists', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      const result = await callTool('agent-1', 'agent__agent_2__check_connectivity', {});
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text!);
      expect(data.direction).toBe('unidirectional');
      expect(data.guidance).toContain('CANNOT send messages back');
    });

    it('returns bidirectional when reverse binding exists', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      // Create the reverse binding: agent-2 → agent-1
      bindingManager.bind('agent-2', { targetId: 'agent-1', targetKind: 'agent', label: 'Agent 1' });

      const result = await callTool('agent-1', 'agent__agent_2__check_connectivity', {});
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text!);
      expect(data.direction).toBe('bidirectional');
      expect(data.guidance).toContain('send messages back to you directly');
    });

    it('returns error when target agent not running', async () => {
      mockAgentRegistryGet.mockReturnValue(undefined);
      const result = await callTool('agent-1', 'agent__agent_2__check_connectivity', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not running');
    });
  });
});
