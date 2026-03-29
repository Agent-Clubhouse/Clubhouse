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
import * as path from 'path';

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

  // ── Configurable limits ─────────────────────────────────────────────

  describe('configurable limits', () => {
    it('setLimits overrides per-topic pruning threshold', async () => {
      const board = getBulletinBoard('gp_limits');
      board.setLimits(3, 100); // max 3 per topic

      for (let i = 0; i < 5; i++) {
        await board.postMessage('a', 'topic', `msg${i}`);
      }

      const messages = await board.getTopicMessages('topic', undefined, 100);
      expect(messages).toHaveLength(3);
      expect(messages[0].body).toBe('msg2'); // oldest two pruned
    });

    it('setLimits overrides global pruning threshold', async () => {
      const board = getBulletinBoard('gp_glimits');
      board.setLimits(100, 5); // max 5 total

      for (let i = 0; i < 4; i++) {
        await board.postMessage('a', 'topicA', `a${i}`);
      }
      for (let i = 0; i < 4; i++) {
        await board.postMessage('b', 'topicB', `b${i}`);
      }

      const all = await board.getAllMessages(undefined, 100);
      expect(all.length).toBeLessThanOrEqual(5);
    });
  });

  // ── Topic protection ────────────────────────────────────────────────

  describe('topic protection', () => {
    it('setTopicProtected and isTopicProtected work correctly', async () => {
      const board = getBulletinBoard('gp_prot');
      expect(board.isTopicProtected('important')).toBe(false);

      board.setTopicProtected('important', true);
      expect(board.isTopicProtected('important')).toBe(true);

      board.setTopicProtected('important', false);
      expect(board.isTopicProtected('important')).toBe(false);
    });

    it('getProtectedTopics returns all protected topic names', async () => {
      const board = getBulletinBoard('gp_prot2');
      board.setTopicProtected('alpha', true);
      board.setTopicProtected('beta', true);

      const protected_ = board.getProtectedTopics();
      expect(protected_.sort()).toEqual(['alpha', 'beta']);
    });

    it('protected topic messages survive per-topic pruning', async () => {
      const board = getBulletinBoard('gp_prot_prune');
      board.setLimits(3, 1000);
      board.setTopicProtected('safe', true);

      for (let i = 0; i < 10; i++) {
        await board.postMessage('a', 'safe', `msg${i}`);
      }

      const messages = await board.getTopicMessages('safe', undefined, 100);
      expect(messages).toHaveLength(10); // all preserved, not pruned to 3
    });

    it('protected topic messages survive global pruning', async () => {
      const board = getBulletinBoard('gp_prot_global');
      board.setLimits(100, 5);
      board.setTopicProtected('safe', true);

      // Post 4 to safe (protected), 4 to unsafe
      for (let i = 0; i < 4; i++) {
        await board.postMessage('a', 'safe', `safe${i}`);
      }
      for (let i = 0; i < 4; i++) {
        await board.postMessage('b', 'unsafe', `unsafe${i}`);
      }

      const safeMsgs = await board.getTopicMessages('safe', undefined, 100);
      expect(safeMsgs).toHaveLength(4); // all protected messages survive

      const unsafeMsgs = await board.getTopicMessages('unsafe', undefined, 100);
      // Global limit is 5, safe has 4 protected, so unsafe gets pruned to 1
      expect(unsafeMsgs.length).toBeLessThanOrEqual(1);
    });

    it('digest includes isProtected field', async () => {
      const board = getBulletinBoard('gp_digest_prot');
      await board.postMessage('a', 'alpha', 'msg');
      await board.postMessage('a', 'beta', 'msg');
      board.setTopicProtected('alpha', true);

      const digest = await board.getDigest();
      const alpha = digest.find(d => d.topic === 'alpha')!;
      const beta = digest.find(d => d.topic === 'beta')!;
      expect(alpha.isProtected).toBe(true);
      expect(beta.isProtected).toBe(false);
    });

    it('protection state is included in flushed JSON', async () => {
      const board = getBulletinBoard('gp_prot_persist');
      await board.postMessage('a', 'keep', 'msg');
      board.setTopicProtected('keep', true);
      await board.flush();

      // Verify the serialized data includes protectedTopics
      const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
      const lastCall = writeCalls[writeCalls.length - 1];
      const written = JSON.parse(lastCall[1] as string);
      expect(written.protectedTopics).toEqual(['keep']);
      expect(written.topics.keep).toHaveLength(1);
    });
  });

  // ── Delete operations ───────────────────────────────────────────────

  describe('deleteMessage', () => {
    it('removes a specific message and returns true', async () => {
      const board = getBulletinBoard('gp_del');
      const msg1 = await board.postMessage('a', 'topic', 'first');
      await board.postMessage('b', 'topic', 'second');

      const result = await board.deleteMessage('topic', msg1.id);
      expect(result).toBe(true);

      const remaining = await board.getTopicMessages('topic', undefined, 100);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].body).toBe('second');
    });

    it('returns false for nonexistent message', async () => {
      const board = getBulletinBoard('gp_del2');
      await board.postMessage('a', 'topic', 'msg');
      expect(await board.deleteMessage('topic', 'msg_nonexistent')).toBe(false);
    });

    it('returns false for nonexistent topic', async () => {
      const board = getBulletinBoard('gp_del3');
      expect(await board.deleteMessage('nosuchtopic', 'msg_1')).toBe(false);
    });

    it('removes topic entry when last message is deleted', async () => {
      const board = getBulletinBoard('gp_del4');
      const msg = await board.postMessage('a', 'lonely', 'only one');

      await board.deleteMessage('lonely', msg.id);

      const digest = await board.getDigest();
      expect(digest.find(d => d.topic === 'lonely')).toBeUndefined();
    });

    it('removes protection when last message is deleted from protected topic', async () => {
      const board = getBulletinBoard('gp_del5');
      const msg = await board.postMessage('a', 'guarded', 'only');
      board.setTopicProtected('guarded', true);

      await board.deleteMessage('guarded', msg.id);
      expect(board.isTopicProtected('guarded')).toBe(false);
    });
  });

  describe('deleteTopic', () => {
    it('removes all messages for a topic and returns true', async () => {
      const board = getBulletinBoard('gp_deltopic');
      await board.postMessage('a', 'doomed', 'msg1');
      await board.postMessage('b', 'doomed', 'msg2');
      await board.postMessage('c', 'survivor', 'msg3');

      const result = await board.deleteTopic('doomed');
      expect(result).toBe(true);

      const digest = await board.getDigest();
      expect(digest).toHaveLength(1);
      expect(digest[0].topic).toBe('survivor');
    });

    it('returns false for nonexistent topic', async () => {
      const board = getBulletinBoard('gp_deltopic2');
      expect(await board.deleteTopic('ghost')).toBe(false);
    });

    it('also removes protection for the deleted topic', async () => {
      const board = getBulletinBoard('gp_deltopic3');
      await board.postMessage('a', 'guarded', 'msg');
      board.setTopicProtected('guarded', true);

      await board.deleteTopic('guarded');
      expect(board.isTopicProtected('guarded')).toBe(false);
    });
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
      // Use path.join for cross-platform compatibility (Windows uses backslashes)
      const expectedDir = path.join('/tmp/test-clubhouse', '.clubhouse-dev', 'group-projects', 'gp_cleanup');
      // Mark the directory as existing so access() succeeds
      store.set(expectedDir, '');

      getBulletinBoard('gp_cleanup');
      await destroyBulletinBoard('gp_cleanup');

      expect(fsp.rm).toHaveBeenCalledWith(
        expectedDir,
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
