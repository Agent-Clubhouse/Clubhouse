import { ipcMain, dialog, BrowserWindow } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { IPC } from '../../shared/ipc-channels';
import type { BlueprintSummary } from '../../shared/blueprint-summary';
import * as projectStore from '../services/project-store';
import { appLog } from '../services/log-service';
import { stringArg, withValidatedArgs } from './validation';
import { assertAllowedPath } from '../services/path-sandbox';

const BLUEPRINTS_DIR = 'blueprints';
const CLUBHOUSE_DIR = '.clubhouse';
const MAX_BLUEPRINT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Parse a blueprint JSON file and extract summary metadata.
 * Supports both CanvasBlueprint (existing) and BlueprintManifest (Mission 50) formats.
 */
function extractSummary(filePath: string, data: Record<string, unknown>, source: string): BlueprintSummary {
  const name = (typeof data.name === 'string' && data.name) || path.basename(filePath, '.json');
  const description = typeof data.description === 'string' ? data.description : undefined;
  const version = typeof data.version === 'number' ? data.version : (typeof data.schemaVersion === 'number' ? data.schemaVersion : 0);

  // BlueprintManifest format (Mission 50): nested canvas.views / canvas.wires
  const canvas = typeof data.canvas === 'object' && data.canvas !== null ? data.canvas as Record<string, unknown> : null;
  const views: unknown[] = canvas && Array.isArray(canvas.views)
    ? canvas.views
    : Array.isArray(data.views) ? data.views : [];

  const wires: unknown[] = canvas && Array.isArray(canvas.wires) ? canvas.wires : [];

  const agentCount = views.filter(
    (v) => typeof v === 'object' && v !== null && (v as Record<string, unknown>).type === 'agent',
  ).length;

  // Also count agents array if present (BlueprintManifest)
  const agents = Array.isArray(data.agents) ? data.agents as Record<string, unknown>[] : [];
  const agentDefs = agents.length;

  // Extract agent names for search
  const agentNames: string[] = agents
    .map((a) => typeof a.name === 'string' ? a.name : '')
    .filter(Boolean);
  // Also extract from agent-type views if no agents array
  if (agentNames.length === 0) {
    for (const v of views) {
      if (typeof v === 'object' && v !== null) {
        const title = (v as Record<string, unknown>).title;
        const type = (v as Record<string, unknown>).type;
        if (type === 'agent' && typeof title === 'string') agentNames.push(title);
      }
    }
  }

  const createdAt = typeof data.createdAt === 'string' ? data.createdAt : undefined;

  return {
    filePath,
    name,
    description,
    viewCount: views.length,
    agentCount: Math.max(agentCount, agentDefs),
    wireCount: wires.length,
    version,
    source,
    createdAt,
    agentNames,
  };
}

export function registerBlueprintHandlers(): void {
  // SAVE_DIALOG — from Mission 51 (blueprint export)
  ipcMain.handle(IPC.BLUEPRINT.SAVE_DIALOG, withValidatedArgs(
    [stringArg()],
    async (_event, defaultName: string) => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { canceled: true };
      const result = await dialog.showSaveDialog(win, {
        title: 'Save Blueprint',
        defaultPath: defaultName,
        filters: [{ name: 'Blueprint files', extensions: ['json'] }],
      });
      return { canceled: result.canceled, filePath: result.filePath };
    },
  ));

  /**
   * BLUEPRINT.LIST — Scan .clubhouse/blueprints/*.json across all project paths.
   * Returns BlueprintSummary[] with parsed metadata from each valid blueprint file.
   */
  ipcMain.handle(IPC.BLUEPRINT.LIST, async (): Promise<BlueprintSummary[]> => {
    const projects = await projectStore.list();
    const summaries: BlueprintSummary[] = [];

    for (const project of projects) {
      const blueprintsDir = path.join(project.path, CLUBHOUSE_DIR, BLUEPRINTS_DIR);
      try {
        await fsp.access(blueprintsDir);
      } catch {
        continue; // No blueprints directory in this project
      }

      let entries: import('fs').Dirent[];
      try {
        entries = await fsp.readdir(blueprintsDir, { withFileTypes: true });
      } catch (err) {
        appLog('core:blueprint', 'error', 'Failed to read blueprints directory', {
          meta: { path: blueprintsDir, error: err instanceof Error ? err.message : String(err) },
        });
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

        const filePath = path.join(blueprintsDir, entry.name);
        try {
          const stat = await fsp.stat(filePath);
          if (stat.size > MAX_BLUEPRINT_SIZE_BYTES) {
            appLog('core:blueprint', 'warn', 'Skipping oversized blueprint file', {
              meta: { filePath, sizeBytes: stat.size, limitBytes: MAX_BLUEPRINT_SIZE_BYTES },
            });
            continue;
          }
          const raw = await fsp.readFile(filePath, 'utf-8');
          const data = JSON.parse(raw) as Record<string, unknown>;
          const source = project.displayName || project.name || path.basename(project.path);
          summaries.push(extractSummary(filePath, data, source));
        } catch (err) {
          appLog('core:blueprint', 'warn', 'Skipping invalid blueprint file', {
            meta: { filePath, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }

    return summaries;
  });

  /**
   * BLUEPRINT.READ — Read and parse a single blueprint file by absolute path.
   * Returns the parsed JSON object, or null if the file doesn't exist or is invalid.
   */
  ipcMain.handle(IPC.BLUEPRINT.READ, withValidatedArgs([stringArg()], async (_event, filePath: string): Promise<Record<string, unknown> | null> => {
    try {
      await assertAllowedPath(filePath);
      const stat = await fsp.stat(filePath);
      if (stat.size > MAX_BLUEPRINT_SIZE_BYTES) {
        appLog('core:blueprint', 'warn', 'Refusing to read oversized blueprint file', {
          meta: { filePath, sizeBytes: stat.size, limitBytes: MAX_BLUEPRINT_SIZE_BYTES },
        });
        return null;
      }
      const raw = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      appLog('core:blueprint', 'error', 'Failed to read blueprint file', {
        meta: { filePath, error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }));

  /**
   * BLUEPRINT.DELETE — Delete a blueprint file by absolute path.
   * Returns true if deleted, false if not found or error.
   */
  ipcMain.handle(IPC.BLUEPRINT.DELETE, withValidatedArgs([stringArg()], async (_event, filePath: string): Promise<boolean> => {
    // Safety: only delete .json files inside a .clubhouse/blueprints/ directory
    // Use assertAllowedPath + realpath to prevent traversal via symlinks or ../
    try {
      await assertAllowedPath(filePath);
    } catch {
      appLog('core:blueprint', 'warn', 'Refusing to delete file outside allowed directories', {
        meta: { filePath },
      });
      return false;
    }
    let resolved: string;
    try {
      resolved = await fsp.realpath(path.resolve(filePath));
    } catch {
      // File doesn't exist
      return false;
    }
    // Mission 74: normalize separators to forward slashes before the suffix
    // check. Native realpath returns backslashes on Windows and forward slashes
    // elsewhere, but the security invariant ("must be inside .clubhouse/blueprints/")
    // is platform-independent. Comparing in a single canonical form avoids
    // false rejections on Windows.
    const resolvedFwd = resolved.replace(/\\/g, '/');
    const blueprintsSuffix = `${CLUBHOUSE_DIR}/${BLUEPRINTS_DIR}/`;
    if (!resolvedFwd.includes(blueprintsSuffix) || !resolvedFwd.endsWith('.json')) {
      appLog('core:blueprint', 'warn', 'Refusing to delete file outside blueprints directory', {
        meta: { filePath, resolved },
      });
      return false;
    }
    try {
      await fsp.unlink(resolved);
      return true;
    } catch (err) {
      appLog('core:blueprint', 'error', 'Failed to delete blueprint file', {
        meta: { filePath, error: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  }));
}
