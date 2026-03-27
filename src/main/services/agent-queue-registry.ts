/**
 * AgentQueueRegistry — in-memory CRUD registry with deferred JSON flush.
 * Follows the same pattern as GroupProjectRegistry.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import type { AgentQueue } from '../../shared/agent-queue-types';
import { appLog } from './log-service';

function agentQueuesDir(): string {
  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  return path.join(app.getPath('home'), dirName, 'agent-queues');
}

function registryPath(): string {
  return path.join(agentQueuesDir(), 'registry.json');
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

const FLUSH_DELAY_MS = 500;

type ChangeListener = () => void;

class AgentQueueRegistry {
  private queues = new Map<string, AgentQueue>();
  private loaded = false;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlush: Promise<void> | null = null;
  private listeners = new Set<ChangeListener>();

  /** Load from disk if not already loaded. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const rp = registryPath();
    if (await pathExists(rp)) {
      try {
        const data: AgentQueue[] = JSON.parse(await fsp.readFile(rp, 'utf-8'));
        for (const q of data) {
          this.queues.set(q.id, q);
        }
      } catch (err) {
        appLog('core:agent-queue', 'error', 'Failed to parse agent-queues registry', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    this.loaded = true;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { void this.flush(); }, FLUSH_DELAY_MS);
  }

  /** Flush pending changes to disk. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingFlush) await this.pendingFlush;
    if (!this.dirty) return;

    const data = [...this.queues.values()];
    const flushPromise = (async () => {
      await ensureDir(agentQueuesDir());
      await fsp.writeFile(registryPath(), JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
    })().catch((err) => {
      appLog('core:agent-queue', 'error', 'Failed to write agent-queues registry', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }).finally(() => {
      if (this.pendingFlush === flushPromise) this.pendingFlush = null;
    });

    this.pendingFlush = flushPromise;
    await flushPromise;
  }

  private markDirty(): void {
    this.dirty = true;
    this.scheduleFlush();
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  async create(name: string): Promise<AgentQueue> {
    await this.ensureLoaded();
    const id = `aq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const queue: AgentQueue = {
      id,
      name,
      concurrency: 1,
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    this.queues.set(id, queue);
    this.markDirty();
    return queue;
  }

  async get(id: string): Promise<AgentQueue | null> {
    await this.ensureLoaded();
    return this.queues.get(id) ?? null;
  }

  /** Synchronous lookup from in-memory cache (returns null if not yet loaded). */
  getSync(id: string): AgentQueue | null {
    return this.queues.get(id) ?? null;
  }

  async list(): Promise<AgentQueue[]> {
    await this.ensureLoaded();
    return [...this.queues.values()];
  }

  async update(
    id: string,
    fields: Partial<Pick<AgentQueue, 'name' | 'concurrency' | 'projectId' | 'projectPath' | 'orchestrator' | 'model' | 'freeAgentMode' | 'autoWorktree' | 'metadata'>>,
  ): Promise<AgentQueue | null> {
    await this.ensureLoaded();
    const queue = this.queues.get(id);
    if (!queue) return null;
    if (fields.name !== undefined) queue.name = fields.name;
    if (fields.concurrency !== undefined) queue.concurrency = fields.concurrency;
    if (fields.projectId !== undefined) queue.projectId = fields.projectId;
    if (fields.projectPath !== undefined) queue.projectPath = fields.projectPath;
    if (fields.orchestrator !== undefined) queue.orchestrator = fields.orchestrator;
    if (fields.model !== undefined) queue.model = fields.model;
    if (fields.freeAgentMode !== undefined) queue.freeAgentMode = fields.freeAgentMode;
    if (fields.autoWorktree !== undefined) queue.autoWorktree = fields.autoWorktree;
    if (fields.metadata !== undefined) queue.metadata = { ...queue.metadata, ...fields.metadata };
    this.markDirty();
    return queue;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.queues.delete(id);
    if (existed) this.markDirty();
    return existed;
  }

  /** Register a change listener. Returns unsubscribe function. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** For testing: reset all state. */
  _resetForTesting(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingFlush = null;
    this.queues.clear();
    this.listeners.clear();
    this.loaded = false;
    this.dirty = false;
  }
}

export const agentQueueRegistry = new AgentQueueRegistry();
