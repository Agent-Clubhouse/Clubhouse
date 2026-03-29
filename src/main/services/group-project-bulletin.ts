/**
 * BulletinBoard — per-project message board with topic-based organization.
 * Supports posting, digest, topic reading, automatic pruning, topic protection,
 * configurable retention limits, and message/topic deletion.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import type { BulletinMessage, TopicDigest } from '../../shared/group-project-types';
import { appLog } from './log-service';

/** Default max message body size in bytes. */
const MAX_BODY_BYTES = 100 * 1024;
/** Default max messages per topic before pruning. */
const DEFAULT_MAX_PER_TOPIC = 500;
/** Default max messages per board before global pruning. */
const DEFAULT_MAX_TOTAL = 2500;

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
  protectedTopics?: string[];
}

class BulletinBoard {
  private projectId: string;
  private topics = new Map<string, BulletinMessage[]>();
  private protectedTopics = new Set<string>();
  private loaded = false;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlush: Promise<void> | null = null;

  /** Configurable limits — set via setLimits(), default to module constants. */
  private maxPerTopic = DEFAULT_MAX_PER_TOPIC;
  private maxTotal = DEFAULT_MAX_TOTAL;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  /** Override the per-topic and total message limits for this board. */
  setLimits(maxPerTopic: number, maxTotal: number): void {
    this.maxPerTopic = maxPerTopic;
    this.maxTotal = maxTotal;
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
        if (Array.isArray(data.protectedTopics)) {
          for (const t of data.protectedTopics) {
            this.protectedTopics.add(t);
          }
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
    if (this.protectedTopics.size > 0) {
      data.protectedTopics = [...this.protectedTopics];
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

    // Prune per-topic (skip protected topics)
    if (!this.protectedTopics.has(topic) && topicMessages.length > this.maxPerTopic) {
      topicMessages.splice(0, topicMessages.length - this.maxPerTopic);
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
        isProtected: this.protectedTopics.has(topic),
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
    if (total <= this.maxTotal) return;

    // Collect all messages from NON-protected topics, sort oldest first, remove until under limit
    const all: Array<{ topic: string; index: number; timestamp: number }> = [];
    for (const [topic, messages] of this.topics) {
      if (this.protectedTopics.has(topic)) continue;
      for (let i = 0; i < messages.length; i++) {
        all.push({ topic, index: i, timestamp: new Date(messages[i].timestamp).getTime() });
      }
    }
    all.sort((a, b) => a.timestamp - b.timestamp);

    const toRemove = total - this.maxTotal;
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

  // ── Topic protection ────────────────────────────────────────────────────

  /** Mark a topic as protected (skip pruning) or unprotected. */
  setTopicProtected(topic: string, isProtected: boolean): void {
    if (isProtected) {
      this.protectedTopics.add(topic);
    } else {
      this.protectedTopics.delete(topic);
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  /** Check whether a topic is protected. */
  isTopicProtected(topic: string): boolean {
    return this.protectedTopics.has(topic);
  }

  /** Return all protected topic names. */
  getProtectedTopics(): string[] {
    return [...this.protectedTopics];
  }

  // ── Delete operations ───────────────────────────────────────────────────

  /** Delete a single message by ID within a topic. Returns true if found. */
  async deleteMessage(topic: string, messageId: string): Promise<boolean> {
    await this.ensureLoaded();
    const messages = this.topics.get(topic);
    if (!messages) return false;

    const idx = messages.findIndex(m => m.id === messageId);
    if (idx === -1) return false;

    messages.splice(idx, 1);
    if (messages.length === 0) {
      this.topics.delete(topic);
      this.protectedTopics.delete(topic);
    }

    this.dirty = true;
    this.scheduleFlush();
    return true;
  }

  /** Delete an entire topic and all its messages. Returns true if the topic existed. */
  async deleteTopic(topic: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.topics.has(topic);
    if (!existed) return false;

    this.topics.delete(topic);
    this.protectedTopics.delete(topic);

    this.dirty = true;
    this.scheduleFlush();
    return true;
  }

  /** For testing: reset state. */
  _resetForTesting(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingFlush = null;
    this.topics.clear();
    this.protectedTopics.clear();
    this.loaded = false;
    this.dirty = false;
    this.maxPerTopic = DEFAULT_MAX_PER_TOPIC;
    this.maxTotal = DEFAULT_MAX_TOTAL;
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

/** Destroy a bulletin board instance and remove its data directory from disk. */
export async function destroyBulletinBoard(projectId: string): Promise<void> {
  const board = boards.get(projectId);
  if (board) {
    board._resetForTesting();
    boards.delete(projectId);
  }
  // Remove the project's data directory (contains bulletin.json and any future artifacts)
  const dir = path.join(groupProjectsDir(), projectId);
  try {
    if (await pathExists(dir)) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  } catch {
    appLog('core:group-project', 'warn', 'Failed to remove bulletin data directory', { meta: { projectId, dir } });
  }
}

/** For testing: clear all boards. */
export function _resetAllBoardsForTesting(): void {
  for (const board of boards.values()) {
    board._resetForTesting();
  }
  boards.clear();
}
