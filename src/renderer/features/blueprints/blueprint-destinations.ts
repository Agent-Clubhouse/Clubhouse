// ── Blueprint export destinations ────────────────────────────────────
//
// Three ways to save an exported blueprint:
//   1. .clubhouse/blueprints/ directory in the project
//   2. System clipboard
//   3. Native save dialog (user picks location)

import type { BlueprintManifest } from '../../../shared/blueprint-types';
import { serializeManifest, slugify } from './blueprint-export';

export type ExportDestination = 'blueprints-dir' | 'clipboard' | 'file';

export interface ExportResult {
  success: boolean;
  destination: ExportDestination;
  filePath?: string;
  error?: string;
}

/**
 * Save a blueprint to the `.clubhouse/blueprints/` directory within the project.
 */
export async function saveToBlueprintsDir(
  manifest: BlueprintManifest,
  projectPath: string,
): Promise<ExportResult> {
  const json = serializeManifest(manifest);
  const filename = `${slugify(manifest.name)}.json`;
  const dirPath = `${projectPath}/.clubhouse/blueprints`;
  const filePath = `${dirPath}/${filename}`;

  try {
    await window.clubhouse.file.mkdir(dirPath);
    await window.clubhouse.file.write(filePath, json);
    return { success: true, destination: 'blueprints-dir', filePath };
  } catch (err) {
    return {
      success: false,
      destination: 'blueprints-dir',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Copy a blueprint to the system clipboard as JSON.
 */
export async function saveToClipboard(
  manifest: BlueprintManifest,
): Promise<ExportResult> {
  const json = serializeManifest(manifest);
  try {
    await navigator.clipboard.writeText(json);
    return { success: true, destination: 'clipboard' };
  } catch (err) {
    return {
      success: false,
      destination: 'clipboard',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Open a native save dialog and write the blueprint to the chosen location.
 */
export async function saveToFile(
  manifest: BlueprintManifest,
): Promise<ExportResult> {
  const defaultName = `${slugify(manifest.name)}.json`;

  try {
    const result = await window.clubhouse.blueprint.saveDialog(defaultName);
    if (result.canceled || !result.filePath) {
      return { success: false, destination: 'file', error: 'Cancelled' };
    }

    const json = serializeManifest(manifest);
    await window.clubhouse.file.write(result.filePath, json);
    return { success: true, destination: 'file', filePath: result.filePath };
  } catch (err) {
    return {
      success: false,
      destination: 'file',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
