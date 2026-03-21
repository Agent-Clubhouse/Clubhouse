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

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

const mockPtyWrite = vi.fn();
vi.mock('./pty-manager', () => ({
  write: (...args: unknown[]) => mockPtyWrite(...args),
}));

const mockGetAgentOrchestrator = vi.fn<(id: string) => string | undefined>(() => undefined);
vi.mock('./agent-registry', () => ({
  getAgentOrchestrator: (...args: unknown[]) => mockGetAgentOrchestrator(args[0] as string),
}));

const mockGetProvider = vi.fn(() => undefined);
vi.mock('../orchestrators/registry', () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(args[0]),
}));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { getBulletinBoard, _resetAllBoardsForTesting } from './group-project-bulletin';
import { groupProjectRegistry } from './group-project-registry';
import { initGroupProjectLifecycle, _resetLifecycleForTesting } from './group-project-lifecycle';

describe('GroupProjectLifecycle', () => {
  beforeEach(() => {
    store.clear();
    mockPtyWrite.mockClear();
    mockGetAgentOrchestrator.mockReturnValue(undefined);
    mockGetProvider.mockReturnValue(undefined);
    bindingManager._resetForTesting();
    _resetAllBoardsForTesting();
    _resetLifecycleForTesting();
  });

  it('posts join event when agent binds to group project', async () => {
    initGroupProjectLifecycle();

    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    // Wait for async lifecycle handler
    await new Promise(r => setTimeout(r, 50));

    const board = getBulletinBoard('gp_123');
    const messages = await board.getTopicMessages('system');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe('system');
    expect(messages[0].body).toContain('robin');
    expect(messages[0].body).toContain('joined');
  });

  it('posts leave event when agent unbinds from group project', async () => {
    initGroupProjectLifecycle();

    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    await new Promise(r => setTimeout(r, 50));

    bindingManager.unbind('agent-1', 'gp_123');

    await new Promise(r => setTimeout(r, 50));

    const board = getBulletinBoard('gp_123');
    const messages = await board.getTopicMessages('system');
    expect(messages).toHaveLength(2);
    expect(messages[1].body).toContain('robin');
    expect(messages[1].body).toContain('left');
  });

  it('is idempotent — does not double-post on repeated calls', async () => {
    initGroupProjectLifecycle();
    initGroupProjectLifecycle(); // second call should be no-op

    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    await new Promise(r => setTimeout(r, 50));

    const board = getBulletinBoard('gp_123');
    const messages = await board.getTopicMessages('system');
    expect(messages).toHaveLength(1);
  });

  it('injects welcome message into agent PTY on join', async () => {
    initGroupProjectLifecycle();

    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    await new Promise(r => setTimeout(r, 250));

    // Should have called ptyManager.write with bracketed paste for welcome
    expect(mockPtyWrite).toHaveBeenCalled();
    const calls = mockPtyWrite.mock.calls;
    const welcomeCall = calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('GROUP_PROJECT_JOINED'),
    );
    expect(welcomeCall).toBeDefined();
    expect(welcomeCall![0]).toBe('agent-1');
    // Should use bracketed paste
    expect(welcomeCall![1]).toContain('\x1b[200~');
    expect(welcomeCall![1]).toContain('\x1b[201~');
  });

  it('injects polling instruction on join when polling is enabled', async () => {
    // Set up a project with polling enabled
    await groupProjectRegistry.create('Test Project');
    const projects = await groupProjectRegistry.list();
    const project = projects[0];
    await groupProjectRegistry.update(project.id, { metadata: { pollingEnabled: true } });

    initGroupProjectLifecycle();

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    // Wait for welcome + polling delay (500ms) + processing
    await new Promise(r => setTimeout(r, 800));

    const calls = mockPtyWrite.mock.calls;
    const pollingCall = calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('POLLING_START'),
    );
    expect(pollingCall).toBeDefined();
    expect(pollingCall![0]).toBe('agent-1');
  });

  it('uses orchestrator-specific paste timing for PTY injection', async () => {
    // Simulate a Copilot CLI agent with 500ms paste timing
    mockGetAgentOrchestrator.mockReturnValue('copilot-cli');
    mockGetProvider.mockReturnValue({
      getPasteSubmitTiming: () => ({ initialDelayMs: 500, retryDelayMs: 500, finalCheckDelayMs: 300 }),
    });

    initGroupProjectLifecycle();

    bindingManager.bind('agent-ghcp', {
      targetId: 'gp_456',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'copilot-bot',
    });

    // Welcome message should fire immediately (bracketed paste)
    await new Promise(r => setTimeout(r, 50));
    const welcomeCall = mockPtyWrite.mock.calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('GROUP_PROJECT_JOINED'),
    );
    expect(welcomeCall).toBeDefined();

    // Enter keystroke should NOT have fired yet at 200ms (would with default 200ms timing)
    // but should fire after 500ms
    mockPtyWrite.mockClear();
    await new Promise(r => setTimeout(r, 200));
    const earlyEnter = mockPtyWrite.mock.calls.find(
      (c: unknown[]) => c[1] === '\r',
    );
    // At 250ms total, the 500ms timeout hasn't fired yet
    expect(earlyEnter).toBeUndefined();

    await new Promise(r => setTimeout(r, 400));
    const lateEnter = mockPtyWrite.mock.calls.find(
      (c: unknown[]) => c[1] === '\r',
    );
    expect(lateEnter).toBeDefined();
  });

  it('does not inject polling instruction when polling is disabled', async () => {
    initGroupProjectLifecycle();

    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    await new Promise(r => setTimeout(r, 800));

    const calls = mockPtyWrite.mock.calls;
    const pollingCall = calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('POLLING_START'),
    );
    expect(pollingCall).toBeUndefined();
  });
});
