/**
 * BulletinBoard — per-project message board with topic-based organization.
 * Supports posting, digest, topic reading, and automatic pruning.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import type { BulletinMessage, TopicDigest } from '../../shared/group-project-types';
import { appLog } from './log-service';

/** Max message body size in bytes. */
const MAX_BODY_BYTES = 100 * 1024;
/** Max messages per topic before pruning. */
const MAX_PER_TOPIC = 500;
/** Max messages per board before global pruning. */
const MAX_TOTAL = 2500;

const FLUSH_DELAY_MS = 500;

function groupProjectsDir(): string {
  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  return path.join(app.getPath('home'), dirName, 'group-projects');
}

function bulletinPath(projectId: string): string {
  return path.join(groupProjectsDir(), projectId, 'bulletin.json');
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

interface BulletinData {
  topics: Record<string, BulletinMessage[]>;
}

class BulletinBoard {
  private projectId: string;
  private topics = new Map<string, BulletinMessage[]>();
  private loaded = false;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlush: Promise<void> | null = null;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const bp = bulletinPath(this.projectId);
    if (await pathExists(bp)) {
      try {
        const data: BulletinData = JSON.parse(await fsp.readFile(bp, 'utf-8'));
        for (const [topic, messages] of Object.entries(data.topics || {})) {
          this.topics.set(topic, messages);
        }
      } catch (err) {
        appLog('core:group-project', 'error', 'Failed to parse bulletin board', {
          meta: { projectId: this.projectId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    this.loaded = true;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { void this.flush(); }, FLUSH_DELAY_MS);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingFlush) await this.pendingFlush;
    if (!this.dirty) return;

    const data: BulletinData = { topics: {} };
    for (const [topic, messages] of this.topics) {
      data.topics[topic] = messages;
    }

    const flushPromise = (async () => {
      await ensureDir(path.dirname(bulletinPath(this.projectId)));
      await fsp.writeFile(bulletinPath(this.projectId), JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
    })().catch((err) => {
      appLog('core:group-project', 'error', 'Failed to write bulletin board', {
        meta: { projectId: this.projectId, error: err instanceof Error ? err.message : String(err) },
      });
    }).finally(() => {
      if (this.pendingFlush === flushPromise) this.pendingFlush = null;
    });

    this.pendingFlush = flushPromise;
    await flushPromise;
  }

  /** Post a message to a topic. */
  async postMessage(sender: string, topic: string, body: string): Promise<BulletinMessage> {
    await this.ensureLoaded();

    if (Buffer.byteLength(body, 'utf-8') > MAX_BODY_BYTES) {
      throw new Error(`Message body exceeds ${MAX_BODY_BYTES} byte limit`);
    }

    const message: BulletinMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sender,
      topic,
      body,
      timestamp: new Date().toISOString(),
    };

    let topicMessages = this.topics.get(topic);
    if (!topicMessages) {
      topicMessages = [];
      this.topics.set(topic, topicMessages);
    }
    topicMessages.push(message);

    // Prune per-topic
    if (topicMessages.length > MAX_PER_TOPIC) {
      topicMessages.splice(0, topicMessages.length - MAX_PER_TOPIC);
    }

    // Prune globally
    this.pruneGlobal();

    this.dirty = true;
    this.scheduleFlush();
    return message;
  }

  /** Get a digest of all topics (no message bodies). */
  async getDigest(since?: string): Promise<TopicDigest[]> {
    await this.ensureLoaded();
    const sinceTime = since ? new Date(since).getTime() : 0;
    const digests: TopicDigest[] = [];

    for (const [topic, messages] of this.topics) {
      if (messages.length === 0) continue;
      const newMessages = sinceTime > 0
        ? messages.filter(m => new Date(m.timestamp).getTime() > sinceTime)
        : messages;
      digests.push({
        topic,
        messageCount: messages.length,
        newMessageCount: newMessages.length,
        latestTimestamp: messages[messages.length - 1].timestamp,
      });
    }

    return digests;
  }

  /** Get all messages across all topics, sorted by timestamp. */
  async getAllMessages(since?: string, limit?: number): Promise<BulletinMessage[]> {
    await this.ensureLoaded();
    let all: BulletinMessage[] = [];
    for (const messages of this.topics.values()) {
      all.push(...messages);
    }
    if (since) {
      const sinceTime = new Date(since).getTime();
      all = all.filter(m => new Date(m.timestamp).getTime() > sinceTime);
    }
    all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const effectiveLimit = limit ?? 100;
    if (all.length > effectiveLimit) {
      all = all.slice(-effectiveLimit);
    }
    return all;
  }

  /** Get messages from a specific topic. */
  async getTopicMessages(topic: string, since?: string, limit?: number): Promise<BulletinMessage[]> {
    await this.ensureLoaded();
    let messages = this.topics.get(topic) ?? [];
    if (since) {
      const sinceTime = new Date(since).getTime();
      messages = messages.filter(m => new Date(m.timestamp).getTime() > sinceTime);
    }
    const effectiveLimit = limit ?? 50;
    if (messages.length > effectiveLimit) {
      messages = messages.slice(-effectiveLimit);
    }
    return messages;
  }

  private pruneGlobal(): void {
    let total = 0;
    for (const messages of this.topics.values()) {
      total += messages.length;
    }
    if (total <= MAX_TOTAL) return;

    // Collect all messages, sort oldest first, remove until under limit
    const all: Array<{ topic: string; index: number; timestamp: number }> = [];
    for (const [topic, messages] of this.topics) {
      for (let i = 0; i < messages.length; i++) {
        all.push({ topic, index: i, timestamp: new Date(messages[i].timestamp).getTime() });
      }
    }
    all.sort((a, b) => a.timestamp - b.timestamp);

    const toRemove = total - MAX_TOTAL;
    const removals = new Map<string, Set<number>>();
    for (let i = 0; i < toRemove && i < all.length; i++) {
      const entry = all[i];
      let set = removals.get(entry.topic);
      if (!set) {
        set = new Set();
        removals.set(entry.topic, set);
      }
      set.add(entry.index);
    }

    for (const [topic, indices] of removals) {
      const messages = this.topics.get(topic)!;
      const filtered = messages.filter((_, i) => !indices.has(i));
      if (filtered.length === 0) {
        this.topics.delete(topic);
      } else {
        this.topics.set(topic, filtered);
      }
    }
  }

  /** For testing: reset state. */
  _resetForTesting(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingFlush = null;
    this.topics.clear();
    this.loaded = false;
    this.dirty = false;
  }
}

// --- Factory ---

const boards = new Map<string, BulletinBoard>();

/** Get or create a bulletin board for a project. */
export function getBulletinBoard(projectId: string): BulletinBoard {
  let board = boards.get(projectId);
  if (!board) {
    board = new BulletinBoard(projectId);
    boards.set(projectId, board);
  }
  return board;
}

/** Destroy a bulletin board instance (e.g., when project is deleted). */
export function destroyBulletinBoard(projectId: string): void {
  const board = boards.get(projectId);
  if (board) {
    board._resetForTesting();
    boards.delete(projectId);
  }
}

/** For testing: clear all boards. */
export function _resetAllBoardsForTesting(): void {
  for (const board of boards.values()) {
    board._resetForTesting();
  }
  boards.clear();
}
