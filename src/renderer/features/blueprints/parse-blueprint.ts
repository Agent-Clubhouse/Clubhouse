// ── Unified blueprint parser ─────────────────────────────────────────
//
// Detects whether arbitrary JSON data is a legacy CanvasBlueprint or a
// modern BlueprintManifest, validates it, and routes it to the correct
// importer. Used by drag-and-drop, paste, the Blueprint Gallery cards and the
// "Open from file…" picker, so all four entry points share one code path:
// parseAnyBlueprint produces the canvas and its wire plan
// (blueprint-wire-plan.ts), and applyParsedBlueprint is the only place an
// import touches a canvas store.

import type { CanvasInstance } from '../../plugins/builtin/canvas/canvas-types';
import type { McpBindingEntry } from '../../stores/mcpBindingStore';
import type { BlueprintWire } from '../../../shared/blueprint-types';
import { EMPTY_WIRE_PLAN, planBlueprintWires, type BlueprintWirePlan } from './blueprint-wire-plan';
import { importBlueprint as legacyImportBlueprint, validateBlueprint as legacyValidate } from '../../plugins/builtin/canvas/canvas-blueprint';
import { importBlueprint as manifestImportBlueprint, type ExistingProject, type AgentStubInfo, type ProjectMatchResult } from './blueprint-import';
import type { Agent } from '../../../shared/types';

// ── Format detection ────────────────────────────────────────────────

export type BlueprintFormat = 'manifest' | 'legacy';

/**
 * Inspect a JSON value and decide which blueprint format it claims to be.
 * Throws with a user-facing message if the shape is recognisable as neither.
 */
export function detectBlueprintFormat(data: unknown): BlueprintFormat {
  if (!data || typeof data !== 'object') {
    throw new Error('Not a blueprint: expected a JSON object');
  }
  const obj = data as Record<string, unknown>;

  // Manifest format is identified by schemaVersion + a nested canvas object.
  // The top-level `version` field is a free-form semver string that is
  // informational only — schemaVersion drives compatibility.
  if (typeof obj.schemaVersion === 'number') {
    if (obj.schemaVersion !== 1) {
      throw new Error(`Unsupported blueprint schemaVersion: ${String(obj.schemaVersion)} (expected 1)`);
    }
    if (typeof obj.canvas !== 'object' || obj.canvas === null) {
      throw new Error('Invalid blueprint: schemaVersion 1 requires a "canvas" object');
    }
    return 'manifest';
  }

  // Legacy format has a numeric `version` and a top-level `views` array.
  if (typeof obj.version === 'number' && Array.isArray(obj.views)) {
    return 'legacy';
  }

  throw new Error('Not a recognisable blueprint (missing schemaVersion or numeric version)');
}

// ── Parse result ────────────────────────────────────────────────────

export interface ParseContext {
  /** Existing agents on this machine — used to match manifest agentRefs. */
  agents: Agent[];
  /** Existing projects on this machine — used to match manifest projectRefs. */
  projects: ExistingProject[];
  /** The project the importing canvas should belong to, if any. */
  activeProjectId?: string;
}

export interface ParseResult {
  format: BlueprintFormat;
  canvas: CanvasInstance;
  /** What the blueprint's wires become: created now, deferred until a stub is bound, or skipped. */
  wires: BlueprintWirePlan;
  /** Manifest-only: the blueprint's wires as written. */
  pendingWires: BlueprintWire[];
  /** Manifest-only: blueprint refId → runtime view ID. */
  refIdToViewId: Map<string, string>;
  /** Manifest-only: agent stubs awaiting binding. */
  stubs: AgentStubInfo[];
  /** Manifest-only: how each project ref resolved against existing projects. */
  projectMatches: ProjectMatchResult[];
}

// ── Parse + import ──────────────────────────────────────────────────

/**
 * Parse arbitrary JSON data as a blueprint and produce a ready-to-insert
 * canvas. Throws with a user-facing message on validation failure.
 *
 * Manifest imports require `ctx` so they can match agents/projects against
 * what already exists on this machine. Legacy imports ignore `ctx`.
 */
export function parseAnyBlueprint(data: unknown, ctx?: ParseContext): ParseResult {
  const format = detectBlueprintFormat(data);

  if (format === 'manifest') {
    const safeCtx: ParseContext = ctx ?? { agents: [], projects: [] };
    const result = manifestImportBlueprint(
      data as Parameters<typeof manifestImportBlueprint>[0],
      safeCtx.agents,
      safeCtx.projects,
      safeCtx.activeProjectId,
    );
    return {
      format,
      canvas: result.canvas,
      wires: planBlueprintWires(result.pendingWires, result.refIdToViewId, result.canvas.views),
      pendingWires: result.pendingWires,
      refIdToViewId: result.refIdToViewId,
      stubs: result.stubs,
      projectMatches: result.projectMatches,
    };
  }

  const error = legacyValidate(data);
  if (error) throw new Error(error);
  const canvas = legacyImportBlueprint(data as Parameters<typeof legacyImportBlueprint>[0]);
  return {
    format,
    canvas,
    // Legacy blueprints carry no wires.
    wires: EMPTY_WIRE_PLAN,
    pendingWires: [],
    refIdToViewId: new Map(),
    stubs: [],
    projectMatches: [],
  };
}

/**
 * JSON.parse with a friendlier error, then run parseAnyBlueprint on the
 * result. Most consumers want this — they have raw text, not a parsed object.
 */
export function parseAnyBlueprintText(text: string, ctx?: ParseContext): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file');
  }
  return parseAnyBlueprint(data, ctx);
}

// ── Applying an import ──────────────────────────────────────────────

/** Where an import lands: the canvas store of the gallery's target or the canvas being dropped/pasted on. */
export interface BlueprintImportTarget {
  insertCanvas: (canvas: CanvasInstance) => void | Promise<void>;
  addWireDefinition: (wire: McpBindingEntry) => void;
}

/**
 * Insert the imported canvas, then add the wires its plan creates. Deferred
 * and skipped wires are left in `result.wires` for the caller to report or
 * resolve later.
 */
export async function applyParsedBlueprint(result: ParseResult, target: BlueprintImportTarget): Promise<void> {
  await target.insertCanvas(result.canvas);
  for (const wire of result.wires.create) target.addWireDefinition(wire);
}
