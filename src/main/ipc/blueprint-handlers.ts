import { ipcMain, dialog, BrowserWindow } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { IPC } from '../../shared/ipc-channels';
import type { BlueprintSummary } from '../../shared/blueprint-summary';
import * as projectStore from '../services/project-store';
import { appLog } from '../services/log-service';
import { stringArg, withValidatedArgs } from './validation';

const BLUEPRINTS_DIR = 'blueprints';
const CLUBHOUSE_DIR = '.clubhouse';

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
  const agentDefs = Array.isArray(data.agents) ? data.agents.length : 0;

  return {
    filePath,
    name,
    description,
    viewCount: views.length,
    agentCount: Math.max(agentCount, agentDefs),
    wireCount: wires.length,
    version,
    source,
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
      const raw = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      appLog('core:blueprint', 'error', 'Failed to read blueprint file', {
        meta: { filePath, error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }));
}
