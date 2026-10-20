import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron app
const mockIsStopping = vi.hoisted(() => vi.fn((_id?: unknown) => false));
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
  isStopping: (...args: unknown[]) => mockIsStopping(...args),
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
import { ATTR } from '../../shared/telemetry/attributes';
import { setProducingRuntime } from '../telemetry/__test-utils__/producing-runtime';
import type { Classification, TelemetryRuntime } from '../telemetry/types';

describe('executeShoulderTap', () => {
  beforeEach(() => {
    store.clear();
    mockPtyWrite.mockClear();
    mockGetBuffer.mockClear();
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

  it('reports a terminal agent that is shutting down as not running, writing nothing', async () => {
    const project = await groupProjectRegistry.create('StoppingProj');
    agentRegistry.register('agent-1', { projectPath: '/test', orchestrator: 'claude-code', runtime: 'pty' });
    bindingManager.bind('agent-1', { targetId: project.id, targetKind: 'group-project', label: 'StoppingProj', agentName: 'robin', targetName: 'StoppingProj' });
    mockIsStopping.mockReturnValue(true);
    try {
      const result = await executeShoulderTap({ projectId: project.id, senderLabel: 'user', targetAgentId: 'agent-1', message: 'hi' });
      expect(result.delivered).toHaveLength(0);
      expect(result.failed).toEqual([expect.objectContaining({ agentId: 'agent-1', status: 'not-running' })]);
      expect(mockPtyWrite).not.toHaveBeenCalled();
    } finally {
      mockIsStopping.mockReturnValue(false);
      agentRegistry.untrack('agent-1');
    }
  });

  it('reports unsupported-runtime for headless agents', async () => {
    const project = await groupProjectRegistry.create('HeadlessProj');

    agentRegistry.register('agent-h', {
      projectPath: '/test',
      orchestrator: 'claude-code',
      runtime: 'headless',
    });

    bindingManager.bind('agent-h', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'HeadlessProj',
      agentName: 'falcon',
      targetName: 'HeadlessProj',
    });

    const result = await executeShoulderTap({
      projectId: project.id,
      senderLabel: 'user',
      targetAgentId: 'agent-h',
      message: 'Urgent request',
    });

    expect(result.delivered).toHaveLength(0);
    expect(result.failed).toEqual([
      expect.objectContaining({ agentId: 'agent-h', status: 'unsupported-runtime' }),
    ]);
    expect(mockPtyWrite).not.toHaveBeenCalled();

    agentRegistry.untrack('agent-h');
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

  it('records an undelivered tap and its not_running delivery', async () => {
    const project = await groupProjectRegistry.create('GhostProj2');
    bindingManager.bind('agent-ghost2', {
      targetId: project.id, targetKind: 'group-project', label: 'GhostProj2', agentName: 'ghost2', targetName: 'GhostProj2',
    });
    const count = vi.fn();
    const outcomes: Array<{ name: string; attrs: unknown[]; outcome: Classification }> = [];
    setProducingRuntime({
      level: 'standard',
      count,
      flow: (name: string, opts: { attrs?: unknown[] }, fn: (s: { set: (...a: unknown[]) => void }) => Promise<unknown>, extras?: { classify?: (r: unknown) => Classification }) => {
        const attrs = [...(opts.attrs ?? [])];
        const result = fn({ set: (...a) => attrs.push(...a) });
        void result.then((r) => outcomes.push({ name, attrs, outcome: extras?.classify ? extras.classify(r) : 'ok' }));
        return result;
      },
    } as unknown as TelemetryRuntime);
    try {
      await executeShoulderTap({ projectId: project.id, senderLabel: 'user', targetAgentId: 'agent-ghost2', message: 'Hi' });
      await Promise.resolve();
      expect(outcomes).toEqual([{
        name: 'clubhouse.group.shoulder_tap',
        attrs: [ATTR.tapBroadcast(false), ATTR.targetsCount(1)],
        outcome: { error: 'tap_undelivered' },
      }]);
      expect(count).toHaveBeenCalledWith('clubhouse.group.shoulder_tap.deliveries', 1, [ATTR.deliveryResult('not_running')]);
    } finally {
      setProducingRuntime(null);
    }
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
