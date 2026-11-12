/**
 * Read-only access to the canvas plugin's persisted stores from the main
 * process (#1544).
 *
 * The canvas plugin owns these files and writes them from the renderer
 * (canvas-store.ts saveCanvas/saveWires through plugin-storage). The main
 * process reads them at startup to rebuild wire bindings and to index which
 * canvases hold which agents, before any canvas view has been opened.
 *
 * Nothing here writes, renames or quarantines a file: a corrupt or unreadable
 * copy is reported and skipped, and the renderer's own load path (with its
 * backup and recovery handling, #1561) deals with it when the canvas opens.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { getGlobalPluginDataDir } from './plugin-storage';
import * as projectStore from './project-store';
import { appLog } from './log-service';
import {
  REMOVED_CANVAS_VIEW_TYPES,
  findAgentCanvasHits,
  type AgentCanvasHit,
  type CanvasInstanceLike,
  type CanvasViewLike,
} from '../../shared/canvas-persistence';
import type { CanvasMembership, PersistedCanvasWire } from '../../shared/canvas-index-types';

const CANVAS_PLUGIN_ID = 'canvas';
const KEY_INSTANCES = 'canvas-instances';
const KEY_INSTANCES_BACKUP = 'canvas-instances-backup';
const KEY_WIRES = 'canvas-wires';

/** Where one canvas store lives: the app-wide (Home) store or a project's. */
export type CanvasStoreLocation =
  | { scope: 'app'; kvDir: string }
  | { scope: 'project'; projectId: string; projectName: string; projectPath: string; kvDir: string };

/** The result of reading one key: present, absent, or there but unusable. */
export type KvRead =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'unreadable'; error: string };

/** What one store holds, as far as the main process needs it. */
export interface CanvasStoreSnapshot {
  location: CanvasStoreLocation;
  /** Null when the instances could not be read (the store is skipped). */
  canvases: CanvasInstanceLike[] | null;
  /** Null when the wires could not be read (the store's wires are skipped). */
  wires: PersistedCanvasWire[] | null;
  /** Why canvases or wires is null, for the log. */
  problems: string[];
}

export interface CanvasStoreReadOptions {
  /** Refuse incomplete primary data instead of normalizing or recovering it. */
  strict?: boolean;
}

export function globalCanvasKvDir(): string {
  return path.join(getGlobalPluginDataDir(), CANVAS_PLUGIN_ID, 'kv');
}

export function projectCanvasKvDir(projectPath: string): string {
  return path.join(projectPath, '.clubhouse', 'plugin-data-local', CANVAS_PLUGIN_ID, 'kv');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissingFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function readJsonFile(file: string, strict = false): Promise<KvRead> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch (err) {
    // telemetry-exempt: returned as missing/unreadable; the caller logs a skipped store
    const missing = strict ? (err as NodeJS.ErrnoException)?.code === 'ENOENT' : isMissingFileError(err);
    return missing ? { status: 'missing' } : { status: 'unreadable', error: errorMessage(err) };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) };
  } catch (err) {
    // telemetry-exempt: returned as unreadable; the renderer's own load reports corrupt canvas data
    return { status: 'unreadable', error: `invalid JSON: ${errorMessage(err)}` };
  }
}

/**
 * Read one plugin-storage key the way plugin-storage's readKey does (primary,
 * then its `.bak` sibling) but without quarantining anything.
 */
export async function readKvKey(kvDir: string, key: string, options: CanvasStoreReadOptions = {}): Promise<KvRead> {
  const file = path.join(kvDir, `${key}.json`);
  const primary = await readJsonFile(file, options.strict);
  if (primary.status === 'ok') return primary;
  if (options.strict && primary.status === 'unreadable') return primary;
  const backup = await readJsonFile(`${file}.bak`, options.strict);
  if (options.strict && backup.status === 'ok') return { status: 'unreadable', error: 'only a recovery copy is present' };
  if (backup.status === 'ok') return backup;
  if (primary.status === 'unreadable') return primary;
  if (backup.status === 'unreadable') return backup;
  return { status: 'missing' };
}

function normalizeViews(raw: unknown, strict = false): CanvasViewLike[] | null {
  if (!Array.isArray(raw)) return strict ? null : [];
  const views: CanvasViewLike[] = [];
  const ids = new Set<string>();
  for (const v of raw) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      if (strict) return null;
      continue;
    }
    const view = v as Record<string, unknown>;
    if (typeof view.id !== 'string') {
      if (strict) return null;
      continue;
    }
    if (strict) {
      if (!view.id || ids.has(view.id)) return null;
      ids.add(view.id);
      if (typeof view.type !== 'string') return null;
      if (!REMOVED_CANVAS_VIEW_TYPES.has(view.type)
        && !['agent', 'anchor', 'plugin', 'sticky-note', 'zone'].includes(view.type)) return null;
      if (view.type === 'agent' && view.agentId !== null
        && (typeof view.agentId !== 'string' || !view.agentId)) return null;
      if (view.metadata !== undefined && view.metadata !== null
        && (typeof view.metadata !== 'object' || Array.isArray(view.metadata))) return null;
      const gpId = (view.metadata as Record<string, unknown> | null | undefined)?.groupProjectId;
      if (gpId !== undefined && gpId !== null && typeof gpId !== 'string') return null;
    }
    if (typeof view.type === 'string' && REMOVED_CANVAS_VIEW_TYPES.has(view.type)) continue;
    views.push({
      id: view.id,
      type: typeof view.type === 'string' ? view.type : undefined,
      agentId: typeof view.agentId === 'string' ? view.agentId : null,
      metadata: view.metadata && typeof view.metadata === 'object' ? view.metadata as Record<string, unknown> : null,
    });
  }
  return views;
}

function normalizeInstances(raw: unknown, strict = false): CanvasInstanceLike[] | null {
  // A saved canvas is always a non-empty array of instances.
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: CanvasInstanceLike[] = [];
  const ids = new Set<string>();
  for (const c of raw) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      if (strict) return null;
      continue;
    }
    const inst = c as Record<string, unknown>;
    if (typeof inst.id !== 'string') {
      if (strict) return null;
      continue;
    }
    if (strict && (!inst.id || ids.has(inst.id))) return null;
    ids.add(inst.id);
    const views = normalizeViews(inst.views, strict);
    if (!views) return null;
    out.push({
      id: inst.id,
      name: typeof inst.name === 'string' ? inst.name : inst.id,
      views,
    });
  }
  return out;
}

/**
 * The canvases in one store: the primary copy, else the backup copy the
 * canvas plugin writes alongside it. An empty list means the store has no
 * canvases yet; null means the data is there but could not be used.
 */
async function readInstances(kvDir: string, options: CanvasStoreReadOptions): Promise<{ canvases: CanvasInstanceLike[] | null; problem?: string }> {
  const primary = await readKvKey(kvDir, KEY_INSTANCES, options);
  if (primary.status === 'ok') {
    const canvases = normalizeInstances(primary.value, options.strict);
    if (canvases) return { canvases };
  }
  if (options.strict && primary.status !== 'missing') {
    return { canvases: null, problem: `canvas instances unusable: ${primary.status === 'unreadable' ? primary.error : 'invalid or ambiguous instance/view rows'}` };
  }
  const backup = await readKvKey(kvDir, KEY_INSTANCES_BACKUP, options);
  if (backup.status === 'ok') {
    if (options.strict) return { canvases: null, problem: 'canvas instances unusable: only a recovery key is present' };
    const canvases = normalizeInstances(backup.value, options.strict);
    if (canvases) return { canvases };
  }
  if (primary.status === 'missing' && backup.status === 'missing') return { canvases: [] };
  const why = primary.status === 'unreadable' ? primary.error
    : backup.status === 'unreadable' ? backup.error
      : 'instances are not a non-empty array';
  return { canvases: null, problem: `canvas instances unusable: ${why}` };
}

async function readWires(kvDir: string, options: CanvasStoreReadOptions): Promise<{ wires: PersistedCanvasWire[] | null; problem?: string }> {
  const read = await readKvKey(kvDir, KEY_WIRES, options);
  if (read.status === 'missing') return { wires: [] };
  if (read.status === 'unreadable') return { wires: null, problem: `canvas wires unreadable: ${read.error}` };
  if (!Array.isArray(read.value)) return { wires: null, problem: 'canvas wires are not an array' };
  if (options.strict) {
    const pairs = new Set<string>();
    for (const entry of read.value) {
      const wire = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
      if (!wire || !['agentId', 'targetId', 'label'].every((field) => typeof wire[field] === 'string' && wire[field])
        || typeof wire.targetKind !== 'string' || !['agent', 'browser', 'group-project'].includes(wire.targetKind)
        || ['agentName', 'targetName', 'projectName'].some((field) => wire[field] !== undefined && typeof wire[field] !== 'string')
        || (wire.disabledTools !== undefined && (!Array.isArray(wire.disabledTools) || !wire.disabledTools.every((tool) => typeof tool === 'string')))
        || (wire.instructions !== undefined && (!wire.instructions || typeof wire.instructions !== 'object'
          || Array.isArray(wire.instructions) || !Object.values(wire.instructions).every((value) => typeof value === 'string')))) {
        return { wires: null, problem: 'canvas wires contain invalid or unknown rows' };
      }
      const pair = JSON.stringify([wire.agentId, wire.targetId]);
      if (pairs.has(pair)) return { wires: null, problem: 'canvas wires contain duplicate endpoint identities' };
      pairs.add(pair);
    }
  }
  return { wires: read.value as PersistedCanvasWire[] };
}

/** Read one canvas store. Never throws and never writes. */
export async function readCanvasStore(location: CanvasStoreLocation, options: CanvasStoreReadOptions = {}): Promise<CanvasStoreSnapshot> {
  const [instances, wires] = await Promise.all([readInstances(location.kvDir, options), readWires(location.kvDir, options)]);
  const problems = [instances.problem, wires.problem].filter((p): p is string => !!p);
  return { location, canvases: instances.canvases, wires: wires.wires, problems };
}

/** The app-wide store plus one per registered local project. */
export async function listCanvasStoreLocations(): Promise<CanvasStoreLocation[]> {
  const locations: CanvasStoreLocation[] = [{ scope: 'app', kvDir: globalCanvasKvDir() }];
  let projects: Awaited<ReturnType<typeof projectStore.list>> = [];
  try {
    projects = await projectStore.list();
  } catch (err) {
    // telemetry-exempt: logged; only the app-wide store is read
    appLog('core:canvas-index', 'warn', 'Could not list projects for canvas stores', {
      meta: { error: errorMessage(err) },
    });
  }
  for (const p of projects) {
    if (!p.path) continue;
    locations.push({
      scope: 'project',
      projectId: p.id,
      projectName: p.displayName || p.name,
      projectPath: p.path,
      kvDir: projectCanvasKvDir(p.path),
    });
  }
  return locations;
}

/** Read every canvas store on this machine. */
export async function readAllCanvasStores(): Promise<CanvasStoreSnapshot[]> {
  const locations = await listCanvasStoreLocations();
  return Promise.all(locations.map((location) => readCanvasStore(location)));
}

function toMemberships(snapshot: CanvasStoreSnapshot, agentId: string): CanvasMembership[] {
  if (!snapshot.canvases) return [];
  const { location } = snapshot;
  return findAgentCanvasHits(snapshot.canvases, agentId).map((hit: AgentCanvasHit) => ({
    scope: location.scope,
    ...(location.scope === 'project' ? { projectId: location.projectId } : {}),
    canvasId: hit.canvasId,
    name: hit.name,
    viewId: hit.viewId,
  }));
}

/**
 * The canvases that hold a card for an agent, read from disk: the app-wide
 * (Home) store and, when given, the agent's own project store. This is the
 * lightweight index the agent details card uses before a canvas is opened.
 */
export async function getAgentCanvasMemberships(agentId: string, projectId?: string | null): Promise<CanvasMembership[]> {
  const locations = await listCanvasStoreLocations();
  const wanted = locations.filter((l) => l.scope === 'app' || (!!projectId && l.projectId === projectId));
  const snapshots = await Promise.all(wanted.map((location) => readCanvasStore(location)));
  return snapshots.flatMap((s) => toMemberships(s, agentId));
}
