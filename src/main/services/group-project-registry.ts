/**
 * GroupProjectRegistry — in-memory CRUD registry with deferred JSON flush.
 * Pattern follows agent-config.ts: Map + dirty tracking + debounced write.
 */

import * as fsp from 'fs/promises';
import { randomBytes } from 'crypto';
import type { GroupProject, GroupProjectCreateOptions, GroupProjectHost, GroupProjectScope } from '../../shared/group-project-types';
import { resolveGroupProjectScope } from '../../shared/group-project-scope';
import { appLog } from './log-service';
import { persist } from '../telemetry/persist';
import { replaceFile } from './settings-store';
import * as projectStore from './project-store';
import { groupProjectsDir, registryPath, tombstonesPath } from './group-project-paths';

/**
 * Ids with a delete tombstone (#3356, #3364). Read at load so every reader hides
 * a group project whose delete was interrupted, before the host reconciles it.
 * An unreadable file hides nothing here; the host refuses to work with it.
 */
async function readTombstonedIds(): Promise<Set<string>> {
  try {
    const list: unknown = JSON.parse(await fsp.readFile(tombstonesPath(), 'utf-8'));
    if (!Array.isArray(list)) throw new Error('not a list');
    return new Set(list.flatMap((t) => (t && typeof t.groupProjectId === 'string' ? [t.groupProjectId] : [])));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    // telemetry-exempt: logged; the host's own read of this file refuses and surfaces it
    appLog('core:group-project', 'error', 'Group project tombstones could not be read', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return new Set();
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

const FLUSH_DELAY_MS = 500;

type ChangeListener = () => void;

type StoredGroupProject = GroupProject & { _scopeInference?: 'legacy-v1' };

function serializeProjects(
  projects: Map<string, GroupProject>, inferredIds: ReadonlySet<string>, priorCandidates: ReadonlyMap<string, GroupProjectScope>,
): string {
  return JSON.stringify([...projects.values()].map((project): StoredGroupProject => ({
    ...project,
    ...(inferredIds.has(project.id) ? { scope: project.scope ?? priorCandidates.get(project.id), _scopeInference: 'legacy-v1' as const } : {}),
  })), null, 2);
}

function sameScope(left: GroupProjectScope | undefined, right: GroupProjectScope): boolean {
  return left?.level === right.level && left.reach === right.reach
    && (left.level !== 'project' || (right.level === 'project' && left.projectId === right.projectId));
}

class GroupProjectRegistry {
  private projects = new Map<string, GroupProject>();
  /** Tombstoned ids: kept for the host's cleanup, invisible to every reader. */
  private hidden = new Set<string>();
  private inferredScopeIds = new Set<string>();
  private inferredScopeCandidates = new Map<string, GroupProjectScope>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private dirty = false;
  private revision = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlush: Promise<void> | null = null;
  private listeners = new Set<ChangeListener>();

  /** Load from disk if not already loaded. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.load().finally(() => { this.loadPromise = null; });
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    let projects = new Map<string, GroupProject>();
    let inferredIds = new Set<string>();
    const priorCandidates = new Map<string, GroupProjectScope>();
    let original = '';
    const rp = registryPath();
    if (await pathExists(rp)) {
      try {
        original = await fsp.readFile(rp, 'utf-8');
        const data: StoredGroupProject[] = JSON.parse(original);
        if (!Array.isArray(data)) throw new Error('Invalid group-projects registry');
        for (const record of data) {
          const { _scopeInference, ...p } = record;
          if (typeof p.id !== 'string' || !p.id || projects.has(p.id)) throw new Error('Invalid or duplicate group-project identity');
          if (_scopeInference !== undefined) {
            if (_scopeInference !== 'legacy-v1') throw new Error('Unrecognized group-project scope inference provenance');
            inferredIds.add(p.id);
            if (p.scope !== undefined) priorCandidates.set(p.id, p.scope);
            delete p.scope;
          }
          // Normalize old entries missing new fields
          if (p.description === undefined) p.description = '';
          if (p.instructions === undefined) p.instructions = '';
          projects.set(p.id, p);
        }
      } catch (err) {
        appLog('core:group-project', 'error', 'Failed to parse group-projects registry', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
    }
    if ([...projects.values()].some((project) => project.scope === undefined)) {
      const { collectLegacyGroupProjectScopes, GroupProjectScopeMigrationError } = await import('./group-project-scope-migration');
      try {
        const inventory = await collectLegacyGroupProjectScopes([...projects.values()]);
        for (const [id, prior] of priorCandidates) {
          if (!sameScope(inventory.scopes.get(id), prior)) {
            throw new GroupProjectScopeMigrationError(`Scope inference for ${id} no longer matches the recorded candidate; explicit scope confirmation is required.`);
          }
        }
        if (inventory.scopes.size > 0) {
          const candidates = new Map([...projects].map(([id, project]) => [
            id, { ...project, ...(inventory.scopes.has(id) ? { scope: inventory.scopes.get(id) } : {}) },
          ]));
          const candidateIds = new Set([...inferredIds, ...inventory.scopes.keys()]);
          await inventory.assertUnchanged();
          await this.writeSnapshot(serializeProjects(candidates, candidateIds, priorCandidates));
          try {
            await inventory.assertUnchanged();
          } catch (error) {
            try {
              await this.writeSnapshot(original);
            } catch (rollbackError) {
              throw Object.assign(new Error(`Scope migration inventory changed and rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`), {
                errors: [error, rollbackError],
              });
            }
            throw error;
          }
          projects = candidates;
          inferredIds = candidateIds;
          for (const [id, scope] of inventory.scopes) priorCandidates.set(id, { ...scope });
        }
      } catch (error) {
        if (!(error instanceof GroupProjectScopeMigrationError)) throw error;
        appLog('core:group-project', 'warn', 'Group project scope migration deferred until a complete inventory is available', {
          meta: { error: error.message, retryable: true, retry: 'next startup' },
        });
      }
    }
    this.hidden = await readTombstonedIds();
    this.projects = projects;
    this.inferredScopeIds = inferredIds;
    this.inferredScopeCandidates = priorCandidates;
    this.loaded = true;
  }

  private async writeSnapshot(data: string): Promise<void> {
    await ensureDir(groupProjectsDir());
    await persist.timed('group_registry', () => replaceFile(registryPath(), data, undefined));
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      void this.flush().catch((err) => {
        appLog('core:group-project', 'error', 'Failed to write group-projects registry', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      });
    }, FLUSH_DELAY_MS);
  }

  /** Flush pending changes to disk. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingFlush) {
      await this.pendingFlush;
      return this.flush();
    }
    if (!this.dirty) return;

    const revision = this.revision;
    const data = serializeProjects(this.projects, this.inferredScopeIds, this.inferredScopeCandidates);
    const flushPromise = (async () => {
      await this.writeSnapshot(data);
      if (this.revision === revision) this.dirty = false;
    })().finally(() => {
      if (this.pendingFlush === flushPromise) this.pendingFlush = null;
    });

    this.pendingFlush = flushPromise;
    await flushPromise;
    if (this.dirty) await this.flush();
  }

  private markDirty(): void {
    this.dirty = true;
    this.revision++;
    this.scheduleFlush();
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  /**
   * Only the host service calls this (#3356). `isUnusedId` lets it refuse ids
   * a deleted group project left behind.
   */
  async create(
    name: string, options?: GroupProjectCreateOptions, host: GroupProjectHost = { machine: null },
    resolveScope: (options: unknown, registered: ReadonlySet<string>) => GroupProjectScope = resolveGroupProjectScope,
    isUnusedId: (id: string) => boolean = () => true,
  ): Promise<GroupProject> {
    await this.ensureLoaded();
    const registered = new Set(options === undefined ? [] : (await projectStore.list()).map((project) => project.id));
    const scope = resolveScope(options, registered);
    let id: string;
    // Ids stay unique across machines (#3356): 48 random bits beside the time.
    do id = `gp_${Date.now()}_${randomBytes(6).toString('hex')}`;
    while (this.projects.has(id) || !isUnusedId(id));
    const project: GroupProject = {
      id,
      name,
      description: '',
      instructions: '',
      createdAt: new Date().toISOString(),
      scope,
      host: { machine: host.machine },
      metadata: {},
    };
    this.projects.set(id, project);
    this.markDirty();
    return project;
  }

  /** Change a record's scope (#3355). Only the host service calls this. */
  async setScope(id: string, scope: GroupProjectScope): Promise<GroupProject | null> {
    await this.ensureLoaded();
    const project = this.projects.get(id);
    if (!project) return null;
    project.scope = scope;
    this.inferredScopeIds.delete(id);
    this.inferredScopeCandidates.delete(id);
    this.markDirty();
    return project;
  }

  async get(id: string): Promise<GroupProject | null> {
    await this.ensureLoaded();
    return this.hidden.has(id) ? null : this.projects.get(id) ?? null;
  }

  /** Synchronous lookup from in-memory cache (returns null if not yet loaded). */
  getSync(id: string): GroupProject | null {
    return this.hidden.has(id) ? null : this.projects.get(id) ?? null;
  }

  async list(): Promise<GroupProject[]> {
    await this.ensureLoaded();
    return this.visible();
  }

  private visible(): GroupProject[] {
    return [...this.projects.values()].filter((project) => !this.hidden.has(project.id));
  }

  /** Whether a record exists, hidden or not. Only the host uses this. */
  async hasRecord(id: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.projects.has(id);
  }

  /** Hide a group project from every reader once its delete begins. Only the host calls this. */
  async hide(id: string): Promise<void> {
    await this.ensureLoaded();
    this.hidden.add(id);
    this.notifyListeners();
  }

  /** Navigation and inspection must not load/migrate the registry or schedule a write. */
  async peek(options: { strict?: boolean } = {}): Promise<GroupProject[]> {
    if (this.loaded && !options.strict) return this.visible();
    const hidden = await readTombstonedIds();
    let raw: string;
    try {
      raw = await fsp.readFile(registryPath(), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    let records: unknown;
    try {
      records = JSON.parse(raw);
    } catch (error) {
      if (options.strict) throw new Error('Group-project registry could not be read. Its file was left unchanged.');
      throw error;
    }
    if (!Array.isArray(records)) throw new Error('Group-project registry is not a list. Repair it and retry Open.');
    const ids = new Set<string>();
    return records.map((record: unknown): GroupProject => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('Group-project registry contains an invalid entry. Repair it and retry Open.');
      }
      const value = record as Record<string, unknown>;
      if (typeof value.id !== 'string' || !value.id || ids.has(value.id)
        || typeof value.name !== 'string' || typeof value.createdAt !== 'string'
        || !value.metadata || typeof value.metadata !== 'object' || Array.isArray(value.metadata)
        || (value.description !== undefined && typeof value.description !== 'string')
        || (value.instructions !== undefined && typeof value.instructions !== 'string')) {
        throw new Error('Group-project registry contains invalid or ambiguous identities. Repair it and retry Open.');
      }
      ids.add(value.id);
      return {
        id: value.id, name: value.name, createdAt: value.createdAt,
        description: typeof value.description === 'string' ? value.description : '',
        instructions: typeof value.instructions === 'string' ? value.instructions : '',
        metadata: value.metadata as Record<string, unknown>,
      };
    }).filter((project) => !hidden.has(project.id));
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
    this.inferredScopeIds.delete(id);
    this.inferredScopeCandidates.delete(id);
    if (existed) this.markDirty();
    return existed;
  }

  /** Register a change listener. Returns unsubscribe function. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** For testing: seed a project directly into the in-memory cache. */
  _setForTesting(project: GroupProject): void {
    this.loaded = true;
    this.projects.set(project.id, project);
  }

  /** For testing: reset all state. */
  _resetForTesting(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingFlush = null;
    this.projects.clear();
    this.hidden.clear();
    this.inferredScopeIds.clear();
    this.inferredScopeCandidates.clear();
    this.listeners.clear();
    this.loaded = false;
    this.loadPromise = null;
    this.dirty = false;
    this.revision = 0;
  }
}

export const groupProjectRegistry = new GroupProjectRegistry();

/** Flush the registry if a pending write is queued. */
export async function flushAllGroupProjects(): Promise<void> {
  await groupProjectRegistry.flush();
}
