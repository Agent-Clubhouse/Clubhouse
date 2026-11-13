import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { findTargetCanvasHits } from '../../shared/canvas-persistence';
import { stripDeletedGroupProjectsFromCanvasKey } from '../../shared/group-project-canvas-cascade';
import { readAllCanvasStores, readKvKey, type CanvasStoreLocation } from './canvas-store-reader';
import type { PluginStorageWriteRequest } from '../../shared/plugin-types';

interface CanvasEntry { location: CanvasStoreLocation; key: string; value: unknown }
export interface GroupProjectCanvasInventory { canvases: string[]; revision: string; entries: CanvasEntry[] }

/** Read strictly, including logical backups and recovery snapshots, without changing a store. */
export async function readGroupProjectCanvasInventory(id: string): Promise<GroupProjectCanvasInventory> {
  const stores = await readAllCanvasStores({ strict: true });
  const entries: CanvasEntry[] = [];
  const canvases: string[] = [];
  for (const store of stores) {
    if (!store.canvases || !store.wires) throw new Error(`Canvas inventory is incomplete: ${store.problems.join('; ')}`);
    const label = store.location.scope === 'app' ? 'Home' : store.location.projectName;
    for (const hit of findTargetCanvasHits(store.canvases, 'group-project', id)) canvases.push(`${label} / ${hit.name}`);
    let names: string[];
    try { names = await fs.readdir(store.location.kvDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
      else throw error;
    }
    const keys = new Set(['canvas-instances', 'canvas-instances-backup', 'canvas-wires', 'canvas-zone-wires']);
    for (const name of names) {
      if (/^canvas-instances-recovery-.*\.json$/.test(name)) keys.add(name.slice(0, -5));
    }
    for (const key of [...keys].sort()) {
      const result = await readKvKey(store.location.kvDir, key, { strict: true });
      if (result.status === 'unreadable') throw new Error(`Canvas inventory is incomplete: ${result.error}`);
      if (result.status === 'ok') {
        // Validate every affected key now, before any cascade writes.
        stripDeletedGroupProjectsFromCanvasKey(key, result.value, [id]);
        entries.push({ location: store.location, key, value: result.value });
      }
    }
  }
  const revision = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { canvases: canvases.sort(), revision, entries };
}

/** Caller must hold the canvas write barrier throughout revalidation and writes. */
export async function removeGroupProjectFromCanvasInventory(
  inventory: GroupProjectCanvasInventory,
  id: string,
  write: (request: PluginStorageWriteRequest) => Promise<void>,
): Promise<void> {
  for (const entry of inventory.entries) {
    const value = stripDeletedGroupProjectsFromCanvasKey(entry.key, entry.value, [id]);
    if (JSON.stringify(value) === JSON.stringify(entry.value)) continue;
    await write({ pluginId: 'canvas', scope: entry.location.scope === 'app' ? 'global' : 'project-local',
      ...(entry.location.scope === 'project' ? { projectPath: entry.location.projectPath } : {}), key: entry.key, value });
  }
}
