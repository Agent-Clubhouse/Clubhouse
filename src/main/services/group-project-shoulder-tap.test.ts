import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron app
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/test-clubhouse',
  },
}));

// Mock fs/promises — in-memory store
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

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

const mockPtyWrite = vi.fn();
vi.mock('./pty-manager', () => ({
  write: (...args: unknown[]) => mockPtyWrite(...args),
  getBuffer: vi.fn(() => ''),
}));

const mockStructuredSend = vi.fn().mockResolvedValue(undefined);
vi.mock('./structured-manager', () => ({
  sendMessage: (...args: unknown[]) => mockStructuredSend(...args),
}));

import { agentRegistry } from './agent-registry';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { _resetAllBoardsForTesting, getBulletinBoard } from './group-project-bulletin';
import { groupProjectRegistry } from './group-project-registry';
import { _resetForTesting as resetToolRegistry } from './clubhouse-mcp/tool-registry';
import { registerGroupProjectTools } from './clubhouse-mcp/tools/group-project-tools';
import { executeShoulderTap } from './group-project-shoulder-tap';

describe('executeShoulderTap', () => {
  beforeEach(() => {
    store.clear();
    mockPtyWrite.mockClear();
    mockStructuredSend.mockClear();
    bindingManager._resetForTesting();
    _resetAllBoardsForTesting();
    groupProjectRegistry._resetForTesting();
    resetToolRegistry();
    registerGroupProjectTools();
  });

  it('delivers PTY tap with bracketed paste and submit', async () => {
    // Create project
    const project = await groupProjectRegistry.create('TestProj');

    // Register agent
    agentRegistry.register('agent-1', {
      projectPath: '/test',
      orchestrator: 'claude-code',
      runtime: 'pty',
    });

    // Bind agent to project
    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'TestProj',
      agentName: 'robin',
      targetName: 'TestProj',
    });

    const result = await executeShoulderTap({
      projectId: project.id,
      senderLabel: 'user',
      targetAgentId: 'agent-1',
      message: 'Please check the config file',
    });

    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0].agentId).toBe('agent-1');
    expect(result.delivered[0].status).toBe('delivered');
    expect(result.failed).toHaveLength(0);
    expect(result.taskId).toMatch(/^tap_/);
    expect(result.messageId).toMatch(/^msg_/);

    // PTY write should use bracketed paste
    expect(mockPtyWrite).toHaveBeenCalled();
    const firstCall = mockPtyWrite.mock.calls[0];
    expect(firstCall[0]).toBe('agent-1');
    expect(firstCall[1]).toContain('\x1b[200~');
    expect(firstCall[1]).toContain('Group Project notification');
    expect(firstCall[1]).toContain('Please check the config file');
    expect(firstCall[1]).toContain('RESPONSE INSTRUCTIONS');
    expect(firstCall[1]).toContain('\x1b[201~');

    // Should also send \r for submit
    await new Promise(r => setTimeout(r, 150));
    expect(mockPtyWrite).toHaveBeenCalledWith('agent-1', '\r');

    // Cleanup
    agentRegistry.untrack('agent-1');
  });

  it('delivers to structured agents', async () => {
    const project = await groupProjectRegistry.create('StructProj');

    agentRegistry.register('agent-s', {
      projectPath: '/test',
      orchestrator: 'claude-code',
      runtime: 'structured',
    });

    bindingManager.bind('agent-s', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'StructProj',
      agentName: 'falcon',
      targetName: 'StructProj',
    });

    const result = await executeShoulderTap({
      projectId: project.id,
      senderLabel: 'user',
      targetAgentId: 'agent-s',
      message: 'Urgent request',
    });

    expect(result.delivered).toHaveLength(1);
    expect(mockStructuredSend).toHaveBeenCalledWith('agent-s', expect.stringContaining('Group Project notification'));

    agentRegistry.untrack('agent-s');
  });

  it('reports not-running when agent is not registered', async () => {
    const project = await groupProjectRegistry.create('GhostProj');

    // Bind but do NOT register in agentRegistry
    bindingManager.bind('agent-ghost', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'GhostProj',
      agentName: 'ghost',
      targetName: 'GhostProj',
    });

    const result = await executeShoulderTap({
      projectId: project.id,
      senderLabel: 'user',
      targetAgentId: 'agent-ghost',
      message: 'Hello?',
    });

    expect(result.delivered).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].status).toBe('not-running');
  });

  it('broadcasts to all members (excluding sender)', async () => {
    const project = await groupProjectRegistry.create('BroadcastProj');

    agentRegistry.register('agent-a', { projectPath: '/a', orchestrator: 'claude-code', runtime: 'pty' });
    agentRegistry.register('agent-b', { projectPath: '/b', orchestrator: 'claude-code', runtime: 'pty' });

    bindingManager.bind('agent-a', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'BP',
      agentName: 'robin',
      targetName: 'BroadcastProj',
      projectName: 'myapp',
    });
    bindingManager.bind('agent-b', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'BP',
      agentName: 'falcon',
      targetName: 'BroadcastProj',
      projectName: 'myapp',
    });

    // Broadcast from robin
    const result = await executeShoulderTap({
      projectId: project.id,
      senderLabel: 'robin@myapp',
      targetAgentId: null,
      message: 'Hey everyone',
    });

    // Should deliver to falcon only (robin is the sender)
    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0].agentName).toBe('falcon');

    agentRegistry.untrack('agent-a');
    agentRegistry.untrack('agent-b');
  });

  it('records tap to shoulder-tap bulletin topic', async () => {
    const project = await groupProjectRegistry.create('RecordProj');

    agentRegistry.register('agent-r', { projectPath: '/r', orchestrator: 'claude-code', runtime: 'pty' });
    bindingManager.bind('agent-r', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'RP',
      agentName: 'robin',
      targetName: 'RecordProj',
    });

    await executeShoulderTap({
      projectId: project.id,
      senderLabel: 'user',
      targetAgentId: 'agent-r',
      message: 'Check this out',
    });

    const board = getBulletinBoard(project.id);
    const messages = await board.getTopicMessages('shoulder-tap');
    expect(messages).toHaveLength(1);
    const body = JSON.parse(messages[0].body);
    expect(body.from).toBe('user');
    expect(body.to).toBe('agent-r');
    expect(body.message).toBe('Check this out');

    agentRegistry.untrack('agent-r');
  });
});
