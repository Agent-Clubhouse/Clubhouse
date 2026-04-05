// ── Blueprint Bundle — project-level multi-canvas export/import ──────
//
// Exports all canvases in a project as a single BlueprintBundle,
// and imports bundles by creating multiple canvases.

import type { CanvasInstance } from '../../plugins/builtin/canvas/canvas-types';
import type { McpBindingEntry } from '../../stores/mcpBindingStore';
import type { Agent, Project } from '../../../shared/types';
import type {
  BlueprintBundle,
  BlueprintBundleMetadata,
  BlueprintManifest,
} from '../../../shared/blueprint-types';
import { exportCanvasToBlueprint, slugify, type ExportContext } from './blueprint-export';
import { importBlueprint } from '../../plugins/builtin/canvas/canvas-blueprint';

// ── Bundle export ───────────────────────────────────────────────────

export interface BundleExportContext {
  /** All agents indexed by ID. */
  agents: Record<string, Agent>;
  /** All projects indexed by ID. */
  projects: Record<string, Project>;
  /** Wire definitions from the canvas store. */
  wireDefinitions: McpBindingEntry[];
  /** The project ID this bundle belongs to. */
  projectId: string;
  /** Absolute path of the exporting project. */
  exportProjectPath: string;
  /** Project display name. */
  projectName: string;
  /** App version string. */
  appVersion?: string;
}

/**
 * Export all canvases in a project as a BlueprintBundle.
 */
export function exportProjectBundle(
  canvases: CanvasInstance[],
  ctx: BundleExportContext,
): BlueprintBundle {
  const exportCtx: ExportContext = {
    agents: ctx.agents,
    projects: ctx.projects,
    wireDefinitions: ctx.wireDefinitions,
    projectId: ctx.projectId,
    exportProjectPath: ctx.exportProjectPath,
    appVersion: ctx.appVersion,
  };

  const blueprints: BlueprintManifest[] = canvases.map((canvas) =>
    exportCanvasToBlueprint(canvas, exportCtx),
  );

  const metadata: BlueprintBundleMetadata = {
    projectName: ctx.projectName,
    canvasCount: blueprints.length,
    totalViews: blueprints.reduce((sum, bp) => sum + bp.canvas.views.length, 0),
    totalWires: blueprints.reduce((sum, bp) => sum + bp.canvas.wires.length, 0),
    totalAgents: blueprints.reduce((sum, bp) => sum + (bp.agents?.length ?? 0), 0),
  };

  return {
    id: crypto.randomUUID(),
    name: ctx.projectName,
    version: '1.0.0',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    exportedFrom: ctx.appVersion,
    blueprints,
    metadata,
  };
}

// ── Bundle serialization ────────────────────────────────────────────

/** Recursive key-sorting replacer for deterministic JSON output. */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

export function serializeBundle(bundle: BlueprintBundle): string {
  return JSON.stringify(bundle, sortedReplacer, 2);
}

// ── Bundle import ───────────────────────────────────────────────────

export interface BundleImportResult {
  canvases: CanvasInstance[];
  totalAgentStubs: number;
  errors: string[];
}

/**
 * Validate a parsed object as a BlueprintBundle.
 */
export function validateBundle(data: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Expected an object'] };
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.schemaVersion !== 'number' || obj.schemaVersion !== 1) {
    errors.push(`Unsupported schemaVersion: ${obj.schemaVersion ?? 'missing'}`);
  }

  if (!Array.isArray(obj.blueprints)) {
    errors.push('Missing or invalid "blueprints" array');
    return { valid: false, errors };
  }

  if (obj.blueprints.length === 0) {
    errors.push('Bundle contains no blueprints');
  }

  for (let i = 0; i < obj.blueprints.length; i++) {
    const bp = obj.blueprints[i] as Record<string, unknown>;
    if (!bp || typeof bp !== 'object') {
      errors.push(`Blueprint at index ${i} is not an object`);
      continue;
    }
    if (!bp.canvas || typeof bp.canvas !== 'object') {
      errors.push(`Blueprint at index ${i} missing "canvas" property`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Import a BlueprintBundle, creating a CanvasInstance for each blueprint.
 */
export function importBundle(bundle: BlueprintBundle): BundleImportResult {
  const canvases: CanvasInstance[] = [];
  const errors: string[] = [];
  let totalAgentStubs = 0;

  for (let i = 0; i < bundle.blueprints.length; i++) {
    const manifest = bundle.blueprints[i];
    try {
      // Convert manifest to the simpler CanvasBlueprint format for importBlueprint()
      const canvasBlueprint = {
        version: 1,
        name: manifest.name,
        views: manifest.canvas.views.map((v) => ({
          type: v.type as 'agent' | 'anchor' | 'plugin' | 'sticky-note' | 'zone',
          title: v.displayName,
          position: v.position,
          size: v.size ?? { width: 480, height: 480 },
          metadata: (v.metadata ?? {}) as Record<string, unknown>,
          projectId: v.projectRef,
          content: v.content,
          color: v.color,
          pluginWidgetType: v.metadata?.pluginWidgetType as string | undefined,
          pluginId: v.metadata?.pluginId as string | undefined,
          themeId: v.metadata?.themeId as string | undefined,
          label: v.displayName,
        })),
      };
      const canvas = importBlueprint(canvasBlueprint);
      canvases.push(canvas);
      totalAgentStubs += manifest.agents?.length ?? 0;
    } catch (err) {
      errors.push(`Failed to import "${manifest.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { canvases, totalAgentStubs, errors };
}

// ── Bundle destinations ─────────────────────────────────────────────

export type BundleExportDestination = 'blueprints-dir' | 'clipboard' | 'file';

export interface BundleExportResult {
  success: boolean;
  destination: BundleExportDestination;
  filePath?: string;
  error?: string;
}

export async function saveBundleToBlueprintsDir(
  bundle: BlueprintBundle,
  projectPath: string,
): Promise<BundleExportResult> {
  const json = serializeBundle(bundle);
  const filename = `${slugify(bundle.name)}-bundle.json`;
  const dirPath = `${projectPath}/.clubhouse/blueprints`;
  const filePath = `${dirPath}/${filename}`;

  try {
    await window.clubhouse.file.mkdir(dirPath);
    await window.clubhouse.file.write(filePath, json);
    return { success: true, destination: 'blueprints-dir', filePath };
  } catch (err) {
    return { success: false, destination: 'blueprints-dir', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function saveBundleToClipboard(bundle: BlueprintBundle): Promise<BundleExportResult> {
  try {
    await navigator.clipboard.writeText(serializeBundle(bundle));
    return { success: true, destination: 'clipboard' };
  } catch (err) {
    return { success: false, destination: 'clipboard', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function saveBundleToFile(bundle: BlueprintBundle): Promise<BundleExportResult> {
  const defaultName = `${slugify(bundle.name)}-bundle.json`;
  try {
    const result = await window.clubhouse.blueprint.saveDialog(defaultName);
    if (result.canceled || !result.filePath) {
      return { success: false, destination: 'file', error: 'Cancelled' };
    }
    await window.clubhouse.file.write(result.filePath, serializeBundle(bundle));
    return { success: true, destination: 'file', filePath: result.filePath };
  } catch (err) {
    return { success: false, destination: 'file', error: err instanceof Error ? err.message : String(err) };
  }
}
