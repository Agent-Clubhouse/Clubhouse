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

async function readJsonFile(file: string): Promise<KvRead> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch (err) {
    // telemetry-exempt: returned as missing/unreadable; the caller logs a skipped store
    return isMissingFileError(err) ? { status: 'missing' } : { status: 'unreadable', error: errorMessage(err) };
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
export async function readKvKey(kvDir: string, key: string): Promise<KvRead> {
  const file = path.join(kvDir, `${key}.json`);
  const primary = await readJsonFile(file);
  if (primary.status === 'ok') return primary;
  const backup = await readJsonFile(`${file}.bak`);
  if (backup.status === 'ok') return backup;
  if (primary.status === 'unreadable') return primary;
  if (backup.status === 'unreadable') return backup;
  return { status: 'missing' };
}

function normalizeViews(raw: unknown): CanvasViewLike[] {
  if (!Array.isArray(raw)) return [];
  const views: CanvasViewLike[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const view = v as Record<string, unknown>;
    if (typeof view.id !== 'string') continue;
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

function normalizeInstances(raw: unknown): CanvasInstanceLike[] | null {
  // A saved canvas is always a non-empty array of instances.
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: CanvasInstanceLike[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const inst = c as Record<string, unknown>;
    if (typeof inst.id !== 'string') continue;
    out.push({
      id: inst.id,
      name: typeof inst.name === 'string' ? inst.name : inst.id,
      views: normalizeViews(inst.views),
    });
  }
  return out;
}

/**
 * The canvases in one store: the primary copy, else the backup copy the
 * canvas plugin writes alongside it. An empty list means the store has no
 * canvases yet; null means the data is there but could not be used.
 */
async function readInstances(kvDir: string): Promise<{ canvases: CanvasInstanceLike[] | null; problem?: string }> {
  const primary = await readKvKey(kvDir, KEY_INSTANCES);
  if (primary.status === 'ok') {
    const canvases = normalizeInstances(primary.value);
    if (canvases) return { canvases };
  }
  const backup = await readKvKey(kvDir, KEY_INSTANCES_BACKUP);
  if (backup.status === 'ok') {
    const canvases = normalizeInstances(backup.value);
    if (canvases) return { canvases };
  }
  if (primary.status === 'missing' && backup.status === 'missing') return { canvases: [] };
  const why = primary.status === 'unreadable' ? primary.error
    : backup.status === 'unreadable' ? backup.error
      : 'instances are not a non-empty array';
  return { canvases: null, problem: `canvas instances unusable: ${why}` };
}

async function readWires(kvDir: string): Promise<{ wires: PersistedCanvasWire[] | null; problem?: string }> {
  const read = await readKvKey(kvDir, KEY_WIRES);
  if (read.status === 'missing') return { wires: [] };
  if (read.status === 'unreadable') return { wires: null, problem: `canvas wires unreadable: ${read.error}` };
  if (!Array.isArray(read.value)) return { wires: null, problem: 'canvas wires are not an array' };
  return { wires: read.value as PersistedCanvasWire[] };
}

/** Read one canvas store. Never throws and never writes. */
export async function readCanvasStore(location: CanvasStoreLocation): Promise<CanvasStoreSnapshot> {
  const [instances, wires] = await Promise.all([readInstances(location.kvDir), readWires(location.kvDir)]);
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
  return Promise.all(locations.map(readCanvasStore));
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
  const snapshots = await Promise.all(wanted.map(readCanvasStore));
  return snapshots.flatMap((s) => toMemberships(s, agentId));
}
