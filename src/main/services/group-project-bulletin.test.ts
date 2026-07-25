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

import {
  getBulletinBoard,
  destroyBulletinBoard,
  _resetAllBoardsForTesting,
  PROJECT_CHANNELS,
  ensureProjectChannels,
  ensureInboxChannel,
  inboxChannelName,
  normalizeChannelName,
} from './group-project-bulletin';
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

  it('digest accepts a per-topic since map', async () => {
    const board = getBulletinBoard('gp_test');
    await board.postMessage('a', 'read-topic', 'old');
    await board.postMessage('a', 'unread-topic', 'old');

    const cutoff = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    await board.postMessage('b', 'read-topic', 'new');
    await board.postMessage('b', 'unread-topic', 'new');

    const digest = await board.getDigest({ 'read-topic': cutoff });

    const read = digest.find(d => d.topic === 'read-topic')!;
    expect(read.messageCount).toBe(2);
    expect(read.newMessageCount).toBe(1);

    // A topic missing from the map has never been read — everything is new.
    const unread = digest.find(d => d.topic === 'unread-topic')!;
    expect(unread.messageCount).toBe(2);
    expect(unread.newMessageCount).toBe(2);
  });

  it('digest reports zero unread for a topic read up to its latest message', async () => {
    const board = getBulletinBoard('gp_test');
    await board.postMessage('a', 'topic', 'msg1');
    await board.postMessage('b', 'topic', 'msg2');

    const first = await board.getDigest();
    expect(first[0].newMessageCount).toBe(2);

    // Mark read at the latest timestamp, as the UI does when a channel is opened.
    const digest = await board.getDigest({ topic: first[0].latestTimestamp });
    expect(digest[0].messageCount).toBe(2);
    expect(digest[0].newMessageCount).toBe(0);
  });

  it('digest counts everything as unread when the per-topic timestamp is invalid', async () => {
    const board = getBulletinBoard('gp_test');
    await board.postMessage('a', 'topic', 'msg1');

    const digest = await board.getDigest({ topic: 'not-a-timestamp' });
    expect(digest[0].newMessageCount).toBe(1);
  });

  it('digest with an empty since map counts everything as unread', async () => {
    const board = getBulletinBoard('gp_test');
    await board.postMessage('a', 'topic', 'msg1');
    await board.postMessage('b', 'topic', 'msg2');

    const digest = await board.getDigest({});
    expect(digest[0].newMessageCount).toBe(2);
  });

  it('digest ignores inherited properties on the since map', async () => {
    const board = getBulletinBoard('gp_test');
    await board.postMessage('a', 'toString', 'msg1');

    // A topic named after an Object.prototype member must not pick up the
    // inherited value as its cutoff.
    const digest = await board.getDigest({} as Record<string, string>);
    expect(digest[0].newMessageCount).toBe(1);
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

  describe('clearAll', () => {
    it('removes all topics and messages', async () => {
      const board = getBulletinBoard('gp_clear');
      await board.postMessage('alice', 'topic-a', 'msg1');
      await board.postMessage('bob', 'topic-b', 'msg2');
      await board.postMessage('alice', 'topic-a', 'msg3');

      const removed = await board.clearAll();
      expect(removed).toBe(3);

      const digest = await board.getDigest();
      expect(digest).toHaveLength(0);
    });

    it('returns 0 for an empty board', async () => {
      const board = getBulletinBoard('gp_clear_empty');
      const removed = await board.clearAll();
      expect(removed).toBe(0);
    });
  });

  describe('trimToLimits', () => {
    it('trims per-topic and global when limits are lowered', async () => {
      const board = getBulletinBoard('gp_trim');
      // Post 10 messages to a topic
      for (let i = 0; i < 10; i++) {
        await board.postMessage('alice', 'noisy', `msg${i}`);
      }

      board.setLimits(3, 5);
      const removed = await board.trimToLimits();

      expect(removed).toBe(7); // 10 - 3 = 7
      const msgs = await board.getTopicMessages('noisy');
      expect(msgs).toHaveLength(3);
    });

    it('skips protected topics', async () => {
      const board = getBulletinBoard('gp_trim_prot');
      for (let i = 0; i < 10; i++) {
        await board.postMessage('alice', 'important', `msg${i}`);
      }
      board.setTopicProtected('important', true);

      board.setLimits(3, 5);
      const removed = await board.trimToLimits();

      expect(removed).toBe(0); // protected topic is not trimmed
      const msgs = await board.getTopicMessages('important');
      expect(msgs).toHaveLength(10);
    });

    it('returns 0 when already within limits', async () => {
      const board = getBulletinBoard('gp_trim_ok');
      await board.postMessage('alice', 'small', 'msg1');
      await board.postMessage('alice', 'small', 'msg2');

      const removed = await board.trimToLimits();
      expect(removed).toBe(0);
    });
  });

  describe('estimateTrimCount', () => {
    it('estimates messages that would be removed', async () => {
      const board = getBulletinBoard('gp_est');
      for (let i = 0; i < 10; i++) {
        await board.postMessage('alice', 'chatty', `msg${i}`);
      }

      const estimate = board.estimateTrimCount(3, 5);
      expect(estimate).toBe(7); // 10 - 3 per-topic
    });

    it('returns 0 when within proposed limits', async () => {
      const board = getBulletinBoard('gp_est_ok');
      await board.postMessage('alice', 'small', 'msg1');

      const estimate = board.estimateTrimCount(100, 500);
      expect(estimate).toBe(0);
    });
  });

  describe('getMessageById', () => {
    it('finds a message across topics', async () => {
      const board = getBulletinBoard('gp_getmsg');
      await board.postMessage('alice', 'topic-a', 'hello');
      const msg2 = await board.postMessage('bob', 'topic-b', 'world');

      const found = await board.getMessageById(msg2.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(msg2.id);
      expect(found!.body).toBe('world');
    });

    it('returns null for unknown ID', async () => {
      const board = getBulletinBoard('gp_getmsg_404');
      const found = await board.getMessageById('msg_nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('totalMessageCount', () => {
    it('counts all messages across topics', async () => {
      const board = getBulletinBoard('gp_count');
      await board.postMessage('alice', 'topic-a', 'msg1');
      await board.postMessage('bob', 'topic-b', 'msg2');
      await board.postMessage('alice', 'topic-a', 'msg3');

      expect(board.totalMessageCount()).toBe(3);
    });
  });

  describe('hasTopic', () => {
    it('returns false for an empty board', async () => {
      const board = getBulletinBoard('gp_has_none');
      expect(await board.hasTopic('general')).toBe(false);
    });

    it('returns true after a message is posted to that topic', async () => {
      const board = getBulletinBoard('gp_has_some');
      await board.postMessage('system', 'general', 'hi');
      expect(await board.hasTopic('general')).toBe(true);
      expect(await board.hasTopic('control')).toBe(false);
    });
  });

  describe('getDigest channel filter', () => {
    it('returns only the topics listed in the channels filter', async () => {
      const board = getBulletinBoard('gp_filter');
      await board.postMessage('a', 'general', 'g1');
      await board.postMessage('a', 'control', 'c1');
      await board.postMessage('a', 'feature-foo', 'f1');
      await board.postMessage('a', 'feature-bar', 'b1');

      const digest = await board.getDigest(undefined, ['general', 'control']);
      const topics = digest.map(d => d.topic).sort();
      expect(topics).toEqual(['control', 'general']);
    });

    it('returns all topics when channels filter is empty or omitted', async () => {
      const board = getBulletinBoard('gp_filter_none');
      await board.postMessage('a', 't1', 'm');
      await board.postMessage('a', 't2', 'm');

      const omitted = await board.getDigest();
      expect(omitted.map(d => d.topic).sort()).toEqual(['t1', 't2']);

      const empty = await board.getDigest(undefined, []);
      expect(empty.map(d => d.topic).sort()).toEqual(['t1', 't2']);
    });

    it('combines since and channels filters', async () => {
      const board = getBulletinBoard('gp_filter_since');
      await board.postMessage('a', 'general', 'old-g');
      await board.postMessage('a', 'control', 'old-c');
      const cutoff = new Date().toISOString();
      await new Promise(r => setTimeout(r, 2));
      await board.postMessage('a', 'general', 'new-g');
      await board.postMessage('a', 'control', 'new-c');

      const digest = await board.getDigest(cutoff, ['general']);
      expect(digest).toHaveLength(1);
      expect(digest[0].topic).toBe('general');
      expect(digest[0].newMessageCount).toBe(1);
      expect(digest[0].messageCount).toBe(2);
    });
  });

  // ── Case-insensitive channels (go-forward routing) ───────────────────
  describe('case-insensitive channel routing', () => {
    it('routes a mixed-case post to the same channel read with lowercase (digest filter)', async () => {
      const board = getBulletinBoard('gp_ci_digest');
      await board.postMessage('a', 'inbox-My-Agent', 'hi');

      const digest = await board.getDigest(undefined, ['inbox-my-agent']);
      expect(digest).toHaveLength(1);
      expect(digest[0].topic).toBe('inbox-my-agent');
      expect(digest[0].messageCount).toBe(1);
    });

    it('reads messages regardless of the casing used to post or query', async () => {
      const board = getBulletinBoard('gp_ci_read');
      await board.postMessage('a', 'inbox-my-agent', 'hello');

      const messages = await board.getTopicMessages('inbox-MY-AGENT');
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe('hello');
    });

    it('accumulates differently-cased posts under one canonical topic', async () => {
      const board = getBulletinBoard('gp_ci_accum');
      await board.postMessage('a', 'inbox-My-Agent', 'first');
      await board.postMessage('b', 'INBOX-MY-AGENT', 'second');
      await board.postMessage('c', 'inbox-my-agent', 'third');

      const digest = await board.getDigest();
      expect(digest).toHaveLength(1);
      expect(digest[0].topic).toBe('inbox-my-agent');
      expect(digest[0].messageCount).toBe(3);
    });

    it('stores the canonical (lowercased) form as the message topic', async () => {
      const board = getBulletinBoard('gp_ci_msgtopic');
      const msg = await board.postMessage('a', 'Inbox-Robin', 'yo');
      expect(msg.topic).toBe('inbox-robin');
    });

    it('hasTopic is case-insensitive', async () => {
      const board = getBulletinBoard('gp_ci_has');
      await board.postMessage('a', 'inbox-robin', 'x');
      expect(await board.hasTopic('inbox-Robin')).toBe(true);
      expect(await board.hasTopic('INBOX-ROBIN')).toBe(true);
    });

    it('protection applies across casings and survives pruning', async () => {
      const board = getBulletinBoard('gp_ci_prot');
      board.setLimits(3, 1000);
      board.setTopicProtected('Inbox-Safe', true);
      expect(board.isTopicProtected('inbox-safe')).toBe(true);

      for (let i = 0; i < 10; i++) {
        await board.postMessage('a', 'INBOX-SAFE', `msg${i}`);
      }
      const messages = await board.getTopicMessages('inbox-safe', undefined, 100);
      expect(messages).toHaveLength(10); // protected → not pruned to 3
    });

    it('delete paths resolve topics case-insensitively', async () => {
      const board = getBulletinBoard('gp_ci_del');
      const msg = await board.postMessage('a', 'inbox-x', 'one');
      await board.postMessage('b', 'inbox-x', 'two');

      expect(await board.deleteMessage('INBOX-X', msg.id)).toBe(true);
      expect(await board.getTopicMessages('inbox-x')).toHaveLength(1);

      expect(await board.deleteTopic('Inbox-X')).toBe(true);
      expect(await board.hasTopic('inbox-x')).toBe(false);
    });
  });

  // ── Silent one-time migration on load ─────────────────────────────────
  describe('mixed-case migration on load', () => {
    const bulletinPathFor = (projectId: string) =>
      path.join('/tmp/test-clubhouse', '.clubhouse-dev', 'group-projects', projectId, 'bulletin.json');

    // vitest config sets `mockReset: true`, which wipes the store-backed mock
    // implementations before each test. These migration tests are the only ones
    // that read seeded content back through readFile, so re-establish the impls.
    beforeEach(() => {
      vi.mocked(fsp.access).mockImplementation(async (p: string) => {
        if (!store.has(p)) throw new Error('ENOENT');
      });
      vi.mocked(fsp.readFile).mockImplementation(async (p: string) => {
        const data = store.get(p);
        if (data === undefined) throw new Error('ENOENT');
        return data;
      });
      vi.mocked(fsp.writeFile).mockImplementation(async (p: string, content: string) => {
        store.set(p, content);
      });
    });

    it('canonicalizes a lone mixed-case topic key on load', async () => {
      store.set(bulletinPathFor('gp_mig_lone'), JSON.stringify({
        topics: {
          'inbox-My-Agent': [
            { id: 'msg_1', sender: 'a', topic: 'inbox-My-Agent', body: 'hi', timestamp: '2026-01-01T00:00:00.000Z' },
          ],
        },
      }));

      const board = getBulletinBoard('gp_mig_lone');
      const messages = await board.getTopicMessages('inbox-my-agent');
      expect(messages).toHaveLength(1);
      expect(messages[0].topic).toBe('inbox-my-agent');
    });

    it('merges colliding keys, preserving all messages in timestamp order', async () => {
      store.set(bulletinPathFor('gp_mig_merge'), JSON.stringify({
        topics: {
          'inbox-My-Agent': [
            { id: 'm1', sender: 'a', topic: 'inbox-My-Agent', body: 'first',  timestamp: '2026-01-01T00:00:01.000Z' },
            { id: 'm3', sender: 'a', topic: 'inbox-My-Agent', body: 'third',  timestamp: '2026-01-01T00:00:03.000Z' },
          ],
          'inbox-my-agent': [
            { id: 'm2', sender: 'b', topic: 'inbox-my-agent', body: 'second', timestamp: '2026-01-01T00:00:02.000Z' },
            { id: 'm4', sender: 'b', topic: 'inbox-my-agent', body: 'fourth', timestamp: '2026-01-01T00:00:04.000Z' },
          ],
        },
      }));

      const board = getBulletinBoard('gp_mig_merge');
      const messages = await board.getTopicMessages('inbox-my-agent', undefined, 100);
      expect(messages.map(m => m.body)).toEqual(['first', 'second', 'third', 'fourth']);
      // No history lost.
      expect(board.totalMessageCount()).toBe(4);
      // Single canonical topic remains.
      const digest = await board.getDigest();
      expect(digest.map(d => d.topic)).toEqual(['inbox-my-agent']);
    });

    it('normalizes protectedTopics on load', async () => {
      store.set(bulletinPathFor('gp_mig_prot'), JSON.stringify({
        topics: {
          'Inbox-Guard': [
            { id: 'g1', sender: 'a', topic: 'Inbox-Guard', body: 'x', timestamp: '2026-01-01T00:00:00.000Z' },
          ],
        },
        protectedTopics: ['Inbox-Guard'],
      }));

      const board = getBulletinBoard('gp_mig_prot');
      expect(await board.hasTopic('inbox-guard')).toBe(true);
      expect(board.isTopicProtected('inbox-guard')).toBe(true);
    });

    it('persists the canonical form back to disk (migration is durable)', async () => {
      const p = bulletinPathFor('gp_mig_persist');
      store.set(p, JSON.stringify({
        topics: {
          'inbox-My-Agent': [
            { id: 'm1', sender: 'a', topic: 'inbox-My-Agent', body: 'a', timestamp: '2026-01-01T00:00:01.000Z' },
          ],
          'inbox-my-agent': [
            { id: 'm2', sender: 'b', topic: 'inbox-my-agent', body: 'b', timestamp: '2026-01-01T00:00:02.000Z' },
          ],
        },
      }));

      const board = getBulletinBoard('gp_mig_persist');
      await board.hasTopic('anything'); // triggers ensureLoaded → migration
      await board.flush();

      const written = JSON.parse(store.get(p)!);
      expect(Object.keys(written.topics)).toEqual(['inbox-my-agent']);
      expect(written.topics['inbox-my-agent']).toHaveLength(2);
    });
  });
});

describe('channel bootstrap helpers', () => {
  beforeEach(() => {
    store.clear();
    _resetAllBoardsForTesting();
  });

  describe('normalizeChannelName', () => {
    it('lowercases mixed-case channel names', () => {
      expect(normalizeChannelName('inbox-My-Agent')).toBe('inbox-my-agent');
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeChannelName('  Inbox-X  ')).toBe('inbox-x');
    });

    it('leaves already-canonical reserved channels unchanged', () => {
      expect(normalizeChannelName('general')).toBe('general');
      expect(normalizeChannelName('control')).toBe('control');
    });

    it('is idempotent', () => {
      const once = normalizeChannelName('Inbox-My-Agent');
      expect(normalizeChannelName(once)).toBe(once);
    });
  });

  describe('inboxChannelName', () => {
    it('lowercases a simple name', () => {
      expect(inboxChannelName('Robin')).toBe('inbox-robin');
    });

    it('replaces disallowed characters with a single dash', () => {
      expect(inboxChannelName('alice/bob')).toBe('inbox-alice-bob');
      expect(inboxChannelName('Foo  Bar!!')).toBe('inbox-foo-bar');
    });

    it('strips leading and trailing dashes', () => {
      expect(inboxChannelName('___robin___')).toBe('inbox-robin');
    });

    it('falls back to inbox-unknown for empty or fully invalid input', () => {
      expect(inboxChannelName('')).toBe('inbox-unknown');
      expect(inboxChannelName('!!!')).toBe('inbox-unknown');
    });
  });

  describe('PROJECT_CHANNELS', () => {
    it('reserves general and control', () => {
      expect(PROJECT_CHANNELS).toEqual(['general', 'control']);
    });
  });

  describe('ensureProjectChannels', () => {
    it('seeds general and control as protected topics', async () => {
      await ensureProjectChannels('gp_seed');
      const board = getBulletinBoard('gp_seed');
      const digest = await board.getDigest();
      const byTopic = Object.fromEntries(digest.map(d => [d.topic, d]));
      expect(byTopic.general).toBeDefined();
      expect(byTopic.general.isProtected).toBe(true);
      expect(byTopic.control).toBeDefined();
      expect(byTopic.control.isProtected).toBe(true);
    });

    it('is idempotent — repeated calls do not add extra seed messages', async () => {
      await ensureProjectChannels('gp_idem');
      await ensureProjectChannels('gp_idem');
      await ensureProjectChannels('gp_idem');
      const board = getBulletinBoard('gp_idem');
      const digest = await board.getDigest();
      const general = digest.find(d => d.topic === 'general')!;
      const control = digest.find(d => d.topic === 'control')!;
      expect(general.messageCount).toBe(1);
      expect(control.messageCount).toBe(1);
    });

    it('re-protects channels even if protection was cleared', async () => {
      await ensureProjectChannels('gp_reprot');
      const board = getBulletinBoard('gp_reprot');
      board.setTopicProtected('general', false);
      await ensureProjectChannels('gp_reprot');
      const digest = await board.getDigest();
      expect(digest.find(d => d.topic === 'general')!.isProtected).toBe(true);
    });
  });

  describe('ensureInboxChannel', () => {
    it('creates a sanitized inbox channel and marks it protected', async () => {
      const name = await ensureInboxChannel('gp_inbox', 'Robin');
      expect(name).toBe('inbox-robin');
      const board = getBulletinBoard('gp_inbox');
      const digest = await board.getDigest();
      const inbox = digest.find(d => d.topic === 'inbox-robin');
      expect(inbox).toBeDefined();
      expect(inbox!.isProtected).toBe(true);
      expect(inbox!.messageCount).toBe(1);
    });

    it('is idempotent across repeated joins', async () => {
      await ensureInboxChannel('gp_inbox2', 'robin');
      await ensureInboxChannel('gp_inbox2', 'robin');
      await ensureInboxChannel('gp_inbox2', 'robin');
      const board = getBulletinBoard('gp_inbox2');
      const digest = await board.getDigest();
      expect(digest.find(d => d.topic === 'inbox-robin')!.messageCount).toBe(1);
    });

    it('creates distinct inboxes for distinct agents on the same project', async () => {
      await ensureInboxChannel('gp_multi', 'Alice');
      await ensureInboxChannel('gp_multi', 'Bob');
      const board = getBulletinBoard('gp_multi');
      const digest = await board.getDigest();
      const topics = digest.map(d => d.topic).sort();
      expect(topics).toContain('inbox-alice');
      expect(topics).toContain('inbox-bob');
    });
  });
});
