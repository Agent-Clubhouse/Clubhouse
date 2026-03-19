import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerToolTemplate, getScopedToolList, callTool, buildToolName, parseToolName, _resetForTesting } from './tool-registry';
import { bindingManager } from './binding-manager';

describe('ToolRegistry', () => {
  beforeEach(() => {
    _resetForTesting();
    bindingManager._resetForTesting();
  });

  describe('buildToolName', () => {
    it('builds correct tool name', () => {
      expect(buildToolName('agent', 'my-agent-1', 'send_message')).toBe('agent__my_agent_1__send_message');
    });

    it('sanitizes special characters in target ID', () => {
      expect(buildToolName('browser', 'widget.123/test', 'navigate')).toBe('browser__widget_123_test__navigate');
    });
  });

  describe('parseToolName', () => {
    it('parses valid tool names', () => {
      expect(parseToolName('agent__my_agent_1__send_message')).toEqual({
        targetKind: 'agent',
        targetId: 'my_agent_1',
        suffix: 'send_message',
      });
    });

    it('parses browser tool names', () => {
      expect(parseToolName('browser__widget_1__navigate')).toEqual({
        targetKind: 'browser',
        targetId: 'widget_1',
        suffix: 'navigate',
      });
    });

    it('returns null for invalid names', () => {
      expect(parseToolName('invalid')).toBeNull();
      expect(parseToolName('unknown__id__action')).toBeNull();
      expect(parseToolName('')).toBeNull();
    });

    it('rejects tool names with special characters in target ID', () => {
      // After fix: targetId must match [a-zA-Z0-9_]+ only
      expect(parseToolName('agent__my.agent.1__send_message')).toBeNull();
      expect(parseToolName('browser__widget/1__navigate')).toBeNull();
      expect(parseToolName('agent__id-with-dashes__send_message')).toBeNull();
      expect(parseToolName('agent__id with spaces__send_message')).toBeNull();
    });

    it('parses terminal tool names', () => {
      expect(parseToolName('terminal__term_1__run_command')).toEqual({
        targetKind: 'terminal',
        targetId: 'term_1',
        suffix: 'run_command',
      });
    });
  });

  describe('registerToolTemplate + getScopedToolList', () => {
    it('returns empty list when no bindings', () => {
      registerToolTemplate('agent', 'test', { description: 'Test', inputSchema: { type: 'object' } }, vi.fn());
      expect(getScopedToolList('agent-1')).toHaveLength(0);
    });

    it('returns tools for bound targets', () => {
      registerToolTemplate('agent', 'send_message', {
        description: 'Send message',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      }, vi.fn());

      registerToolTemplate('agent', 'get_status', {
        description: 'Get status',
        inputSchema: { type: 'object' },
      }, vi.fn());

      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' });

      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('agent__agent_2__send_message');
      expect(tools[1].name).toBe('agent__agent_2__get_status');
    });

    it('scopes tools to correct target kind', () => {
      registerToolTemplate('agent', 'send_message', { description: 'Send', inputSchema: { type: 'object' } }, vi.fn());
      registerToolTemplate('browser', 'navigate', { description: 'Nav', inputSchema: { type: 'object' } }, vi.fn());

      // Bind to agent only
      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' });

      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toContain('send_message');
    });

    it('generates tools for multiple bindings', () => {
      registerToolTemplate('agent', 'send_message', { description: 'Send', inputSchema: { type: 'object' } }, vi.fn());

      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' });
      bindingManager.bind('agent-1', { targetId: 'agent-3', targetKind: 'agent', label: 'Agent 3' });

      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(2);
    });
  });

  describe('callTool', () => {
    it('calls the correct handler', async () => {
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      registerToolTemplate('agent', 'send_message', {
        description: 'Send',
        inputSchema: { type: 'object' },
      }, handler);

      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' });

      const result = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'hello' });
      expect(result.isError).toBeFalsy();
      expect(handler).toHaveBeenCalledWith('agent-2', 'agent-1', { message: 'hello' });
    });

    it('returns error for unknown tool', async () => {
      const result = await callTool('agent-1', 'unknown_tool', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });

    it('returns error when agent has no binding for target', async () => {
      registerToolTemplate('agent', 'send_message', {
        description: 'Send',
        inputSchema: { type: 'object' },
      }, vi.fn());

      // No binding for agent-1 → agent-2
      const result = await callTool('agent-1', 'agent__agent_2__send_message', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No binding');
    });

    it('returns error for unknown action suffix', async () => {
      registerToolTemplate('agent', 'send_message', {
        description: 'Send',
        inputSchema: { type: 'object' },
      }, vi.fn());

      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' });

      const result = await callTool('agent-1', 'agent__agent_2__nonexistent', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool action');
    });

    it('passes original targetId (not sanitized) to handler', async () => {
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      registerToolTemplate('agent', 'send_message', {
        description: 'Send',
        inputSchema: { type: 'object' },
      }, handler);

      // Bind with a targetId that gets sanitized (dot → underscore)
      bindingManager.bind('agent-1', { targetId: 'agent.2', targetKind: 'agent', label: 'Agent 2' });

      // Tool name uses sanitized version
      const result = await callTool('agent-1', 'agent__agent_2__send_message', { message: 'hi' });
      expect(result.isError).toBeFalsy();
      // Handler receives the ORIGINAL targetId (with dot), not the sanitized one
      expect(handler).toHaveBeenCalledWith('agent.2', 'agent-1', { message: 'hi' });
    });

    it('isolates tools across different agents', async () => {
      registerToolTemplate('agent', 'send_message', {
        description: 'Send',
        inputSchema: { type: 'object' },
      }, vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }));

      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'A2' });
      // agent-3 is NOT bound to agent-2

      const result = await callTool('agent-3', 'agent__agent_2__send_message', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No binding');
    });
  });
});
