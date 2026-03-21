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

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { getBulletinBoard, _resetAllBoardsForTesting } from './group-project-bulletin';
import { groupProjectRegistry } from './group-project-registry';
import { initGroupProjectLifecycle, _resetLifecycleForTesting } from './group-project-lifecycle';

describe('GroupProjectLifecycle', () => {
  beforeEach(() => {
    store.clear();
    mockPtyWrite.mockClear();
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
