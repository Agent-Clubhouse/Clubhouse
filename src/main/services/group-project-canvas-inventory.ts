import { createHash } from 'crypto';
import { findTargetCanvasHits } from '../../shared/canvas-persistence';
import { removeGroupProjectCanvasReferences, stripDeletedGroupProjectsFromCanvasKey } from '../../shared/group-project-canvas-cascade';
import { readAllCanvasStores, readKvKey, type CanvasStoreLocation } from './canvas-store-reader';
import type { PluginStorageWriteRequest } from '../../shared/plugin-types';

interface CanvasEntry { location: CanvasStoreLocation; key: string; value: unknown }
export interface GroupProjectCanvasInventory { canvases: string[]; revision: string; entries: CanvasEntry[] }

/** Read active stores strictly. Recovery snapshots may contain deliberately malformed data. */
export async function readGroupProjectCanvasInventory(id: string): Promise<GroupProjectCanvasInventory> {
  const stores = await readAllCanvasStores({ strict: true });
  const entries: CanvasEntry[] = [];
  const canvases: string[] = [];
  for (const store of stores) {
    const label = store.location.scope === 'app' ? 'Home' : store.location.projectName;
    if (!store.canvases || !store.wires) throw new Error(`Canvas inventory is incomplete for ${label}: ${store.problems.join('; ')}`);
    for (const hit of findTargetCanvasHits(store.canvases, 'group-project', id)) canvases.push(`${label} / ${hit.name}`);
    const keys = new Set(['canvas-instances', 'canvas-instances-backup', 'canvas-wires', 'canvas-zone-wires']);
    for (const key of [...keys].sort()) {
      const result = await readKvKey(store.location.kvDir, key, { strict: true });
      if (result.status === 'unreadable') throw new Error(`Canvas inventory is incomplete for ${label} (${key}): ${result.error}`);
      if (result.status === 'ok') {
        // Validate active keys before a tombstone is written. Write filtering
        // remains tolerant so a degraded Canvas can still save recovery data.
        try {
          if (key.startsWith('canvas-instances')) removeGroupProjectCanvasReferences(result.value, [], [], id);
          else if (key === 'canvas-wires') removeGroupProjectCanvasReferences([], result.value, [], id);
          else removeGroupProjectCanvasReferences([], [], result.value, id);
        } catch { throw new Error(`Canvas inventory is incomplete for ${label} (${key}). Repair the canvas before deleting.`); }
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
