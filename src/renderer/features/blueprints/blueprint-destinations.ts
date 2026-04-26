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
 *
 * Uses the combined `blueprint.saveToFile` IPC so that the user-picked path
 * is honored verbatim — including paths outside any registered project
 * directory (e.g. ~/Desktop, ~/Documents). The dialog itself is the consent
 * gate; the renderer never gets to supply a target path directly.
 */
export async function saveToFile(
  manifest: BlueprintManifest,
): Promise<ExportResult> {
  const defaultName = `${slugify(manifest.name)}.json`;
  const json = serializeManifest(manifest);

  try {
    const result = await window.clubhouse.blueprint.saveToFile(defaultName, json);
    if (result.canceled) {
      return { success: false, destination: 'file', error: 'Cancelled' };
    }
    if (result.error) {
      return { success: false, destination: 'file', error: result.error, filePath: result.filePath };
    }
    return { success: true, destination: 'file', filePath: result.filePath };
  } catch (err) {
    return {
      success: false,
      destination: 'file',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
