import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  applyProjectLinksOp, legacyProjectLinkRecords, mergeProjectLinkRecords, parseProjectLinkRecords,
  parseProjectLinksOp, projectLinkGroups, projectLinkPairKey, projectLinksView, PROJECT_LINKS_PAGE_SIZE,
  type ProjectLinkRecord, type ProjectLinksView,
} from '../../shared/project-links';
import { createSettingsStore } from './settings-store';
import { getIdentity } from './annex-identity';
import { appLog } from './log-service';
import { auditChanged, currentSettingsOrigin } from './settings-audit';

interface Saved { version: 1; records: ProjectLinkRecord[]; migrated: string[] }
export interface ProjectLinksChange { source?: string; recordsChanged: boolean }
interface StoreOptions {
  read(): Saved;
  save(value: Saved, current?: () => boolean): Promise<void>;
  self(): string | null;
  legacyMirror(): unknown;
  now?(): number;
}

/** A durable replica, serialized so disk writes and incoming merges cannot overtake each other. */
export class ProjectLinksStore {
  private state: Saved | undefined;
  private revision = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private pendingLegacy: unknown;
  private listeners = new Set<(change: ProjectLinksChange) => void>();
  constructor(private options: StoreOptions) {}
  private get(): Saved { return this.state ??= this.options.read(); }
  records(): ProjectLinkRecord[] { return structuredClone(this.get().records); }
  groups() { return projectLinkGroups(this.get().records); }
  page(after?: string): { records: ProjectLinkRecord[]; next?: string } {
    const rows = this.get().records;
    let low = 0, high = rows.length;
    if (after !== undefined) while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (projectLinkPairKey(...rows[middle].projects) <= after) low = middle + 1;
      else high = middle;
    }
    const records = structuredClone(rows.slice(low, low + PROJECT_LINKS_PAGE_SIZE));
    return { records, ...(low + records.length < rows.length && { next: projectLinkPairKey(...records[records.length - 1].projects) }) };
  }
  view(): ProjectLinksView {
    const self = this.options.self();
    return self ? projectLinksView(this.get().records, self, this.revision) : { revision: this.revision, links: [], keptSeparate: [] };
  }
  ready(): boolean {
    const self = this.options.self();
    return !!self && this.get().migrated.includes(`${self}/mirror`);
  }
  onChange(listener: (change: ProjectLinksChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private update(change: (state: Saved) => Saved, source?: string, current: () => boolean = () => true): Promise<ProjectLinksView> {
    const work = async () => {
      if (!current()) throw new Error('Project link pairing changed.');
      const previous = this.get(), next = change(previous);
      if (next !== previous) {
        await this.options.save(next, current);
        this.state = next;
        this.revision++;
        for (const listener of this.listeners) {
          try { listener({ source, recordsChanged: next.records !== previous.records }); }
          catch (error) { // telemetry-exempt: committed settings survive a failed observer
            appLog('core:annex', 'warn', 'Project link observer failed', { meta: { error: error instanceof Error ? error.message : String(error) } });
          }
        }
      }
      return this.view();
    };
    const result = this.pending.then(work, work);
    this.pending = result;
    return result;
  }
  /** Each computer imports each legacy source once, at clock zero, without rewriting it. */
  migrate(legacy?: unknown): Promise<ProjectLinksView> {
    if (legacy !== undefined) this.pendingLegacy = legacy;
    return this.update((state) => {
      const self = this.options.self();
      if (!self) return state;
      let records = state.records;
      const migrated = [...state.migrated];
      for (const kind of ['mirror', 'renderer'] as const) {
        const key = `${self}/${kind}`;
        if (migrated.includes(key) || kind === 'renderer' && this.pendingLegacy === undefined) continue;
        const raw = kind === 'renderer' ? this.pendingLegacy : this.options.legacyMirror();
        records = mergeProjectLinkRecords(records, legacyProjectLinkRecords(raw, self));
        migrated.push(key);
      }
      return migrated.length === state.migrated.length ? state : { ...state, records, migrated };
    });
  }
  apply(raw: unknown): Promise<ProjectLinksView> {
    const op = parseProjectLinksOp(raw);
    return this.update((state) => {
      const self = this.options.self();
      if (!self) throw new Error('Annex identity is not ready for project links.');
      const records = applyProjectLinksOp(state.records, op, self, (this.options.now ?? Date.now)());
      return records === state.records ? state : { ...state, records };
    });
  }
  merge(raw: unknown, source: string, current?: () => boolean): Promise<ProjectLinksView> {
    const incoming = parseProjectLinkRecords(raw);
    return this.update((state) => {
      const records = mergeProjectLinkRecords(state.records, incoming);
      return records === state.records ? state : { ...state, records };
    }, source, current);
  }
}

function parseSaved(raw: Record<string, unknown>): Saved {
  if (raw.version !== 1 || !Array.isArray(raw.migrated) || !raw.migrated.every((k) => typeof k === 'string' && k.length <= 160)) throw new Error('Invalid shared project links.');
  return { version: 1, records: mergeProjectLinkRecords([], parseProjectLinkRecords(raw.records)), migrated: raw.migrated as string[] };
}
let store: ProjectLinksStore | undefined;
export function projectLinksStore(): ProjectLinksStore {
  if (store) return store;
  let unreadable = false;
  const disk = createSettingsStore<Saved>('network-project-links.json', { version: 1, records: [], migrated: [] }, parseSaved, {
    atomic: true, mode: 0o600, rollBackFailedSaves: true,
    onLoad: (result) => {
      if ('error' in result) unreadable = (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT';
      else { try { parseSaved(JSON.parse(result.raw)); } catch { unreadable = true; /* telemetry-exempt: never overwrite an unreadable shared record */ } }
    },
  });
  store = new ProjectLinksStore({
    read: () => { const value = disk.get(); if (unreadable) throw new Error('Shared project links could not be read.'); return value; },
    save: (value, current) => disk.save(value, { prepare: async () => {}, check: () => { if (current && !current()) throw new Error('Project link pairing changed.'); } }),
    self: () => getIdentity()?.fingerprint.toLowerCase() ?? null,
    legacyMirror: () => {
      try { const raw = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'handoff-project-links.json'), 'utf8')); return { links: raw.groups }; }
      catch (error) { // telemetry-exempt: no legacy file is normal; corrupt legacy values are left untouched
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') appLog('core:annex', 'warn', 'Legacy project links could not be imported');
        return undefined;
      }
    },
  });
  return store;
}
export function hydrateProjectLinks(legacy?: unknown): Promise<ProjectLinksView> { return projectLinksStore().migrate(legacy); }
export async function changeProjectLinks(raw: unknown): Promise<ProjectLinksView> {
  const origin = currentSettingsOrigin();
  if (origin.surface !== 'ui' || origin.actorId) throw new Error('Only the person can link projects.');
  const view = await projectLinksStore().apply(raw);
  await auditChanged('app', 'annex.project_links');
  return view;
}
/** Undefined while the legacy mirror has not been imported, so old handoff checks can still use it. */
export function sharedHandoffProjectsLinked(local: string, sourceMachine: string, sourceProject: string, localSource: boolean): boolean | undefined {
  const self = getIdentity()?.fingerprint.toLowerCase();
  const shared = projectLinksStore();
  if (!self || !shared.ready()) return undefined;
  return shared.groups().some((group) => group.some((p) => p.machine === self && p.projectId === local)
    && group.some((p) => p.machine === (localSource ? self : sourceMachine.toLowerCase()) && p.projectId === sourceProject));
}
export function _resetProjectLinksStoreForTesting(): void { store = undefined; }
