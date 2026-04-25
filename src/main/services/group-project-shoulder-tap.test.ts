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

vi.mock('../orchestrators', () => ({
  getProvider: vi.fn(() => undefined), // Falls back to default timing
}));

const mockPtyWrite = vi.fn();
const mockGetBuffer = vi.fn(() => '');
vi.mock('./pty-manager', () => ({
  write: (...args: unknown[]) => mockPtyWrite(...args),
  getBuffer: (...args: unknown[]) => mockGetBuffer(...args),
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
import { mcpAdapter } from './clubhouse-mcp/mcp-adapter';
import { commandRegistry } from '../../shared/command-registry';
import { registerGroupProjectTools } from './clubhouse-mcp/tools/group-project-tools';
import { executeShoulderTap } from './group-project-shoulder-tap';

describe('executeShoulderTap', () => {
  beforeEach(() => {
    store.clear();
    mockPtyWrite.mockClear();
    mockGetBuffer.mockClear();
    mockStructuredSend.mockClear();
    bindingManager._resetForTesting();
    _resetAllBoardsForTesting();
    groupProjectRegistry._resetForTesting();
    resetToolRegistry();
    mcpAdapter._resetForTesting();
    commandRegistry.clear();
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
    // Shoulder tap is ephemeral — no bulletin audit record is produced.
    expect((result as Record<string, unknown>).messageId).toBeUndefined();

    // PTY write should use chunked bracketed paste (separate writes for markers)
    expect(mockPtyWrite).toHaveBeenCalled();
    const allWrites = mockPtyWrite.mock.calls.map((c: unknown[]) => c[1] as string);
    // Start marker sent separately
    expect(allWrites[0]).toBe('\x1b[200~');
    // Body contains the message content
    const bodyWrites = allWrites.filter(
      (w: string) => w !== '\x1b[200~' && w !== '\x1b[201~' && w !== '\r',
    );
    const fullBody = bodyWrites.join('');
    expect(fullBody).toContain('Group Project notification');
    expect(fullBody).toContain('Please check the config file');
    expect(fullBody).toContain('RESPONSE INSTRUCTIONS');
    // End marker sent separately
    expect(allWrites).toContain('\x1b[201~');
    // Submit Enter was sent
    expect(allWrites).toContain('\r');

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

  it('does NOT record tap to any bulletin channel (ephemeral)', async () => {
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
    // Legacy "shoulder-tap" topic should not exist.
    expect(await board.getTopicMessages('shoulder-tap')).toEqual([]);
    // Digest should only show the auto-seeded protected channels and the
    // inbox channel for the bound agent — no shoulder-tap channel.
    const digest = await board.getDigest();
    const topics = digest.map(d => d.topic).sort();
    expect(topics).not.toContain('shoulder-tap');
    expect(topics).toContain('general');
    expect(topics).toContain('control');

    agentRegistry.untrack('agent-r');
  });

  it('injected message points reply at sender inbox when sender is an agent', async () => {
    const project = await groupProjectRegistry.create('ReplyProj');
    agentRegistry.register('agent-x', { projectPath: '/x', orchestrator: 'claude-code', runtime: 'pty' });
    bindingManager.bind('agent-x', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'RP',
      agentName: 'falcon',
      targetName: 'ReplyProj',
      projectName: 'myapp',
    });

    await executeShoulderTap({
      projectId: project.id,
      senderLabel: 'robin@myapp',
      targetAgentId: 'agent-x',
      message: 'ping',
    });

    const bodyWrites = mockPtyWrite.mock.calls.map((c: unknown[]) => c[1] as string);
    const fullBody = bodyWrites.join('');
    expect(fullBody).toContain('inbox-robin');
    expect(fullBody).toContain('ephemeral');

    agentRegistry.untrack('agent-x');
  });
});
