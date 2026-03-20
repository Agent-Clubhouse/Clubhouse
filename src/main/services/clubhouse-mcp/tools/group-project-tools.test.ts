import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/test-clubhouse',
  },
}));

const store = new Map<string, string>();
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockImplementation(async (p: string) => {
    if (!store.has(p)) throw new Error('ENOENT');
  }),
  readFile: vi.fn().mockImplementation(async (p: string) => {
    const data = store.get(p);
    if (!data) throw new Error('ENOENT');
    return data;
  }),
  writeFile: vi.fn().mockImplementation(async (p: string, content: string) => {
    store.set(p, content);
  }),
}));

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

const mockPtyWrite = vi.fn();
vi.mock('../../pty-manager', () => ({
  write: (...args: unknown[]) => mockPtyWrite(...args),
  getBuffer: vi.fn(() => ''),
}));

vi.mock('../../structured-manager', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

import { _resetForTesting as resetToolRegistry } from '../tool-registry';
import { bindingManager } from '../binding-manager';
import { _resetAllBoardsForTesting } from '../../group-project-bulletin';
import { groupProjectRegistry } from '../../group-project-registry';
import { agentRegistry } from '../../agent-registry';
import { registerGroupProjectTools } from './group-project-tools';
import { getScopedToolList, callTool, buildToolName } from '../tool-registry';
import type { McpBinding } from '../types';

function makeBinding(overrides: Partial<McpBinding> & { agentId: string; targetId: string }): McpBinding {
  return { label: 'Test', targetKind: 'group-project', ...overrides };
}

describe('GroupProjectTools', () => {
  beforeEach(() => {
    store.clear();
    mockPtyWrite.mockClear();
    resetToolRegistry();
    bindingManager._resetForTesting();
    _resetAllBoardsForTesting();
    groupProjectRegistry._resetForTesting();
    registerGroupProjectTools();
  });

  it('registers 6 tools for a group-project binding', () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'My Project',
      agentName: 'robin',
      targetName: 'My Project',
    });

    const tools = getScopedToolList('agent-1');
    expect(tools).toHaveLength(6);

    const suffixes = tools.map(t => t.name.split('__').pop());
    expect(suffixes).toContain('list_members');
    expect(suffixes).toContain('post_bulletin');
    expect(suffixes).toContain('read_bulletin');
    expect(suffixes).toContain('read_topic');
    expect(suffixes).toContain('get_project_info');
    expect(suffixes).toContain('shoulder_tap');
  });

  it('tool names use group prefix', () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'My Project',
      targetName: 'My Project',
    });

    const tools = getScopedToolList('agent-1');
    for (const tool of tools) {
      expect(tool.name).toMatch(/^group__/);
    }
  });

  it('list_members returns connected agents', async () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });
    bindingManager.bind('agent-2', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'falcon',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_123', targetName: 'GP' });
    const toolName = buildToolName(binding, 'list_members');
    const result = await callTool('agent-1', toolName, {});

    expect(result.isError).toBeFalsy();
    const members = JSON.parse(result.content[0].text!);
    expect(members).toHaveLength(2);
    expect(members.map((m: any) => m.agentName).sort()).toEqual(['falcon', 'robin']);
  });

  it('post_bulletin posts and returns confirmation', async () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
      projectName: 'myapp',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_123', targetName: 'GP' });
    const toolName = buildToolName(binding, 'post_bulletin');
    const result = await callTool('agent-1', toolName, { topic: 'progress', body: 'Done with step 1' });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.posted).toBe(true);
    expect(parsed.topic).toBe('progress');
    expect(parsed.messageId).toMatch(/^msg_/);
  });

  it('post_bulletin rejects system topic', async () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_123', targetName: 'GP' });
    const toolName = buildToolName(binding, 'post_bulletin');
    const result = await callTool('agent-1', toolName, { topic: 'system', body: 'hack' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('reserved');
  });

  it('read_bulletin returns digest', async () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    // Post some messages first
    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_123', targetName: 'GP' });
    const postName = buildToolName(binding, 'post_bulletin');
    await callTool('agent-1', postName, { topic: 'updates', body: 'msg1' });
    await callTool('agent-1', postName, { topic: 'updates', body: 'msg2' });

    const readName = buildToolName(binding, 'read_bulletin');
    const result = await callTool('agent-1', readName, {});

    expect(result.isError).toBeFalsy();
    const digest = JSON.parse(result.content[0].text!);
    expect(digest).toHaveLength(1);
    expect(digest[0].topic).toBe('updates');
    expect(digest[0].messageCount).toBe(2);
  });

  it('read_topic returns messages', async () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_123', targetName: 'GP' });
    const postName = buildToolName(binding, 'post_bulletin');
    await callTool('agent-1', postName, { topic: 'progress', body: 'Step 1 done' });

    const readName = buildToolName(binding, 'read_topic');
    const result = await callTool('agent-1', readName, { topic: 'progress' });

    expect(result.isError).toBeFalsy();
    const messages = JSON.parse(result.content[0].text!);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('Step 1 done');
    expect(messages[0].sender).toContain('robin');
  });

  it('get_project_info returns project data with members', async () => {
    const project = await groupProjectRegistry.create('InfoProj');
    await groupProjectRegistry.update(project.id, {
      description: 'A test project',
      instructions: 'Follow the rules',
    });

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'InfoProj',
      agentName: 'robin',
      targetName: 'InfoProj',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'InfoProj' });
    const toolName = buildToolName(binding, 'get_project_info');
    const result = await callTool('agent-1', toolName, {});

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.name).toBe('InfoProj');
    expect(parsed.description).toBe('A test project');
    expect(parsed.instructions).toBe('Follow the rules');
    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0].agentName).toBe('robin');
  });

  it('get_project_info returns error for unknown project', async () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_unknown',
      targetKind: 'group-project',
      label: 'Unknown',
      targetName: 'Unknown',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_unknown', targetName: 'Unknown' });
    const toolName = buildToolName(binding, 'get_project_info');
    const result = await callTool('agent-1', toolName, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('shoulder_tap delivers and records to bulletin', async () => {
    const project = await groupProjectRegistry.create('TapProj');

    agentRegistry.register('agent-1', {
      projectPath: '/test',
      orchestrator: 'claude-code',
      runtime: 'pty',
    });
    agentRegistry.register('agent-2', {
      projectPath: '/test',
      orchestrator: 'claude-code',
      runtime: 'pty',
    });

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'TapProj',
      agentName: 'robin',
      targetName: 'TapProj',
      projectName: 'myapp',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'TapProj',
      agentName: 'falcon',
      targetName: 'TapProj',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'TapProj' });
    const toolName = buildToolName(binding, 'shoulder_tap');
    const result = await callTool('agent-1', toolName, {
      message: 'Need your help',
      target_agent_id: 'agent-2',
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.delivered).toHaveLength(1);
    expect(parsed.delivered[0].agentName).toBe('falcon');
    expect(parsed.taskId).toBeTruthy();
    expect(parsed.messageId).toMatch(/^msg_/);

    // Verify PTY injection
    expect(mockPtyWrite).toHaveBeenCalled();
    const ptyCall = mockPtyWrite.mock.calls[0];
    expect(ptyCall[0]).toBe('agent-2');
    expect(ptyCall[1]).toContain('[SHOULDER-TAP]');

    agentRegistry.untrack('agent-1');
    agentRegistry.untrack('agent-2');
  });
});
