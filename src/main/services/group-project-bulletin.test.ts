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
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import { getBulletinBoard, destroyBulletinBoard, _resetAllBoardsForTesting } from './group-project-bulletin';
import * as fsp from 'fs/promises';

describe('BulletinBoard', () => {
  beforeEach(() => {
    store.clear();
    _resetAllBoardsForTesting();
    vi.mocked(fsp.rm).mockClear();
  });

  it('posts a message and returns it', async () => {
    const board = getBulletinBoard('gp_test');
    const msg = await board.postMessage('agent1@proj', 'updates', 'Hello world');
    expect(msg.id).toMatch(/^msg_\d+_[a-z0-9]+$/);
    expect(msg.sender).toBe('agent1@proj');
    expect(msg.topic).toBe('updates');
    expect(msg.body).toBe('Hello world');
    expect(msg.timestamp).toBeTruthy();
  });

  it('rejects messages exceeding body limit', async () => {
    const board = getBulletinBoard('gp_test');
    const hugeBody = 'x'.repeat(200 * 1024);
    await expect(board.postMessage('sender', 'topic', hugeBody)).rejects.toThrow('byte limit');
  });

  it('returns digest with correct counts', async () => {
    const board = getBulletinBoard('gp_test');
    await board.postMessage('a', 'topic1', 'msg1');
    await board.postMessage('b', 'topic1', 'msg2');
    await board.postMessage('c', 'topic2', 'msg3');

    const digest = await board.getDigest();
    expect(digest).toHaveLength(2);

    const t1 = digest.find(d => d.topic === 'topic1')!;
    expect(t1.messageCount).toBe(2);
    expect(t1.newMessageCount).toBe(2);

    const t2 = digest.find(d => d.topic === 'topic2')!;
    expect(t2.messageCount).toBe(1);
  });

  it('digest filters by since timestamp', async () => {
    const board = getBulletinBoard('gp_test');
    await board.postMessage('a', 'topic', 'old');

    const cutoff = new Date().toISOString();
    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 5));
    await board.postMessage('b', 'topic', 'new');

    const digest = await board.getDigest(cutoff);
    const t = digest.find(d => d.topic === 'topic')!;
    expect(t.messageCount).toBe(2);
    expect(t.newMessageCount).toBe(1);
  });

  it('getTopicMessages returns messages for a topic', async () => {
    const board = getBulletinBoard('gp_test');
    await board.postMessage('a', 'topic1', 'msg1');
    await board.postMessage('b', 'topic2', 'msg2');
    await board.postMessage('c', 'topic1', 'msg3');

    const messages = await board.getTopicMessages('topic1');
    expect(messages).toHaveLength(2);
    expect(messages[0].body).toBe('msg1');
    expect(messages[1].body).toBe('msg3');
  });

  it('getTopicMessages respects since filter', async () => {
    const board = getBulletinBoard('gp_test');
    await board.postMessage('a', 'topic', 'old');
    const cutoff = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    await board.postMessage('b', 'topic', 'new');

    const messages = await board.getTopicMessages('topic', cutoff);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('new');
  });

  it('getTopicMessages respects limit', async () => {
    const board = getBulletinBoard('gp_test');
    for (let i = 0; i < 10; i++) {
      await board.postMessage('a', 'topic', `msg${i}`);
    }

    const messages = await board.getTopicMessages('topic', undefined, 3);
    expect(messages).toHaveLength(3);
    // Should return the last 3
    expect(messages[0].body).toBe('msg7');
    expect(messages[2].body).toBe('msg9');
  });

  it('returns empty for unknown topic', async () => {
    const board = getBulletinBoard('gp_test');
    const messages = await board.getTopicMessages('nonexistent');
    expect(messages).toHaveLength(0);
  });

  it('factory returns same instance for same project', () => {
    const b1 = getBulletinBoard('gp_1');
    const b2 = getBulletinBoard('gp_1');
    expect(b1).toBe(b2);
  });

  it('factory returns different instances for different projects', () => {
    const b1 = getBulletinBoard('gp_1');
    const b2 = getBulletinBoard('gp_2');
    expect(b1).not.toBe(b2);
  });

  // ── destroyBulletinBoard disk cleanup ─────────────────────────────

  describe('destroyBulletinBoard', () => {
    it('removes the in-memory board instance', async () => {
      const b1 = getBulletinBoard('gp_destroy');
      expect(b1).toBeDefined();

      await destroyBulletinBoard('gp_destroy');

      // Should get a fresh instance now (different object)
      const b2 = getBulletinBoard('gp_destroy');
      expect(b2).not.toBe(b1);
    });

    it('removes the project data directory from disk', async () => {
      // Mark the directory as existing so access() succeeds
      store.set('/tmp/test-clubhouse/.clubhouse-dev/group-projects/gp_cleanup', '');

      getBulletinBoard('gp_cleanup');
      await destroyBulletinBoard('gp_cleanup');

      expect(fsp.rm).toHaveBeenCalledWith(
        '/tmp/test-clubhouse/.clubhouse-dev/group-projects/gp_cleanup',
        { recursive: true, force: true },
      );
    });

    it('does not throw when rm fails', async () => {
      // Mark directory as existing so rm gets called
      store.set('/tmp/test-clubhouse/.clubhouse-dev/group-projects/gp_rmfail', '');
      vi.mocked(fsp.rm).mockRejectedValueOnce(new Error('EPERM'));

      // Should not throw — error is caught and logged
      await expect(destroyBulletinBoard('gp_rmfail')).resolves.toBeUndefined();
    });
  });
});
