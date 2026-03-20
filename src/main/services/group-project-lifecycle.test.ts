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

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { getBulletinBoard, _resetAllBoardsForTesting } from './group-project-bulletin';
import { initGroupProjectLifecycle, _resetLifecycleForTesting } from './group-project-lifecycle';

describe('GroupProjectLifecycle', () => {
  beforeEach(() => {
    store.clear();
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
});
