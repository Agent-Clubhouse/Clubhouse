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
    it('registers send_message, get_status, and read_output tools', () => {
      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(3);
      const names = tools.map(t => t.name);
      expect(names).toContain('agent__agent_2__send_message');
      expect(names).toContain('agent__agent_2__get_status');
      expect(names).toContain('agent__agent_2__read_output');
    });
  });

  describe('send_message', () => {
    it('sends message to PTY agent', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'pty' });
      const result = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'hello' });
      expect(result.isError).toBeFalsy();
      expect(mockPtyWrite).toHaveBeenCalledWith('agent-2', 'hello\n');
    });

    it('sends message to structured agent', async () => {
      mockAgentRegistryGet.mockReturnValue({ runtime: 'structured' });
      const result = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'hello' });
      expect(result.isError).toBeFalsy();
      expect(mockStructuredSendMessage).toHaveBeenCalledWith('agent-2', 'hello');
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
      // 3 tools for agent-2 + 3 tools for agent-3 = 6
      expect(tools).toHaveLength(6);

      const r1 = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'to-2' });
      const r2 = await callTool('agent-1', 'agent__agent_3__send_message', { message: 'to-3' });
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      expect(mockPtyWrite).toHaveBeenCalledWith('agent-2', 'to-2\n');
      expect(mockPtyWrite).toHaveBeenCalledWith('agent-3', 'to-3\n');
    });
  });
});
