/**
 * GroupProjectRegistry — in-memory CRUD registry with deferred JSON flush.
 * Pattern follows agent-config.ts: Map + dirty tracking + debounced write.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import type { GroupProject } from '../../shared/group-project-types';
import { appLog } from './log-service';

function groupProjectsDir(): string {
  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  return path.join(app.getPath('home'), dirName, 'group-projects');
}

function registryPath(): string {
  return path.join(groupProjectsDir(), 'registry.json');
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

class GroupProjectRegistry {
  private projects = new Map<string, GroupProject>();
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
        const data: GroupProject[] = JSON.parse(await fsp.readFile(rp, 'utf-8'));
        for (const p of data) {
          // Normalize old entries missing new fields
          if (p.description === undefined) p.description = '';
          if (p.instructions === undefined) p.instructions = '';
          this.projects.set(p.id, p);
        }
      } catch (err) {
        appLog('core:group-project', 'error', 'Failed to parse group-projects registry', {
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

    const data = [...this.projects.values()];
    const flushPromise = (async () => {
      await ensureDir(groupProjectsDir());
      await fsp.writeFile(registryPath(), JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
    })().catch((err) => {
      appLog('core:group-project', 'error', 'Failed to write group-projects registry', {
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

  async create(name: string): Promise<GroupProject> {
    await this.ensureLoaded();
    const id = `gp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const project: GroupProject = {
      id,
      name,
      description: '',
      instructions: '',
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    this.projects.set(id, project);
    this.markDirty();
    return project;
  }

  async get(id: string): Promise<GroupProject | null> {
    await this.ensureLoaded();
    return this.projects.get(id) ?? null;
  }

  /** Synchronous lookup from in-memory cache (returns null if not yet loaded). */
  getSync(id: string): GroupProject | null {
    return this.projects.get(id) ?? null;
  }

  async list(): Promise<GroupProject[]> {
    await this.ensureLoaded();
    return [...this.projects.values()];
  }

  async update(id: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }): Promise<GroupProject | null> {
    await this.ensureLoaded();
    const project = this.projects.get(id);
    if (!project) return null;
    if (fields.name !== undefined) project.name = fields.name;
    if (fields.description !== undefined) project.description = fields.description;
    if (fields.instructions !== undefined) project.instructions = fields.instructions;
    if (fields.metadata !== undefined) project.metadata = { ...project.metadata, ...fields.metadata };
    this.markDirty();
    return project;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.projects.delete(id);
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
    this.projects.clear();
    this.listeners.clear();
    this.loaded = false;
    this.dirty = false;
  }
}

export const groupProjectRegistry = new GroupProjectRegistry();
