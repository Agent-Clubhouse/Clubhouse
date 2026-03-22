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

import { registerToolTemplate, getScopedToolList, callTool, buildToolName, buildToolKey, parseToolName, shortHash, _resetForTesting } from './tool-registry';
import { bindingManager } from './binding-manager';
import { agentRegistry } from '../agent-registry';
import { groupProjectRegistry } from '../group-project-registry';
import type { McpBinding } from './types';

function makeBinding(overrides: Partial<McpBinding> & { agentId: string; targetId: string; targetKind: McpBinding['targetKind'] }): McpBinding {
  return { label: 'Test', ...overrides };
}

describe('ToolRegistry', () => {
  beforeEach(() => {
    _resetForTesting();
    bindingManager._resetForTesting();
    groupProjectRegistry._resetForTesting();
    // Clean up any registrations from previous tests
    agentRegistry.untrack('agent-2');
    agentRegistry.untrack('agent-3');
    agentRegistry.untrack('agent.2');
  });

  describe('shortHash', () => {
    it('returns a 4-character string', () => {
      const h = shortHash('durable_1771825997699_05on03');
      expect(h).toHaveLength(4);
      expect(h).toMatch(/^[a-z0-9]+$/);
    });

    it('is deterministic', () => {
      expect(shortHash('abc')).toBe(shortHash('abc'));
    });

    it('differs for different inputs', () => {
      expect(shortHash('agent-1')).not.toBe(shortHash('agent-2'));
    });
  });

  describe('buildToolKey', () => {
    it('builds key with project, name, and hash for agent targets', () => {
      const binding = makeBinding({
        agentId: 'a1', targetId: 'agent-2', targetKind: 'agent',
        targetName: 'scrappy-robin', projectName: 'myapp',
      });
      const key = buildToolKey(binding);
      expect(key).toBe(`myapp_scrappy_robin_${shortHash('agent-2')}`);
    });

    it('falls back to label when targetName not set', () => {
      const binding = makeBinding({
        agentId: 'a1', targetId: 'agent-2', targetKind: 'agent',
        label: 'Agent 2',
      });
      const key = buildToolKey(binding);
      expect(key).toBe(`project_Agent_2_${shortHash('agent-2')}`);
    });

    it('falls back to targetId when no name or label', () => {
      const binding = makeBinding({
        agentId: 'a1', targetId: 'agent-2', targetKind: 'agent',
        label: '',
      });
      const key = buildToolKey(binding);
      expect(key).toBe(`project_agent_2_${shortHash('agent-2')}`);
    });

    it('uses sanitized targetId for non-agent targets', () => {
      const binding = makeBinding({
        agentId: 'a1', targetId: 'widget.123', targetKind: 'browser',
      });
      expect(buildToolKey(binding)).toBe('widget_123');
    });

    it('builds key with name and hash for group-project targets', () => {
      const binding = makeBinding({
        agentId: 'a1', targetId: 'gp_123_abc', targetKind: 'group-project',
        targetName: 'My Project',
      });
      const key = buildToolKey(binding);
      expect(key).toBe(`My_Project_${shortHash('gp_123_abc')}`);
    });
  });

  describe('buildToolName', () => {
    it('builds clubhouse-prefixed name for agent targets', () => {
      const binding = makeBinding({
        agentId: 'a1', targetId: 'agent-2', targetKind: 'agent',
        targetName: 'scrappy-robin', projectName: 'myapp',
      });
      const name = buildToolName(binding, 'send_message');
      expect(name).toBe(`clubhouse__myapp_scrappy_robin_${shortHash('agent-2')}__send_message`);
    });

    it('uses targetKind prefix for non-agent targets', () => {
      const binding = makeBinding({
        agentId: 'a1', targetId: 'widget-1', targetKind: 'browser',
      });
      const name = buildToolName(binding, 'navigate');
      expect(name).toBe('browser__widget_1__navigate');
    });

    it('uses group prefix for group-project targets', () => {
      const binding = makeBinding({
        agentId: 'a1', targetId: 'gp_123', targetKind: 'group-project',
        targetName: 'My Project',
      });
      const name = buildToolName(binding, 'list_members');
      expect(name).toMatch(/^group__My_Project_[a-z0-9]+__list_members$/);
    });
  });

  describe('parseToolName', () => {
    it('parses clubhouse-prefixed tool names', () => {
      expect(parseToolName('clubhouse__myapp_scrappy_robin_a3f2__send_message')).toEqual({
        prefix: 'clubhouse',
        toolKey: 'myapp_scrappy_robin_a3f2',
        suffix: 'send_message',
      });
    });

    it('parses browser tool names', () => {
      expect(parseToolName('browser__widget_1__navigate')).toEqual({
        prefix: 'browser',
        toolKey: 'widget_1',
        suffix: 'navigate',
      });
    });

    it('parses terminal tool names', () => {
      expect(parseToolName('terminal__term_1__run_command')).toEqual({
        prefix: 'terminal',
        toolKey: 'term_1',
        suffix: 'run_command',
      });
    });

    it('parses group tool names', () => {
      expect(parseToolName('group__My_Project_a3f2__list_members')).toEqual({
        prefix: 'group',
        toolKey: 'My_Project_a3f2',
        suffix: 'list_members',
      });
    });

    it('returns null for invalid names', () => {
      expect(parseToolName('invalid')).toBeNull();
      expect(parseToolName('unknown__id__action')).toBeNull();
      expect(parseToolName('')).toBeNull();
    });

    it('rejects tool names with special characters in tool key', () => {
      expect(parseToolName('clubhouse__my.agent.1__send_message')).toBeNull();
      expect(parseToolName('browser__widget/1__navigate')).toBeNull();
      expect(parseToolName('clubhouse__id-with-dashes__send_message')).toBeNull();
    });

    it('round-trips through buildToolName for agent targets', () => {
      const binding = makeBinding({
        agentId: 'a1', targetId: 'durable_123', targetKind: 'agent',
        targetName: 'faithful-urchin', projectName: 'webapp',
      });
      const name = buildToolName(binding, 'send_message');
      const parsed = parseToolName(name);
      expect(parsed).not.toBeNull();
      expect(parsed!.prefix).toBe('clubhouse');
      expect(parsed!.toolKey).toBe(buildToolKey(binding));
      expect(parsed!.suffix).toBe('send_message');
    });
  });

  describe('registerToolTemplate + getScopedToolList', () => {
    it('returns empty list when no bindings', () => {
      registerToolTemplate('agent', 'test', { description: 'Test', inputSchema: { type: 'object' } }, vi.fn());
      expect(getScopedToolList('agent-1')).toHaveLength(0);
    });

    it('returns tools for bound targets with human-readable names', () => {
      registerToolTemplate('agent', 'send_message', {
        description: 'Send message',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      }, vi.fn());

      registerToolTemplate('agent', 'get_status', {
        description: 'Get status',
        inputSchema: { type: 'object' },
      }, vi.fn());

      agentRegistry.register('agent-2', { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' });
      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
        targetName: 'scrappy-robin', projectName: 'myapp',
      });

      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(2);
      const expectedKey = buildToolKey(makeBinding({
        agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent',
        targetName: 'scrappy-robin', projectName: 'myapp',
      }));
      expect(tools[0].name).toBe(`clubhouse__${expectedKey}__send_message`);
      expect(tools[1].name).toBe(`clubhouse__${expectedKey}__get_status`);
    });

    it('scopes tools to correct target kind', () => {
      registerToolTemplate('agent', 'send_message', { description: 'Send', inputSchema: { type: 'object' } }, vi.fn());
      registerToolTemplate('browser', 'navigate', { description: 'Nav', inputSchema: { type: 'object' } }, vi.fn());

      // Bind to agent only
      agentRegistry.register('agent-2', { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' });
      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' });

      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toContain('send_message');
      expect(tools[0].name).toMatch(/^clubhouse__/);
    });

    it('generates tools for multiple bindings', () => {
      registerToolTemplate('agent', 'send_message', { description: 'Send', inputSchema: { type: 'object' } }, vi.fn());

      agentRegistry.register('agent-2', { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' });
      agentRegistry.register('agent-3', { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' });
      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2' });
      bindingManager.bind('agent-1', { targetId: 'agent-3', targetKind: 'agent', label: 'Agent 3' });

      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(2);
    });
  });

  describe('instruction injection', () => {
    it('injects global (*) instructions into all tool descriptions', () => {
      registerToolTemplate('agent', 'send_message', {
        description: 'Send a message',
        inputSchema: { type: 'object' },
      }, vi.fn());
      registerToolTemplate('agent', 'get_status', {
        description: 'Get status',
        inputSchema: { type: 'object' },
      }, vi.fn());

      agentRegistry.register('agent-2', { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' });
      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
      });
      bindingManager.setInstructions('agent-1', 'agent-2', { '*': 'Do not share secrets' });

      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(2);
      expect(tools[0].description).toContain('WIRE INSTRUCTIONS: Do not share secrets');
      expect(tools[1].description).toContain('WIRE INSTRUCTIONS: Do not share secrets');
    });

    it('injects per-tool instructions that override global', () => {
      registerToolTemplate('agent', 'send_message', {
        description: 'Send a message',
        inputSchema: { type: 'object' },
      }, vi.fn());
      registerToolTemplate('agent', 'get_status', {
        description: 'Get status',
        inputSchema: { type: 'object' },
      }, vi.fn());

      agentRegistry.register('agent-2', { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' });
      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
      });
      bindingManager.setInstructions('agent-1', 'agent-2', {
        '*': 'Global instruction',
        'send_message': 'Be very concise',
      });

      const tools = getScopedToolList('agent-1');
      const sendTool = tools.find(t => t.name.includes('send_message'))!;
      const statusTool = tools.find(t => t.name.includes('get_status'))!;
      // Per-tool instruction takes priority over global
      expect(sendTool.description).toContain('WIRE INSTRUCTIONS: Be very concise');
      expect(sendTool.description).not.toContain('Global instruction');
      // Global applies to tools without specific instruction
      expect(statusTool.description).toContain('WIRE INSTRUCTIONS: Global instruction');
    });

    it('does not inject instructions when none are set', () => {
      registerToolTemplate('agent', 'send_message', {
        description: 'Send a message',
        inputSchema: { type: 'object' },
      }, vi.fn());

      agentRegistry.register('agent-2', { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' });
      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
      });

      const tools = getScopedToolList('agent-1');
      expect(tools[0].description).toBe('Send a message');
      expect(tools[0].description).not.toContain('WIRE INSTRUCTIONS');
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

      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
        targetName: 'robin', projectName: 'app',
      });

      const toolName = buildToolName(makeBinding({
        agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent',
        targetName: 'robin', projectName: 'app',
      }), 'send_message');

      const result = await callTool('agent-1', toolName, { message: 'hello' });
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
      const result = await callTool('agent-1', 'clubhouse__project_Agent_2_xxxx__send_message', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No binding');
    });

    it('returns error for unknown action suffix', async () => {
      registerToolTemplate('agent', 'send_message', {
        description: 'Send',
        inputSchema: { type: 'object' },
      }, vi.fn());

      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
        targetName: 'robin', projectName: 'app',
      });

      const key = buildToolKey(makeBinding({
        agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent',
        targetName: 'robin', projectName: 'app',
      }));

      const result = await callTool('agent-1', `clubhouse__${key}__nonexistent`, {});
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
      bindingManager.bind('agent-1', {
        targetId: 'agent.2', targetKind: 'agent', label: 'Agent 2',
        targetName: 'robin', projectName: 'app',
      });

      const toolName = buildToolName(makeBinding({
        agentId: 'agent-1', targetId: 'agent.2', targetKind: 'agent',
        targetName: 'robin', projectName: 'app',
      }), 'send_message');

      const result = await callTool('agent-1', toolName, { message: 'hi' });
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

      const toolName = buildToolName(makeBinding({
        agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'A2',
      }), 'send_message');

      const result = await callTool('agent-3', toolName, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No binding');
    });

    it('works with group-project tool names', async () => {
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'members' }],
      });
      registerToolTemplate('group-project', 'list_members', {
        description: 'List',
        inputSchema: { type: 'object' },
      }, handler);

      bindingManager.bind('agent-1', { targetId: 'gp_123', targetKind: 'group-project', label: 'GP', targetName: 'My Project' });

      const toolName = buildToolName(makeBinding({
        agentId: 'agent-1', targetId: 'gp_123', targetKind: 'group-project', targetName: 'My Project',
      }), 'list_members');

      const result = await callTool('agent-1', toolName, {});
      expect(result.isError).toBeFalsy();
      expect(handler).toHaveBeenCalledWith('gp_123', 'agent-1', {});
    });

    it('returns error when required argument is missing', async () => {
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      registerToolTemplate('agent', 'send_message', {
        description: 'Send',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
      }, handler);

      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
        targetName: 'robin', projectName: 'app',
      });

      const toolName = buildToolName(makeBinding({
        agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent',
        targetName: 'robin', projectName: 'app',
      }), 'send_message');

      const result = await callTool('agent-1', toolName, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required argument: message');
      expect(handler).not.toHaveBeenCalled();
    });

    it('returns error when argument has wrong type', async () => {
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      registerToolTemplate('agent', 'send_message', {
        description: 'Send',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
      }, handler);

      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
        targetName: 'robin', projectName: 'app',
      });

      const toolName = buildToolName(makeBinding({
        agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent',
        targetName: 'robin', projectName: 'app',
      }), 'send_message');

      const result = await callTool('agent-1', toolName, { message: 123 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid type');
      expect(handler).not.toHaveBeenCalled();
    });

    it('works with browser tool names', async () => {
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'navigated' }],
      });
      registerToolTemplate('browser', 'navigate', {
        description: 'Nav',
        inputSchema: { type: 'object' },
      }, handler);

      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });

      const result = await callTool('agent-1', 'browser__widget_1__navigate', { url: 'http://test' });
      expect(result.isError).toBeFalsy();
      expect(handler).toHaveBeenCalledWith('widget-1', 'agent-1', { url: 'http://test' });
    });
  });

  describe('sleeping target tool filtering', () => {
    beforeEach(() => {
      // Register multiple agent tools
      registerToolTemplate('agent', 'send_message', { description: 'Send', inputSchema: { type: 'object' } }, vi.fn());
      registerToolTemplate('agent', 'get_status', { description: 'Status', inputSchema: { type: 'object' } }, vi.fn());
      registerToolTemplate('agent', 'wake', { description: 'Wake', inputSchema: { type: 'object' } }, vi.fn());
      registerToolTemplate('agent', 'read_output', { description: 'Read', inputSchema: { type: 'object' } }, vi.fn());

      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
        targetName: 'robin', projectName: 'app',
      });
    });

    it('only exposes get_status and wake when target agent is sleeping (not in registry)', () => {
      // agent-2 is NOT in agentRegistry → sleeping
      const tools = getScopedToolList('agent-1');
      const suffixes = tools.map(t => t.name.split('__').pop());
      expect(suffixes).toEqual(['get_status', 'wake']);
    });

    it('exposes all tools when target agent is running (in registry)', () => {
      agentRegistry.register('agent-2', { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' });
      const tools = getScopedToolList('agent-1');
      const suffixes = tools.map(t => t.name.split('__').pop());
      expect(suffixes).toEqual(['send_message', 'get_status', 'wake', 'read_output']);
      agentRegistry.untrack('agent-2');
    });

    it('does not filter non-agent target tools', () => {
      registerToolTemplate('browser', 'navigate', { description: 'Nav', inputSchema: { type: 'object' } }, vi.fn());
      bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
      // Browser target not in registry — should still get all browser tools
      const tools = getScopedToolList('agent-1');
      const browserTools = tools.filter(t => t.name.startsWith('browser__'));
      expect(browserTools).toHaveLength(1);
    });
  });

  describe('disabledTools filtering', () => {
    beforeEach(() => {
      registerToolTemplate('agent', 'send_message', { description: 'Send', inputSchema: { type: 'object' } }, vi.fn());
      registerToolTemplate('agent', 'get_status', { description: 'Status', inputSchema: { type: 'object' } }, vi.fn());
      registerToolTemplate('agent', 'read_output', { description: 'Read', inputSchema: { type: 'object' } }, vi.fn());

      agentRegistry.register('agent-2', { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' });
      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
        targetName: 'robin', projectName: 'app',
      });
    });

    it('excludes tools listed in disabledTools', () => {
      bindingManager.setDisabledTools('agent-1', 'agent-2', ['read_output']);
      const tools = getScopedToolList('agent-1');
      const suffixes = tools.map(t => t.name.split('__').pop());
      expect(suffixes).toContain('send_message');
      expect(suffixes).toContain('get_status');
      expect(suffixes).not.toContain('read_output');
      agentRegistry.untrack('agent-2');
    });

    it('excludes multiple disabled tools', () => {
      bindingManager.setDisabledTools('agent-1', 'agent-2', ['send_message', 'read_output']);
      const tools = getScopedToolList('agent-1');
      const suffixes = tools.map(t => t.name.split('__').pop());
      expect(suffixes).toEqual(['get_status']);
      agentRegistry.untrack('agent-2');
    });

    it('exposes all tools when disabledTools is empty', () => {
      bindingManager.setDisabledTools('agent-1', 'agent-2', []);
      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(3);
      agentRegistry.untrack('agent-2');
    });
  });

  describe('shoulder tap group project gating', () => {
    beforeEach(() => {
      registerToolTemplate('group-project', 'list_members', { description: 'List', inputSchema: { type: 'object' } }, vi.fn());
      registerToolTemplate('group-project', 'shoulder_tap', { description: 'Tap', inputSchema: { type: 'object' } }, vi.fn());
      registerToolTemplate('group-project', 'broadcast', { description: 'Broadcast', inputSchema: { type: 'object' } }, vi.fn());
    });

    it('hides shoulder_tap and broadcast when shoulderTapEnabled is false', async () => {
      const project = await groupProjectRegistry.create('TestProj');
      bindingManager.bind('agent-1', {
        targetId: project.id, targetKind: 'group-project', label: 'TP', targetName: 'TestProj',
      });
      // Default: shoulderTapEnabled not set (falsy)
      const tools = getScopedToolList('agent-1');
      const suffixes = tools.map(t => t.name.split('__').pop());
      expect(suffixes).toContain('list_members');
      expect(suffixes).not.toContain('shoulder_tap');
      expect(suffixes).not.toContain('broadcast');
    });

    it('shows shoulder_tap and broadcast when shoulderTapEnabled is true', async () => {
      const project = await groupProjectRegistry.create('TapProj');
      await groupProjectRegistry.update(project.id, { metadata: { shoulderTapEnabled: true } });
      bindingManager.bind('agent-1', {
        targetId: project.id, targetKind: 'group-project', label: 'TP', targetName: 'TapProj',
      });
      const tools = getScopedToolList('agent-1');
      const suffixes = tools.map(t => t.name.split('__').pop());
      expect(suffixes).toContain('list_members');
      expect(suffixes).toContain('shoulder_tap');
      expect(suffixes).toContain('broadcast');
    });

    it('hides shoulder_tap even when enabled at project level if disabled at wire level', async () => {
      const project = await groupProjectRegistry.create('MixProj');
      await groupProjectRegistry.update(project.id, { metadata: { shoulderTapEnabled: true } });
      bindingManager.bind('agent-1', {
        targetId: project.id, targetKind: 'group-project', label: 'MP', targetName: 'MixProj',
      });
      bindingManager.setDisabledTools('agent-1', project.id, ['shoulder_tap']);
      const tools = getScopedToolList('agent-1');
      const suffixes = tools.map(t => t.name.split('__').pop());
      expect(suffixes).toContain('list_members');
      expect(suffixes).not.toContain('shoulder_tap');
      expect(suffixes).toContain('broadcast'); // broadcast not disabled at wire level
    });
  });
});
