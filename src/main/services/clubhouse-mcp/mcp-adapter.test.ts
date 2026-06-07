import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/test-clubhouse' },
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../log-service', () => ({
  appLog: vi.fn(),
}));

const mockAgentRegistryGet = vi.fn();
vi.mock('../agent-registry', () => ({
  agentRegistry: {
    get: (id: string) => mockAgentRegistryGet(id),
    untrack: vi.fn(),
  },
}));

vi.mock('../group-project-registry', () => ({
  groupProjectRegistry: {
    getAll: vi.fn().mockReturnValue([]),
    getSync: vi.fn().mockReturnValue(undefined),
    onChange: vi.fn().mockReturnValue(() => {}),
    _resetForTesting: vi.fn(),
  },
}));

import { mcpAdapter } from './mcp-adapter';
import { commandRegistry } from '../../../shared/command-registry';
import { _resetForTesting as resetTools, getScopedToolList, callTool } from './tool-registry';
import { bindingManager } from './binding-manager';
import type { McpToolResult } from './types';

describe('McpCommandAdapter', () => {
  beforeEach(() => {
    resetTools();
    mcpAdapter._resetForTesting();
    commandRegistry.clear();
    bindingManager._resetForTesting();
    mockAgentRegistryGet.mockReset();
  });

  describe('registerMcpCommand', () => {
    it('registers in both CommandRegistry and tool templates', () => {
      const handler = vi.fn<[string, string, Record<string, unknown>], Promise<McpToolResult>>()
        .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      mcpAdapter.registerMcpCommand({
        id: 'test.doThing',
        category: 'test',
        label: 'Do Thing',
        description: 'Test tool',
        mcp: { targetKind: 'agent', nameSuffix: 'do_thing' },
        handler,
      });

      // Verify CommandRegistry has it
      const cmd = commandRegistry.get('test.doThing');
      expect(cmd).toBeDefined();
      expect(cmd!.label).toBe('Do Thing');
      expect(cmd!.category).toBe('test');

      // Verify tool template is registered (shows up in scoped list when bound)
      mockAgentRegistryGet.mockImplementation((id: string) =>
        id === 'agent-2' ? { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' } : undefined,
      );
      bindingManager.bind('agent-1', {
        targetId: 'agent-2',
        targetKind: 'agent',
        label: 'Agent 2',
        targetName: 'test_agent',
        projectName: 'myproject',
      });

      const tools = getScopedToolList('agent-1');
      const toolNames = tools.map((t) => t.name);
      expect(toolNames.some((n) => n.includes('do_thing'))).toBe(true);
    });

    it('returns a disposable that removes from CommandRegistry', () => {
      const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      const disposable = mcpAdapter.registerMcpCommand({
        id: 'test.disposable',
        category: 'test',
        label: 'Disposable',
        description: 'Test',
        mcp: { targetKind: 'agent', nameSuffix: 'disposable_tool' },
        handler,
      });

      expect(commandRegistry.get('test.disposable')).toBeDefined();
      disposable.dispose();
      expect(commandRegistry.get('test.disposable')).toBeUndefined();
    });

    it('defaults palette to hidden', () => {
      const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      mcpAdapter.registerMcpCommand({
        id: 'test.hidden',
        category: 'test',
        label: 'Hidden',
        description: 'Test',
        mcp: { targetKind: 'agent', nameSuffix: 'hidden_tool' },
        handler,
      });

      const cmd = commandRegistry.get('test.hidden');
      expect(cmd!.palette?.hidden).toBe(true);
    });

    it('respects custom palette settings', () => {
      const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      mcpAdapter.registerMcpCommand({
        id: 'test.visible',
        category: 'test',
        label: 'Visible',
        description: 'Test',
        palette: { keywords: ['test'], hidden: false },
        mcp: { targetKind: 'agent', nameSuffix: 'visible_tool' },
        handler,
      });

      const cmd = commandRegistry.get('test.visible');
      expect(cmd!.palette?.hidden).toBe(false);
      expect(cmd!.palette?.keywords).toContain('test');
    });
  });

  describe('tool dispatch through binding system', () => {
    it('calls handler with correct targetId and agentId', async () => {
      const handler = vi.fn<[string, string, Record<string, unknown>], Promise<McpToolResult>>()
        .mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });

      mcpAdapter.registerMcpCommand({
        id: 'agent.testCall',
        category: 'agent',
        label: 'Test Call',
        description: 'Test',
        mcp: { targetKind: 'agent', nameSuffix: 'test_call' },
        handler,
      });

      mockAgentRegistryGet.mockImplementation((id: string) =>
        id === 'agent-2' ? { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' } : undefined,
      );
      bindingManager.bind('agent-1', {
        targetId: 'agent-2',
        targetKind: 'agent',
        label: 'Agent 2',
        targetName: 'test_agent',
        projectName: 'myproject',
      });

      const tools = getScopedToolList('agent-1');
      const testTool = tools.find((t) => t.name.includes('test_call'));
      expect(testTool).toBeDefined();

      const result = await callTool('agent-1', testTool!.name, { foo: 'bar' });
      expect(handler).toHaveBeenCalledWith('agent-2', 'agent-1', { foo: 'bar' });
      expect(result.content[0].text).toBe('done');
    });

    it('respects sleeping agent filtering — only get_status visible', () => {
      const statusHandler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'status' }] });
      const wakeHandler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'waking' }] });
      const sendHandler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'sent' }] });

      mcpAdapter.registerMcpCommand({
        id: 'agent.getStatus2',
        category: 'agent',
        label: 'Status',
        description: 'Get status',
        mcp: { targetKind: 'agent', nameSuffix: 'get_status' },
        handler: statusHandler,
      });

      mcpAdapter.registerMcpCommand({
        id: 'agent.wake2',
        category: 'agent',
        label: 'Wake',
        description: 'Wake agent',
        mcp: { targetKind: 'agent', nameSuffix: 'wake' },
        handler: wakeHandler,
      });

      mcpAdapter.registerMcpCommand({
        id: 'agent.send2',
        category: 'agent',
        label: 'Send',
        description: 'Send message',
        mcp: { targetKind: 'agent', nameSuffix: 'send_message' },
        handler: sendHandler,
      });

      // agent-2 is NOT in registry (sleeping)
      bindingManager.bind('agent-1', {
        targetId: 'agent-2',
        targetKind: 'agent',
        label: 'Agent 2',
        targetName: 'test_agent',
        projectName: 'myproject',
      });

      const tools = getScopedToolList('agent-1');
      const suffixes = tools.map((t) => {
        const parts = t.name.split('__');
        return parts[parts.length - 1];
      });

      expect(suffixes).toContain('get_status');
      expect(suffixes).not.toContain('wake');
      expect(suffixes).not.toContain('send_message');
    });

    it('respects disabledTools on binding', () => {
      const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      mcpAdapter.registerMcpCommand({
        id: 'agent.toolA',
        category: 'agent',
        label: 'Tool A',
        description: 'A',
        mcp: { targetKind: 'agent', nameSuffix: 'tool_a' },
        handler,
      });

      mcpAdapter.registerMcpCommand({
        id: 'agent.toolB',
        category: 'agent',
        label: 'Tool B',
        description: 'B',
        mcp: { targetKind: 'agent', nameSuffix: 'tool_b' },
        handler,
      });

      mockAgentRegistryGet.mockImplementation((id: string) =>
        id === 'agent-2' ? { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' } : undefined,
      );
      bindingManager.bind('agent-1', {
        targetId: 'agent-2',
        targetKind: 'agent',
        label: 'Agent 2',
        targetName: 'test_agent',
        projectName: 'myproject',
      });
      bindingManager.setDisabledTools('agent-1', 'agent-2', ['tool_a']);

      const tools = getScopedToolList('agent-1');
      const suffixes = tools.map((t) => {
        const parts = t.name.split('__');
        return parts[parts.length - 1];
      });

      expect(suffixes).not.toContain('tool_a');
      expect(suffixes).toContain('tool_b');
    });
  });

  describe('_resetForTesting', () => {
    it('clears all registered commands', () => {
      const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      mcpAdapter.registerMcpCommand({
        id: 'test.reset1',
        category: 'test',
        label: 'Reset 1',
        description: 'Test',
        mcp: { targetKind: 'agent', nameSuffix: 'reset1' },
        handler,
      });

      expect(commandRegistry.get('test.reset1')).toBeDefined();

      mcpAdapter._resetForTesting();

      expect(commandRegistry.get('test.reset1')).toBeUndefined();
    });
  });
});
