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
const mockIsRunning = vi.fn().mockReturnValue(false);
vi.mock('./pty-manager', () => ({
  write: (...args: unknown[]) => mockPtyWrite(...args),
  isRunning: (...args: unknown[]) => mockIsRunning(...args),
}));

const mockGetAgentOrchestrator = vi.fn<(id: string) => string | undefined>(() => undefined);
vi.mock('./agent-registry', () => {
  const registrations = new Map<string, unknown>();
  return {
    agentRegistry: {
      get: (id: string) => registrations.get(id),
      register: (id: string, reg: unknown) => registrations.set(id, reg),
      untrack: (id: string) => registrations.delete(id),
    },
    getAgentOrchestrator: (...args: unknown[]) => mockGetAgentOrchestrator(args[0] as string),
  };
});

const mockGetProvider = vi.fn(() => undefined);
vi.mock('../orchestrators/registry', () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(args[0]),
}));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { getBulletinBoard, _resetAllBoardsForTesting } from './group-project-bulletin';
import { groupProjectRegistry } from './group-project-registry';
import { agentRegistry } from './agent-registry';
import {
  initGroupProjectLifecycle,
  _resetLifecycleForTesting,
  _recentLeavesForTesting,
} from './group-project-lifecycle';

describe('GroupProjectLifecycle', () => {
  beforeEach(() => {
    store.clear();
    mockPtyWrite.mockClear();
    mockIsRunning.mockReturnValue(false);
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
    // Should include project identifier (falls back to ID when project not in registry)
    expect(messages[0].body).toContain('gp_123');
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
    // Should include project identifier
    expect(messages[1].body).toContain('gp_123');
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
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Group Project notification'),
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
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Group Project notification') && (c[1] as string).includes('Poll the bulletin'),
    );
    expect(pollingCall).toBeDefined();
    expect(pollingCall![0]).toBe('agent-1');
  });

  it('uses orchestrator-specific paste timing for PTY injection', async () => {
    // Simulate a Copilot CLI agent with 800ms paste timing
    mockGetAgentOrchestrator.mockReturnValue('copilot-cli');
    mockGetProvider.mockReturnValue({
      getPasteSubmitTiming: () => ({ initialDelayMs: 800, retryDelayMs: 600, finalCheckDelayMs: 400 }),
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
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Group Project notification'),
    );
    expect(welcomeCall).toBeDefined();

    // Enter keystroke should NOT have fired yet at 200ms (would with default 200ms timing)
    // but should fire after 800ms
    mockPtyWrite.mockClear();
    await new Promise(r => setTimeout(r, 200));
    const earlyEnter = mockPtyWrite.mock.calls.find(
      (c: unknown[]) => c[1] === '\r',
    );
    // At 250ms total, the 800ms timeout hasn't fired yet
    expect(earlyEnter).toBeUndefined();

    await new Promise(r => setTimeout(r, 700));
    const lateEnter = mockPtyWrite.mock.calls.find(
      (c: unknown[]) => c[1] === '\r',
    );
    expect(lateEnter).toBeDefined();
  });

  it('includes project name in welcome message when project exists', async () => {
    const project = await groupProjectRegistry.create('Alpha Squad');

    initGroupProjectLifecycle();

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    await new Promise(r => setTimeout(r, 250));

    // Welcome PTY message should include the project name
    const calls = mockPtyWrite.mock.calls;
    const welcomeCall = calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Group Project notification'),
    );
    expect(welcomeCall).toBeDefined();
    expect(welcomeCall![1]).toContain('"Alpha Squad"');

    // Join bulletin message should include project name
    const board = getBulletinBoard(project.id);
    const messages = await board.getTopicMessages('system');
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain('Alpha Squad');
  });

  it('includes project name in polling start message', async () => {
    const project = await groupProjectRegistry.create('Beta Team');
    await groupProjectRegistry.update(project.id, { metadata: { pollingEnabled: true } });

    initGroupProjectLifecycle();

    bindingManager.bind('agent-1', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });

    await new Promise(r => setTimeout(r, 800));

    const calls = mockPtyWrite.mock.calls;
    const pollingCall = calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Group Project notification') && (c[1] as string).includes('bulletin'),
    );
    expect(pollingCall).toBeDefined();
    expect(pollingCall![1]).toContain('"Beta Team"');
  });

  it('sends Claude Code-specific polling instruction with /loop', async () => {
    const project = await groupProjectRegistry.create('CC Project');
    await groupProjectRegistry.update(project.id, { metadata: { pollingEnabled: true } });

    // Simulate a Claude Code agent
    mockGetAgentOrchestrator.mockReturnValue('claude-code');

    initGroupProjectLifecycle();

    bindingManager.bind('agent-cc', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'claude-bot',
    });

    await new Promise(r => setTimeout(r, 800));

    const calls = mockPtyWrite.mock.calls;
    const pollingCall = calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('/loop'),
    );
    expect(pollingCall).toBeDefined();
    expect(pollingCall![1]).toContain('"CC Project"');
    expect(pollingCall![1]).toContain('read_bulletin');
  });

  it('sends generic polling instruction for non-claude orchestrators', async () => {
    const project = await groupProjectRegistry.create('Codex Project');
    await groupProjectRegistry.update(project.id, { metadata: { pollingEnabled: true } });

    // Simulate a Codex CLI agent
    mockGetAgentOrchestrator.mockReturnValue('codex-cli');

    initGroupProjectLifecycle();

    bindingManager.bind('agent-codex', {
      targetId: project.id,
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'codex-bot',
    });

    await new Promise(r => setTimeout(r, 800));

    const calls = mockPtyWrite.mock.calls;
    const pollingCall = calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Group Project notification') && (c[1] as string).includes('bulletin'),
    );
    expect(pollingCall).toBeDefined();
    expect(pollingCall![1]).not.toContain('/loop');
    expect(pollingCall![1]).toContain('read_bulletin');
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
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Group Project notification') && (c[1] as string).includes('Poll the bulletin'),
    );
    expect(pollingCall).toBeUndefined();
  });

  it('suppresses spurious rejoin when agent is not running', async () => {
    initGroupProjectLifecycle();

    // Agent joins
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });
    await new Promise(r => setTimeout(r, 50));

    // Agent leaves
    bindingManager.unbind('agent-1', 'gp_123');
    await new Promise(r => setTimeout(r, 50));

    // Spurious re-bind (e.g., from canvas wire restore) — agent is NOT running
    mockIsRunning.mockReturnValue(false);
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });
    await new Promise(r => setTimeout(r, 50));

    const board = getBulletinBoard('gp_123');
    const messages = await board.getTopicMessages('system');
    // Should have: joined, left — but NOT a second join
    expect(messages).toHaveLength(2);
    expect(messages[0].body).toContain('joined');
    expect(messages[1].body).toContain('left');

    // The stale binding should have been retracted
    const bindings = bindingManager.getBindingsForAgent('agent-1');
    const gpBindings = bindings.filter(b => b.targetId === 'gp_123');
    expect(gpBindings).toHaveLength(0);
  });

  it('allows rejoin when agent is verified running', async () => {
    initGroupProjectLifecycle();

    // Agent joins
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });
    await new Promise(r => setTimeout(r, 50));

    // Agent leaves
    bindingManager.unbind('agent-1', 'gp_123');
    await new Promise(r => setTimeout(r, 50));

    // Re-bind — agent IS running (legitimate reconnect)
    mockIsRunning.mockReturnValue(true);
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });
    await new Promise(r => setTimeout(r, 50));

    const board = getBulletinBoard('gp_123');
    const messages = await board.getTopicMessages('system');
    // Should have: joined, left, joined (legitimate)
    expect(messages).toHaveLength(3);
    expect(messages[2].body).toContain('joined');
  });

  it('allows rejoin when agent has a registered runtime (headless)', async () => {
    initGroupProjectLifecycle();

    // Agent joins
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });
    await new Promise(r => setTimeout(r, 50));

    // Agent leaves
    bindingManager.unbind('agent-1', 'gp_123');
    await new Promise(r => setTimeout(r, 50));

    // Re-bind — agent is in registry (headless mode, no PTY)
    mockIsRunning.mockReturnValue(false);
    agentRegistry.register('agent-1', {
      projectPath: '/test',
      orchestrator: 'claude-code',
      runtime: 'headless',
    });

    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });
    await new Promise(r => setTimeout(r, 50));

    const board = getBulletinBoard('gp_123');
    const messages = await board.getTopicMessages('system');
    // Should have: joined, left, joined (agent is registered)
    expect(messages).toHaveLength(3);
    expect(messages[2].body).toContain('joined');

    agentRegistry.untrack('agent-1');
  });

  it('allows rejoin after debounce window expires', async () => {
    initGroupProjectLifecycle();

    // Agent joins
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });
    await new Promise(r => setTimeout(r, 50));

    // Agent leaves
    bindingManager.unbind('agent-1', 'gp_123');
    await new Promise(r => setTimeout(r, 50));

    // Simulate debounce window having expired by backdating the leave timestamp
    _recentLeavesForTesting.set('agent-1:gp_123', Date.now() - 60_000);

    // Re-bind — agent is NOT running, but debounce window expired
    mockIsRunning.mockReturnValue(false);
    bindingManager.bind('agent-1', {
      targetId: 'gp_123',
      targetKind: 'group-project',
      label: 'GP',
      agentName: 'robin',
    });
    await new Promise(r => setTimeout(r, 50));

    const board = getBulletinBoard('gp_123');
    const messages = await board.getTopicMessages('system');
    // Should have: joined, left, joined (debounce window expired)
    expect(messages).toHaveLength(3);
    expect(messages[2].body).toContain('joined');
  });

  it('records leave timestamp for debouncing', async () => {
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

    expect(_recentLeavesForTesting.has('agent-1:gp_123')).toBe(true);
    const ts = _recentLeavesForTesting.get('agent-1:gp_123')!;
    expect(Date.now() - ts).toBeLessThan(5000);
  });
});
