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
const mockIsRunning = vi.fn().mockReturnValue(false);
vi.mock('../../pty-manager', () => ({
  write: (...args: unknown[]) => mockPtyWrite(...args),
  getBuffer: vi.fn(() => ''),
  isRunning: (...args: unknown[]) => mockIsRunning(...args),
}));

vi.mock('../../structured-manager', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

const mockSpawnAgent = vi.fn().mockResolvedValue(undefined);
const mockKillAgent = vi.fn().mockResolvedValue(undefined);
vi.mock('../../agent-system', () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  killAgent: (...args: unknown[]) => mockKillAgent(...args),
  isHeadlessAgent: vi.fn().mockReturnValue(false),
  isStructuredAgent: vi.fn().mockReturnValue(false),
}));

const mockBroadcastToAllWindows = vi.fn();
vi.mock('../../../util/ipc-broadcast', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcastToAllWindows(...args),
}));

const mockListDurable = vi.fn().mockResolvedValue([]);
vi.mock('../../agent-config', () => ({
  listDurable: (...args: unknown[]) => mockListDurable(...args),
}));

const mockProjectList = vi.fn().mockResolvedValue([]);
vi.mock('../../project-store', () => ({
  list: (...args: unknown[]) => mockProjectList(...args),
}));

import { _resetForTesting as resetToolRegistry } from '../tool-registry';
import { bindingManager } from '../binding-manager';
import { mcpAdapter } from '../mcp-adapter';
import { commandRegistry } from '../../../../shared/command-registry';
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
    mockIsRunning.mockReturnValue(false);
    mockSpawnAgent.mockClear();
    mockSpawnAgent.mockResolvedValue(undefined);
    mockKillAgent.mockClear();
    mockKillAgent.mockResolvedValue(undefined);
    mockBroadcastToAllWindows.mockClear();
    mockListDurable.mockReset();
    mockListDurable.mockResolvedValue([]);
    mockProjectList.mockReset();
    mockProjectList.mockResolvedValue([]);
    resetToolRegistry();
    mcpAdapter._resetForTesting();
    commandRegistry.clear();
    bindingManager._resetForTesting();
    _resetAllBoardsForTesting();
    groupProjectRegistry._resetForTesting();
    registerGroupProjectTools();
  });

  it('exposes all 18 tools to an admin member', () => {
    groupProjectRegistry._setForTesting({
      id: 'gp_123', name: 'My Project', description: '', instructions: '',
      createdAt: '2020-01-01T00:00:00Z', metadata: { admins: ['agent-1'] },
    });
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'My Project',
      agentName: 'robin',
      targetName: 'My Project',
    });

    const tools = getScopedToolList('agent-1');
    expect(tools).toHaveLength(18);

    const suffixes = tools.map(t => t.name.split('__').pop());
    expect(suffixes).toContain('list_members');
    expect(suffixes).toContain('post_bulletin');
    expect(suffixes).toContain('read_bulletin');
    expect(suffixes).toContain('read_topic');
    expect(suffixes).toContain('get_project_info');
    expect(suffixes).toContain('read_message');
    expect(suffixes).toContain('shoulder_tap');
    expect(suffixes).toContain('broadcast');
    expect(suffixes).toContain('wake_agent');
    expect(suffixes).toContain('sleep_agent');
    expect(suffixes).toContain('toggle_polling');
    expect(suffixes).toContain('query_polling');
    expect(suffixes).toContain('nudge_polling');
    expect(suffixes).not.toContain('start_polling');
    expect(suffixes).not.toContain('stop_polling');
    expect(suffixes).toContain('clear_agent');
    expect(suffixes).toContain('compact_agent');
    expect(suffixes).toContain('clear_topic');
    expect(suffixes).toContain('delete_messages');
    expect(suffixes).toContain('set_project_info');
  });

  it('exposes only the core tools (incl. query_polling) to a non-admin member', () => {
    groupProjectRegistry._setForTesting({
      id: 'gp_core', name: 'Core', description: '', instructions: '',
      createdAt: '2020-01-01T00:00:00Z', metadata: { admins: ['someone-else'] },
    });
    bindingManager.bind('agent-1', {
      targetId: 'gp_core', targetKind: 'group-project', label: 'Core', agentName: 'robin',
    });

    const suffixes = getScopedToolList('agent-1').map(t => t.name.split('__').pop());
    expect(suffixes.sort()).toEqual(
      ['get_project_info', 'list_members', 'post_bulletin', 'query_polling', 'read_bulletin', 'read_message', 'read_topic'].sort(),
    );
    for (const priv of ['shoulder_tap', 'broadcast', 'wake_agent', 'sleep_agent', 'toggle_polling', 'nudge_polling', 'delete_messages', 'set_project_info']) {
      expect(suffixes).not.toContain(priv);
    }
  });

  it('hides tools disabled at the wire level', () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'My Project',
      agentName: 'robin',
      targetName: 'My Project',
    });
    bindingManager.setDisabledTools('agent-1', 'gp_123', ['shoulder_tap', 'broadcast', 'wake_agent', 'sleep_agent', 'toggle_polling', 'nudge_polling', 'clear_agent', 'compact_agent', 'clear_topic', 'delete_messages']);

    const tools = getScopedToolList('agent-1');
    const suffixes = tools.map(t => t.name.split('__').pop());
    expect(suffixes).toContain('list_members');
    expect(suffixes).toContain('post_bulletin');
    expect(suffixes).toContain('read_bulletin');
    expect(suffixes).toContain('read_topic');
    expect(suffixes).toContain('read_message');
    expect(suffixes).toContain('get_project_info');
    expect(suffixes).not.toContain('shoulder_tap');
    expect(suffixes).not.toContain('broadcast');
    expect(suffixes).not.toContain('wake_agent');
    expect(suffixes).not.toContain('sleep_agent');
    expect(suffixes).not.toContain('clear_agent');
    expect(suffixes).not.toContain('compact_agent');
    expect(suffixes).not.toContain('clear_topic');
    expect(suffixes).not.toContain('delete_messages');
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

  it('list_members includes status field — connected when PTY running', async () => {
    agentRegistry.register('agent-1', {
      projectPath: '/test',
      orchestrator: 'claude-code',
      runtime: 'pty',
    });
    mockIsRunning.mockImplementation((id: string) => id === 'agent-1');

    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_123', targetName: 'GP' });
    const toolName = buildToolName(binding, 'list_members');
    const result = await callTool('agent-1', toolName, {});

    const members = JSON.parse(result.content[0].text!);
    expect(members).toHaveLength(1);
    expect(members[0].status).toBe('connected');

    agentRegistry.untrack('agent-1');
  });

  it('list_members shows sleeping status when agent has no live process', async () => {
    // Agent is bound but NOT in registry and NOT running
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_123', targetName: 'GP' });
    const toolName = buildToolName(binding, 'list_members');
    const result = await callTool('agent-1', toolName, {});

    const members = JSON.parse(result.content[0].text!);
    expect(members).toHaveLength(1);
    expect(members[0].status).toBe('sleeping');
  });

  it('list_members shows mixed statuses for multiple agents', async () => {
    agentRegistry.register('agent-1', {
      projectPath: '/test',
      orchestrator: 'claude-code',
      runtime: 'pty',
    });
    mockIsRunning.mockImplementation((id: string) => id === 'agent-1');

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

    const members = JSON.parse(result.content[0].text!);
    expect(members).toHaveLength(2);

    const robin = members.find((m: any) => m.agentName === 'robin');
    const falcon = members.find((m: any) => m.agentName === 'falcon');
    expect(robin.status).toBe('connected');
    expect(falcon.status).toBe('sleeping');

    agentRegistry.untrack('agent-1');
  });

  it('get_project_info includes status in member list', async () => {
    const project = await groupProjectRegistry.create('StatusProj');
    agentRegistry.register('agent-1', {
      projectPath: '/test',
      orchestrator: 'claude-code',
      runtime: 'headless',
    });
    // Headless agent — not in PTY but registered
    mockIsRunning.mockReturnValue(false);

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'StatusProj',
      agentName: 'robin',
      targetName: 'StatusProj',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'StatusProj' });
    const toolName = buildToolName(binding, 'get_project_info');
    const result = await callTool('agent-1', toolName, {});

    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0].status).toBe('connected'); // registered = alive

    agentRegistry.untrack('agent-1');
  });

  it('shoulder_tap and broadcast are available to an admin member', async () => {
    const project = await groupProjectRegistry.create('TapProj');
    await groupProjectRegistry.update(project.id, { metadata: { admins: ['agent-1'] } });

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'TapProj',
      agentName: 'robin',
      targetName: 'TapProj',
    });

    const tools = getScopedToolList('agent-1');
    const suffixes = tools.map(t => t.name.split('__').pop());
    expect(suffixes).toContain('shoulder_tap');
    expect(suffixes).toContain('broadcast');
  });

  it('shoulder_tap delivers message to target agent', async () => {
    const project = await groupProjectRegistry.create('TapDelivery');

    agentRegistry.register('agent-1', { projectPath: '/test', orchestrator: 'claude-code', runtime: 'pty' });
    agentRegistry.register('agent-2', { projectPath: '/test', orchestrator: 'claude-code', runtime: 'pty' });

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'TD',
      agentName: 'robin',
      targetName: 'TapDelivery',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'TD',
      agentName: 'falcon',
      targetName: 'TapDelivery',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'TapDelivery' });
    const toolName = buildToolName(binding, 'shoulder_tap');
    const result = await callTool('agent-1', toolName, {
      target_agent_id: 'agent-2',
      message: 'Check the config file',
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.delivered).toBe(1);
    expect(parsed.taskId).toMatch(/^tap_/);

    agentRegistry.untrack('agent-1');
    agentRegistry.untrack('agent-2');
  });

  it('broadcast delivers message to all agents except sender', async () => {
    const project = await groupProjectRegistry.create('BroadcastProj');

    agentRegistry.register('agent-1', { projectPath: '/test', orchestrator: 'claude-code', runtime: 'pty' });
    agentRegistry.register('agent-2', { projectPath: '/test', orchestrator: 'claude-code', runtime: 'pty' });

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'BP',
      agentName: 'robin',
      targetName: 'BroadcastProj',
      projectName: 'myapp',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'BP',
      agentName: 'falcon',
      targetName: 'BroadcastProj',
      projectName: 'myapp',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'BroadcastProj' });
    const toolName = buildToolName(binding, 'broadcast');
    const result = await callTool('agent-1', toolName, {
      message: 'Stop all work immediately',
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.delivered).toBe(1); // Only falcon (sender excluded)
    expect(parsed.taskId).toMatch(/^tap_/);

    agentRegistry.untrack('agent-1');
    agentRegistry.untrack('agent-2');
  });

  describe('resolveSenderLabel (via post_bulletin)', () => {
    it('uses live registry name when project has been renamed', async () => {
      const project = await groupProjectRegistry.create('OldName');
      bindingManager.bind('agent-1', {
        targetId: project.id,
        targetKind: 'group-project',
        label: 'GP',
        agentName: 'robin',
        projectName: 'OldName',
      });

      // Rename the project
      await groupProjectRegistry.update(project.id, { name: 'NewName' });

      const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'GP' });
      const toolName = buildToolName(binding, 'post_bulletin');
      await callTool('agent-1', toolName, { topic: 'test', body: 'hello' });

      // Message sender should reflect the updated project name
      const board = (await import('../../group-project-bulletin')).getBulletinBoard(project.id);
      const messages = await board.getTopicMessages('test');
      expect(messages[0].sender).toContain('NewName');
    });

    it('writes updated projectName back to the binding', async () => {
      const project = await groupProjectRegistry.create('OldName');
      bindingManager.bind('agent-1', {
        targetId: project.id,
        targetKind: 'group-project',
        label: 'GP',
        agentName: 'robin',
        projectName: 'OldName',
      });

      await groupProjectRegistry.update(project.id, { name: 'NewName' });

      const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'GP' });
      const toolName = buildToolName(binding, 'post_bulletin');
      await callTool('agent-1', toolName, { topic: 'test', body: 'hello' });

      // bindingManager should have the refreshed name
      const bindings = bindingManager.getBindingsForAgent('agent-1');
      expect(bindings[0].projectName).toBe('NewName');
    });

    it('falls back to cached projectName when registry lookup throws', async () => {
      const project = await groupProjectRegistry.create('StableName');
      bindingManager.bind('agent-1', {
        targetId: project.id,
        targetKind: 'group-project',
        label: 'GP',
        agentName: 'robin',
        projectName: 'StableName',
      });

      // Make registry.get throw for this call
      const origGet = groupProjectRegistry.get.bind(groupProjectRegistry);
      vi.spyOn(groupProjectRegistry, 'get').mockRejectedValueOnce(new Error('registry unavailable'));

      const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'GP' });
      const toolName = buildToolName(binding, 'post_bulletin');
      await callTool('agent-1', toolName, { topic: 'test', body: 'hello' });

      vi.spyOn(groupProjectRegistry, 'get').mockImplementation(origGet);

      const board = (await import('../../group-project-bulletin')).getBulletinBoard(project.id);
      const messages = await board.getTopicMessages('test');
      // Should still use cached name
      expect(messages[0].sender).toContain('StableName');
    });
  });

  it('shoulder_tap returns error when target_agent_id is missing', async () => {
    const project = await groupProjectRegistry.create('ErrProj');

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'EP',
      agentName: 'robin',
      targetName: 'ErrProj',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'ErrProj' });
    const toolName = buildToolName(binding, 'shoulder_tap');
    const result = await callTool('agent-1', toolName, { message: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('required');
  });

  it('read_bulletin description describes the channel model', async () => {
    const project = await groupProjectRegistry.create('ChanModel');

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'ChanModel',
      agentName: 'robin',
      targetName: 'ChanModel',
    });

    const tools = getScopedToolList('agent-1');
    const readBulletin = tools.find(t => t.name.split('__').pop() === 'read_bulletin');
    expect(readBulletin).toBeDefined();
    // The legacy "shoulder-tap" topic hint is gone — channel-model guidance replaces it.
    expect(readBulletin!.description).not.toContain('"shoulder-tap" topic');
    expect(readBulletin!.description).toContain('general');
    expect(readBulletin!.description).toContain('control');
    expect(readBulletin!.description).toContain('inbox-<your-name>');
  });

  /* ---------- Agent Control Tools (wake, sleep, polling) ---------- */

  it('wake_agent, sleep_agent, toggle_polling, nudge_polling are available to an admin (query_polling to all)', () => {
    groupProjectRegistry._setForTesting({
      id: 'gp_123', name: 'My Project', description: '', instructions: '',
      createdAt: '2020-01-01T00:00:00Z', metadata: { admins: ['agent-1'] },
    });
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'My Project',
      agentName: 'robin',
      targetName: 'My Project',
    });

    const tools = getScopedToolList('agent-1');
    const suffixes = tools.map(t => t.name.split('__').pop());
    expect(suffixes).toContain('wake_agent');
    expect(suffixes).toContain('sleep_agent');
    expect(suffixes).toContain('toggle_polling');
    expect(suffixes).toContain('nudge_polling');
    expect(suffixes).toContain('query_polling');
    expect(suffixes).not.toContain('start_polling');
    expect(suffixes).not.toContain('stop_polling');
  });

  it('wake_agent returns error for non-member agent', async () => {
    const project = await groupProjectRegistry.create('WakeProj');

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'WP',
      agentName: 'robin',
      targetName: 'WakeProj',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'WakeProj' });
    const toolName = buildToolName(binding, 'wake_agent');
    const result = await callTool('agent-1', toolName, { target_agent_id: 'agent-stranger' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a member');
  });

  it('wake_agent returns already_running when agent is alive', async () => {
    const project = await groupProjectRegistry.create('WakeRunning');

    agentRegistry.register('agent-2', { projectPath: '/test', orchestrator: 'claude-code', runtime: 'pty' });
    mockIsRunning.mockImplementation((id: string) => id === 'agent-2');

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'WR',
      agentName: 'robin',
      targetName: 'WakeRunning',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'WR',
      agentName: 'falcon',
      targetName: 'WakeRunning',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'WakeRunning' });
    const toolName = buildToolName(binding, 'wake_agent');
    const result = await callTool('agent-1', toolName, { target_agent_id: 'agent-2' });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.status).toBe('already_running');

    agentRegistry.untrack('agent-2');
  });

  it('wake_agent spawns sleeping agent and broadcasts waking state', async () => {
    const project = await groupProjectRegistry.create('WakeSpawn');

    // Mock project store and agent config for wake
    mockProjectList.mockResolvedValue([{ id: 'proj_1', path: '/test/proj', name: 'Test' }]);
    mockListDurable.mockResolvedValue([
      { id: 'agent-2', name: 'falcon', model: 'opus', orchestrator: 'claude-code', worktreePath: '/test/proj/wt' },
    ]);

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'WS',
      agentName: 'robin',
      targetName: 'WakeSpawn',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'WS',
      agentName: 'falcon',
      targetName: 'WakeSpawn',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'WakeSpawn' });
    const toolName = buildToolName(binding, 'wake_agent');
    const result = await callTool('agent-1', toolName, {
      target_agent_id: 'agent-2',
      message: 'Start working on Mission 42',
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.status).toBe('starting');
    expect(parsed.agentName).toBe('falcon');

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-2',
        projectPath: '/test/proj',
        cwd: '/test/proj/wt',
        kind: 'durable',
        mission: 'Start working on Mission 42',
      }),
    );
    expect(mockBroadcastToAllWindows).toHaveBeenCalledWith('agent:agent-waking', 'agent-2');
  });

  it('wake_agent can resume the target agent session', async () => {
    const project = await groupProjectRegistry.create('WakeResume');

    mockProjectList.mockResolvedValue([{ id: 'proj_1', path: '/test/proj', name: 'Test' }]);
    mockListDurable.mockResolvedValue([
      {
        id: 'agent-2',
        name: 'falcon',
        model: 'opus',
        orchestrator: 'claude-code',
        worktreePath: '/test/proj/wt',
        lastSessionId: 'session-123',
        freeAgentMode: true,
        structuredMode: true,
      },
    ]);

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'WR',
      agentName: 'robin',
      targetName: 'WakeResume',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'WR',
      agentName: 'falcon',
      targetName: 'WakeResume',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'WakeResume' });
    const toolName = buildToolName(binding, 'wake_agent');
    const result = await callTool('agent-1', toolName, {
      target_agent_id: 'agent-2',
      resume: true,
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.resume).toBe(true);
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-2',
        resume: true,
        sessionId: 'session-123',
        freeAgentMode: true,
        structuredMode: true,
      }),
    );
  });

  it('wake_agent broadcasts wake_failed when spawn fails', async () => {
    const project = await groupProjectRegistry.create('WakeFail');

    mockProjectList.mockResolvedValue([{ id: 'proj_1', path: '/test/proj', name: 'Test' }]);
    mockListDurable.mockResolvedValue([
      { id: 'agent-2', name: 'falcon', model: 'opus', orchestrator: 'claude-code', worktreePath: '/test/proj/wt' },
    ]);
    mockSpawnAgent.mockRejectedValue(new Error('CLI not available'));

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'WF',
      agentName: 'robin',
      targetName: 'WakeFail',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'WF',
      agentName: 'falcon',
      targetName: 'WakeFail',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'WakeFail' });
    const toolName = buildToolName(binding, 'wake_agent');
    const result = await callTool('agent-1', toolName, { target_agent_id: 'agent-2' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CLI not available');
    // AGENT_WAKING fires before spawn (transitional state).  AGENT_WAKE_FAILED
    // then transitions the renderer to error.  AGENT_AWOKE must NOT fire on
    // failure — that's broadcast by spawnAgent on success only and is what
    // flips the card from 'waking' to 'running'.
    expect(mockBroadcastToAllWindows).toHaveBeenCalledWith('agent:agent-waking', 'agent-2');
    expect(mockBroadcastToAllWindows).toHaveBeenCalledWith('agent:agent-wake-failed', 'agent-2', 'CLI not available');
    expect(mockBroadcastToAllWindows).not.toHaveBeenCalledWith('agent:agent-awoke', 'agent-2');
  });

  it('sleep_agent stops a connected member via agent lifecycle', async () => {
    const project = await groupProjectRegistry.create('SleepAgent');

    agentRegistry.register('agent-2', { projectPath: '/test/proj', orchestrator: 'claude-code', runtime: 'pty' });
    mockIsRunning.mockImplementation((id: string) => id === 'agent-2');

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'SA',
      agentName: 'robin',
      targetName: 'SleepAgent',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'SA',
      agentName: 'falcon',
      targetName: 'SleepAgent',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'SleepAgent' });
    const toolName = buildToolName(binding, 'sleep_agent');
    const result = await callTool('agent-1', toolName, { target_agent_id: 'agent-2' });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.action).toBe('sleep_agent');
    expect(parsed.delivered).toBe(true);
    expect(mockKillAgent).toHaveBeenCalledWith('agent-2', '/test/proj', 'claude-code');
    expect(mockBroadcastToAllWindows).toHaveBeenCalledWith('agent:agent-sleeping', 'agent-2');

    agentRegistry.untrack('agent-2');
  });

  it('sleep_agent reports already_sleeping for a sleeping member', async () => {
    const project = await groupProjectRegistry.create('AlreadySleep');

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'AS',
      agentName: 'robin',
      targetName: 'AlreadySleep',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'AS',
      agentName: 'falcon',
      targetName: 'AlreadySleep',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'AlreadySleep' });
    const toolName = buildToolName(binding, 'sleep_agent');
    const result = await callTool('agent-1', toolName, { target_agent_id: 'agent-2' });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.status).toBe('already_sleeping');
    expect(mockKillAgent).not.toHaveBeenCalled();
  });

  it('toggle_polling(enabled=true) persists the setting and injects start to connected members', async () => {
    const project = await groupProjectRegistry.create('PollToggle');

    agentRegistry.register('agent-2', { projectPath: '/test', orchestrator: 'claude-code', runtime: 'pty' });
    mockIsRunning.mockImplementation((id: string) => id === 'agent-2');

    bindingManager.bind('agent-1', {
      targetId: project.id, targetKind: 'group-project', label: 'PT', agentName: 'robin', targetName: 'PollToggle',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id, targetKind: 'group-project', label: 'PT', agentName: 'falcon', targetName: 'PollToggle',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'PollToggle' });
    const result = await callTool('agent-1', buildToolName(binding, 'toggle_polling'), { enabled: true });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.action).toBe('toggle_polling');
    expect(parsed.pollingEnabled).toBe(true);
    expect(parsed.notifiedMembers.map((m: { agentId: string }) => m.agentId)).toEqual(['agent-2']);

    // Setting is actually persisted
    const persisted = await groupProjectRegistry.get(project.id);
    expect(persisted?.metadata?.pollingEnabled).toBe(true);

    // Only the connected member (agent-2) receives the start instruction
    const startWrite = mockPtyWrite.mock.calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('start polling'),
    );
    expect(startWrite).toBeDefined();
    expect(startWrite![0]).toBe('agent-2');

    agentRegistry.untrack('agent-2');
  });

  it('toggle_polling without enabled flips the current value and injects stop when turning off', async () => {
    const project = await groupProjectRegistry.create('PollFlip');
    await groupProjectRegistry.update(project.id, { metadata: { pollingEnabled: true } });

    agentRegistry.register('agent-2', { projectPath: '/test', orchestrator: 'claude-code', runtime: 'pty' });
    mockIsRunning.mockImplementation((id: string) => id === 'agent-2');

    bindingManager.bind('agent-1', {
      targetId: project.id, targetKind: 'group-project', label: 'PF', agentName: 'robin', targetName: 'PollFlip',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id, targetKind: 'group-project', label: 'PF', agentName: 'falcon', targetName: 'PollFlip',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'PollFlip' });
    const result = await callTool('agent-1', buildToolName(binding, 'toggle_polling'), {});

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.pollingEnabled).toBe(false);

    const persisted = await groupProjectRegistry.get(project.id);
    expect(persisted?.metadata?.pollingEnabled).toBe(false);

    const stopWrite = mockPtyWrite.mock.calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('stop polling'),
    );
    expect(stopWrite).toBeDefined();

    agentRegistry.untrack('agent-2');
  });

  it('query_polling returns the current setting and member statuses', async () => {
    const project = await groupProjectRegistry.create('PollQuery');
    await groupProjectRegistry.update(project.id, { metadata: { pollingEnabled: true } });

    agentRegistry.register('agent-2', { projectPath: '/test', orchestrator: 'claude-code', runtime: 'pty' });
    mockIsRunning.mockImplementation((id: string) => id === 'agent-2');

    bindingManager.bind('agent-1', {
      targetId: project.id, targetKind: 'group-project', label: 'PQ', agentName: 'robin', targetName: 'PollQuery',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id, targetKind: 'group-project', label: 'PQ', agentName: 'falcon', targetName: 'PollQuery',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'PollQuery' });
    const result = await callTool('agent-1', buildToolName(binding, 'query_polling'), {});

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.pollingEnabled).toBe(true);
    const statuses = Object.fromEntries(parsed.members.map((m: { agentId: string; status: string }) => [m.agentId, m.status]));
    expect(statuses['agent-2']).toBe('connected');
    expect(statuses['agent-1']).toBe('sleeping');

    agentRegistry.untrack('agent-2');
  });

  it('nudge_polling injects a nudge into a connected agent without changing the setting', async () => {
    const project = await groupProjectRegistry.create('PollNudge');

    agentRegistry.register('agent-2', { projectPath: '/test', orchestrator: 'claude-code', runtime: 'pty' });
    mockIsRunning.mockImplementation((id: string) => id === 'agent-2');

    bindingManager.bind('agent-1', {
      targetId: project.id, targetKind: 'group-project', label: 'PN', agentName: 'robin', targetName: 'PollNudge',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id, targetKind: 'group-project', label: 'PN', agentName: 'falcon', targetName: 'PollNudge',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'PollNudge' });
    const result = await callTool('agent-1', buildToolName(binding, 'nudge_polling'), { target_agent_id: 'agent-2' });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.action).toBe('nudge_polling');
    expect(parsed.delivered).toBe(true);

    const nudgeWrite = mockPtyWrite.mock.calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('nudge'),
    );
    expect(nudgeWrite).toBeDefined();
    expect(nudgeWrite![0]).toBe('agent-2');

    // The setting is NOT changed by a nudge
    const persisted = await groupProjectRegistry.get(project.id);
    expect(persisted?.metadata?.pollingEnabled).toBeFalsy();

    agentRegistry.untrack('agent-2');
  });

  it('nudge_polling returns error for sleeping agent', async () => {
    const project = await groupProjectRegistry.create('NudgeSleep');

    bindingManager.bind('agent-1', {
      targetId: project.id, targetKind: 'group-project', label: 'NS', agentName: 'robin', targetName: 'NudgeSleep',
    });
    bindingManager.bind('agent-2', {
      targetId: project.id, targetKind: 'group-project', label: 'NS', agentName: 'falcon', targetName: 'NudgeSleep',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'NudgeSleep' });
    const result = await callTool('agent-1', buildToolName(binding, 'nudge_polling'), { target_agent_id: 'agent-2' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('sleeping');
  });

  /* ---------- read_message tool ---------- */

  it('read_message returns a single message by ID', async () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_123', targetName: 'GP' });
    const postName = buildToolName(binding, 'post_bulletin');
    const postResult = await callTool('agent-1', postName, { topic: 'progress', body: 'Detailed update here' });
    const { messageId } = JSON.parse(postResult.content[0].text!);

    const readName = buildToolName(binding, 'read_message');
    const result = await callTool('agent-1', readName, { message_id: messageId });

    expect(result.isError).toBeFalsy();
    const msg = JSON.parse(result.content[0].text!);
    expect(msg.id).toBe(messageId);
    expect(msg.body).toBe('Detailed update here');
  });

  it('read_message returns error for unknown ID', async () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_123', targetName: 'GP' });
    const readName = buildToolName(binding, 'read_message');
    const result = await callTool('agent-1', readName, { message_id: 'msg_nonexistent' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  /* ---------- read_topic summary mode ---------- */

  it('read_topic with summary=true truncates long bodies', async () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_123', targetName: 'GP' });
    const postName = buildToolName(binding, 'post_bulletin');
    const longBody = 'x'.repeat(500);
    await callTool('agent-1', postName, { topic: 'verbose', body: longBody });
    await callTool('agent-1', postName, { topic: 'verbose', body: 'short' });

    const readName = buildToolName(binding, 'read_topic');
    const result = await callTool('agent-1', readName, { topic: 'verbose', summary: true });

    expect(result.isError).toBeFalsy();
    const messages = JSON.parse(result.content[0].text!);
    expect(messages).toHaveLength(2);

    // Long message should be truncated
    const longMsg = messages.find((m: any) => m.truncated === true);
    expect(longMsg).toBeDefined();
    expect(longMsg.body.length).toBeLessThanOrEqual(203); // 200 + '...'
    expect(longMsg.body.endsWith('...')).toBe(true);

    // Short message should be unchanged
    const shortMsg = messages.find((m: any) => m.body === 'short');
    expect(shortMsg).toBeDefined();
    expect(shortMsg.truncated).toBe(false);
  });

  /* ---------- Compact JSON responses ---------- */

  it('read_bulletin returns compact JSON (no pretty-printing)', async () => {
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: 'gp_123', targetName: 'GP' });
    const postName = buildToolName(binding, 'post_bulletin');
    await callTool('agent-1', postName, { topic: 'test', body: 'hello' });

    const readName = buildToolName(binding, 'read_bulletin');
    const result = await callTool('agent-1', readName, {});

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text!;
    // Compact JSON should NOT contain newlines
    expect(text).not.toContain('\n');
  });

  /* ---------- Agent deletion tools ---------- */

  it('clear_topic and delete_messages are available to an admin (message curation)', () => {
    groupProjectRegistry._setForTesting({
      id: 'gp_123', name: 'GP', description: '', instructions: '',
      createdAt: '2020-01-01T00:00:00Z', metadata: { admins: ['agent-1'] },
    });
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
      targetName: 'GP',
    });

    const tools = getScopedToolList('agent-1');
    const suffixes = tools.map(t => t.name.split('__').pop());
    expect(suffixes).toContain('clear_topic');
    expect(suffixes).toContain('delete_messages');
  });

  it('clear_topic deletes a topic and returns result', async () => {
    const project = await groupProjectRegistry.create('ClearProj');

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'CP',
      agentName: 'robin',
      targetName: 'ClearProj',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'ClearProj' });

    // Post some messages first
    const postName = buildToolName(binding, 'post_bulletin');
    await callTool('agent-1', postName, { topic: 'old-stuff', body: 'msg1' });
    await callTool('agent-1', postName, { topic: 'old-stuff', body: 'msg2' });

    // Clear the topic
    const clearName = buildToolName(binding, 'clear_topic');
    const result = await callTool('agent-1', clearName, { topic: 'old-stuff' });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.deleted).toBe(true);

    // Verify topic is gone
    const readName = buildToolName(binding, 'read_topic');
    const readResult = await callTool('agent-1', readName, { topic: 'old-stuff' });
    const messages = JSON.parse(readResult.content[0].text!);
    expect(messages).toHaveLength(0);
  });

  it('clear_topic rejects system topic', async () => {
    const project = await groupProjectRegistry.create('SysProj');

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'SP',
      agentName: 'robin',
      targetName: 'SysProj',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'SysProj' });
    const clearName = buildToolName(binding, 'clear_topic');
    const result = await callTool('agent-1', clearName, { topic: 'system' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('system');
  });

  it('delete_messages removes specific messages by ID', async () => {
    const project = await groupProjectRegistry.create('DelMsgProj');

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'DM',
      agentName: 'robin',
      targetName: 'DelMsgProj',
    });

    const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'DelMsgProj' });
    const postName = buildToolName(binding, 'post_bulletin');

    await callTool('agent-1', postName, { topic: 'cleanup', body: 'keep me' });
    const r2 = await callTool('agent-1', postName, { topic: 'cleanup', body: 'delete me' });
    const r3 = await callTool('agent-1', postName, { topic: 'cleanup', body: 'delete me too' });

    const id2 = JSON.parse(r2.content[0].text!).messageId;
    const id3 = JSON.parse(r3.content[0].text!).messageId;

    const delName = buildToolName(binding, 'delete_messages');
    const result = await callTool('agent-1', delName, {
      topic: 'cleanup',
      message_ids: [id2, id3],
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.deleted).toBe(2);
    expect(parsed.requested).toBe(2);

    // Verify only first message remains
    const readName = buildToolName(binding, 'read_topic');
    const readResult = await callTool('agent-1', readName, { topic: 'cleanup' });
    const remaining = JSON.parse(readResult.content[0].text!);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].body).toBe('keep me');
  });

  describe('set_project_info', () => {
    it('updates description and instructions for an admin', async () => {
      const project = await groupProjectRegistry.create('InfoEditProj');
      await groupProjectRegistry.update(project.id, { metadata: { admins: ['agent-1'] } });
      bindingManager.bind('agent-1', {
        targetId: project.id, targetKind: 'group-project', label: 'IE', agentName: 'lead', targetName: 'InfoEditProj',
      });

      const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'InfoEditProj' });
      const name = buildToolName(binding, 'set_project_info');
      const result = await callTool('agent-1', name, {
        description: 'New purpose', instructions: 'Follow these rules',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.description).toBe('New purpose');
      expect(parsed.instructions).toBe('Follow these rules');
      const updated = await groupProjectRegistry.get(project.id);
      expect(updated?.description).toBe('New purpose');
      expect(updated?.instructions).toBe('Follow these rules');
    });

    it('leaves omitted fields unchanged', async () => {
      const project = await groupProjectRegistry.create('PartialProj');
      await groupProjectRegistry.update(project.id, {
        description: 'orig desc', instructions: 'orig instr', metadata: { admins: ['agent-1'] },
      });
      bindingManager.bind('agent-1', {
        targetId: project.id, targetKind: 'group-project', label: 'PP', agentName: 'lead', targetName: 'PartialProj',
      });

      const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'PartialProj' });
      const name = buildToolName(binding, 'set_project_info');
      await callTool('agent-1', name, { instructions: 'updated instr' });

      const updated = await groupProjectRegistry.get(project.id);
      expect(updated?.description).toBe('orig desc');
      expect(updated?.instructions).toBe('updated instr');
    });

    it('is rejected for a non-admin caller (defense in depth)', async () => {
      const project = await groupProjectRegistry.create('GuardProj');
      await groupProjectRegistry.update(project.id, { metadata: { admins: ['someone-else'] } });
      bindingManager.bind('agent-1', {
        targetId: project.id, targetKind: 'group-project', label: 'GP', agentName: 'member', targetName: 'GuardProj',
      });

      const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'GuardProj' });
      const name = buildToolName(binding, 'set_project_info');
      const result = await callTool('agent-1', name, { description: 'hijack' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('admin');
    });

    it('is hidden from a non-admin’s scoped tool list', () => {
      groupProjectRegistry._setForTesting({
        id: 'gp_hidden', name: 'H', description: '', instructions: '',
        createdAt: '2020-01-01T00:00:00Z', metadata: { admins: ['someone-else'] },
      });
      bindingManager.bind('agent-1', {
        targetId: 'gp_hidden', targetKind: 'group-project', label: 'H', agentName: 'member',
      });
      const suffixes = getScopedToolList('agent-1').map(t => t.name.split('__').pop());
      expect(suffixes).not.toContain('set_project_info');
    });
  });

  describe('clear_agent', () => {
    it('injects /clear into connected agent PTY', async () => {
      const project = await groupProjectRegistry.create('ClearProj');
      bindingManager.bind('agent-1', {
        targetId: project.id,
        targetKind: 'group-project',
        label: 'GP',
        agentName: 'robin',
        targetName: 'ClearProj',
      });
      bindingManager.bind('agent-2', {
        targetId: project.id,
        targetKind: 'group-project',
        label: 'GP',
        agentName: 'falcon',
        targetName: 'ClearProj',
      });
      mockIsRunning.mockReturnValue(true);
      agentRegistry.register('agent-2', { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' });

      const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'ClearProj' });
      const toolName = buildToolName(binding, 'clear_agent');
      const result = await callTool('agent-1', toolName, { target_agent_id: 'agent-2' });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.action).toBe('clear');
      expect(parsed.delivered).toBe(true);
      expect(mockPtyWrite).toHaveBeenCalledWith('agent-2', '/clear');
      agentRegistry.untrack('agent-2');
    });

    it('returns error when target is not a member', async () => {
      const project = await groupProjectRegistry.create('ClearProj2');
      bindingManager.bind('agent-1', {
        targetId: project.id, targetKind: 'group-project', label: 'GP', agentName: 'robin',
      });

      const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, label: 'GP' });
      const toolName = buildToolName(binding, 'clear_agent');
      const result = await callTool('agent-1', toolName, { target_agent_id: 'not-a-member' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not a member');
    });

    it('returns error when target is sleeping', async () => {
      const project = await groupProjectRegistry.create('ClearProj3');
      bindingManager.bind('agent-1', {
        targetId: project.id, targetKind: 'group-project', label: 'GP', agentName: 'robin',
      });
      bindingManager.bind('agent-2', {
        targetId: project.id, targetKind: 'group-project', label: 'GP', agentName: 'falcon',
      });
      // agent-2 not in agentRegistry = sleeping

      const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, label: 'GP' });
      const toolName = buildToolName(binding, 'clear_agent');
      const result = await callTool('agent-1', toolName, { target_agent_id: 'agent-2' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sleeping');
    });
  });

  describe('compact_agent', () => {
    it('injects /compact into connected agent PTY', async () => {
      const project = await groupProjectRegistry.create('CompactProj');
      bindingManager.bind('agent-1', {
        targetId: project.id,
        targetKind: 'group-project',
        label: 'GP',
        agentName: 'robin',
        targetName: 'CompactProj',
      });
      bindingManager.bind('agent-2', {
        targetId: project.id,
        targetKind: 'group-project',
        label: 'GP',
        agentName: 'falcon',
        targetName: 'CompactProj',
      });
      mockIsRunning.mockReturnValue(true);
      agentRegistry.register('agent-2', { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' });

      const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, targetName: 'CompactProj' });
      const toolName = buildToolName(binding, 'compact_agent');
      const result = await callTool('agent-1', toolName, { target_agent_id: 'agent-2' });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.action).toBe('compact');
      expect(parsed.delivered).toBe(true);
      expect(mockPtyWrite).toHaveBeenCalledWith('agent-2', '/compact');
      agentRegistry.untrack('agent-2');
    });

    it('returns error when target is sleeping', async () => {
      const project = await groupProjectRegistry.create('CompactProj2');
      bindingManager.bind('agent-1', {
        targetId: project.id, targetKind: 'group-project', label: 'GP', agentName: 'robin',
      });
      bindingManager.bind('agent-2', {
        targetId: project.id, targetKind: 'group-project', label: 'GP', agentName: 'falcon',
      });
      // agent-2 sleeping

      const binding = makeBinding({ agentId: 'agent-1', targetId: project.id, label: 'GP' });
      const toolName = buildToolName(binding, 'compact_agent');
      const result = await callTool('agent-1', toolName, { target_agent_id: 'agent-2' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sleeping');
    });
  });

});
