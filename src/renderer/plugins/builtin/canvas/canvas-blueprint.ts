// ── Canvas Blueprint — portable export/import for canvas boards ──────
//
// A blueprint captures the *configuration* of a canvas — widget types,
// positions, sizes, metadata — while stripping ephemeral runtime state
// (agent IDs, session state, selection, zoom focus).
//
// This enables:
//   1. Saving/restoring board layouts as JSON
//   2. "Cookbook" templates the assistant can import atomically
//   3. Sharing board configurations between projects/users

import type {
  CanvasView,
  CanvasInstance,
  AgentCanvasView,
  AnchorCanvasView,
  PluginCanvasView,
  ZoneCanvasView,
  Position,
  Size,
  Viewport,
} from './canvas-types';
import { deduplicateDisplayName } from './canvas-types';
import { generateViewId, generateCanvasId, snapPosition } from './canvas-operations';
import type { CanvasWidgetMetadata } from '../../../../shared/plugin-types';

// ── Blueprint types ──────────────────────────────────────────────────

export const BLUEPRINT_VERSION = 1;

/** Serialisable description of a single canvas widget. */
export interface BlueprintView {
  type: 'agent' | 'anchor' | 'plugin' | 'zone';
  title: string;
  position: Position;
  size: Size;
  metadata: CanvasWidgetMetadata;

  // Agent-specific (type: 'agent')
  /** Optional project binding — the agent itself is NOT persisted. */
  projectId?: string;

  // Anchor-specific (type: 'anchor')
  label?: string;
  autoCollapse?: boolean;

  // Plugin-specific (type: 'plugin')
  pluginWidgetType?: string;
  pluginId?: string;

  // Zone-specific (type: 'zone')
  themeId?: string;
}

/** A portable, JSON-serialisable canvas board description. */
export interface CanvasBlueprint {
  version: number;
  name: string;
  views: BlueprintView[];
  viewport?: Viewport;
}

// ── Ephemeral metadata keys stripped on export ───────────────────────

/**
 * Metadata keys that reference ephemeral runtime state and should be
 * stripped during export. These are re-populated at runtime when agents
 * start or widgets initialise.
 */
const EPHEMERAL_METADATA_KEYS = new Set([
  'agentId',
  'agentName',
  'projectName',
  'orchestrator',
  'model',
]);

function stripEphemeralMetadata(metadata: CanvasWidgetMetadata): CanvasWidgetMetadata {
  const cleaned: CanvasWidgetMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!EPHEMERAL_METADATA_KEYS.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

// ── Export ────────────────────────────────────────────────────────────

/**
 * Export a canvas instance to a portable blueprint.
 *
 * Strips:
 * - View IDs (regenerated on import)
 * - Agent IDs on agent views (ephemeral runtime binding)
 * - zIndex ordering (regenerated on import)
 * - Selection/zoom state (ephemeral UI state)
 * - Ephemeral metadata (agentId, agentName, model, orchestrator, projectName)
 * - Zone containedViewIds (recomputed spatially on import)
 *
 * Preserves:
 * - View types, positions, sizes
 * - Widget configuration metadata (groupProjectId, etc.)
 * - Anchor labels and autoCollapse settings
 * - Plugin widget types and plugin IDs
 * - Zone themes
 * - Canvas name and viewport
 */
export function exportBlueprint(canvas: CanvasInstance): CanvasBlueprint {
  const views: BlueprintView[] = canvas.views.map((view) => {
    const base: BlueprintView = {
      type: view.type,
      title: view.title,
      position: { ...view.position },
      size: { ...view.size },
      metadata: stripEphemeralMetadata(view.metadata),
    };

    switch (view.type) {
      case 'agent': {
        const agentView = view as AgentCanvasView;
        if (agentView.projectId) {
          base.projectId = agentView.projectId;
        }
        break;
      }
      case 'anchor': {
        const anchorView = view as AnchorCanvasView;
        base.label = anchorView.label;
        if (anchorView.autoCollapse !== undefined) {
          base.autoCollapse = anchorView.autoCollapse;
        }
        break;
      }
      case 'plugin': {
        const pluginView = view as PluginCanvasView;
        base.pluginWidgetType = pluginView.pluginWidgetType;
        base.pluginId = pluginView.pluginId;
        break;
      }
      case 'zone': {
        const zoneView = view as ZoneCanvasView;
        base.themeId = zoneView.themeId;
        break;
      }
    }

    return base;
  });

  return {
    version: BLUEPRINT_VERSION,
    name: canvas.name,
    views,
    viewport: canvas.viewport ? { ...canvas.viewport } : undefined,
  };
}

// ── Import ───────────────────────────────────────────────────────────

/**
 * Import a blueprint into a ready-to-insert CanvasInstance.
 *
 * Generates fresh IDs for all views and the canvas itself, deduplicates
 * display names, and assigns sequential zIndex ordering.
 *
 * Options:
 * - `name`: Override the canvas name (defaults to blueprint name)
 * - `resetViewport`: If true, resets viewport to origin (default: false)
 */
export function importBlueprint(
  blueprint: CanvasBlueprint,
  options?: { name?: string; resetViewport?: boolean },
): CanvasInstance {
  if (!blueprint || typeof blueprint !== 'object') {
    throw new Error('Invalid blueprint: expected an object');
  }
  if (!blueprint.version || blueprint.version > BLUEPRINT_VERSION) {
    throw new Error(`Unsupported blueprint version: ${blueprint.version ?? 'missing'} (max supported: ${BLUEPRINT_VERSION})`);
  }
  if (!Array.isArray(blueprint.views)) {
    throw new Error('Invalid blueprint: views must be an array');
  }

  const existingNames: string[] = [];
  const views: CanvasView[] = blueprint.views.map((bv, index): CanvasView => {
    const displayName = deduplicateDisplayName(bv.title || bv.type, existingNames);
    existingNames.push(displayName);

    const base = {
      id: generateViewId(),
      position: snapPosition(bv.position || { x: 0, y: 0 }),
      size: { ...bv.size },
      title: bv.title || bv.type,
      displayName,
      zIndex: index,
      metadata: { ...(bv.metadata || {}) },
    };

    switch (bv.type) {
      case 'agent':
        return {
          ...base,
          type: 'agent' as const,
          agentId: null,
          projectId: bv.projectId,
        } satisfies AgentCanvasView;

      case 'anchor':
        return {
          ...base,
          type: 'anchor' as const,
          label: bv.label || displayName,
          autoCollapse: bv.autoCollapse,
        } satisfies AnchorCanvasView;

      case 'plugin':
        if (!bv.pluginWidgetType || !bv.pluginId) {
          throw new Error(`Plugin view "${bv.title}" missing pluginWidgetType or pluginId`);
        }
        return {
          ...base,
          type: 'plugin' as const,
          pluginWidgetType: bv.pluginWidgetType,
          pluginId: bv.pluginId,
        } satisfies PluginCanvasView;

      case 'zone':
        return {
          ...base,
          type: 'zone' as const,
          themeId: bv.themeId || 'catppuccin-mocha',
          containedViewIds: [],
        } satisfies ZoneCanvasView;

      default:
        throw new Error(`Unknown view type: ${(bv as any).type}`);
    }
  });

  const viewport = options?.resetViewport || !blueprint.viewport
    ? { panX: 0, panY: 0, zoom: 1 }
    : { ...blueprint.viewport };

  return {
    id: generateCanvasId(),
    name: options?.name || blueprint.name || 'Imported Board',
    views,
    viewport,
    nextZIndex: views.length,
    zoomedViewId: null,
    selectedViewId: null,
    minimapAutoHide: true,
  };
}

// ── Validation ───────────────────────────────────────────────────────

/** Validate a blueprint without importing it. Returns null if valid, error message otherwise. */
export function validateBlueprint(blueprint: unknown): string | null {
  if (!blueprint || typeof blueprint !== 'object') {
    return 'Invalid blueprint: expected an object';
  }
  const bp = blueprint as Record<string, unknown>;
  if (typeof bp.version !== 'number' || bp.version > BLUEPRINT_VERSION) {
    return `Unsupported blueprint version: ${bp.version ?? 'missing'} (max supported: ${BLUEPRINT_VERSION})`;
  }
  if (!Array.isArray(bp.views)) {
    return 'Invalid blueprint: views must be an array';
  }
  for (let i = 0; i < bp.views.length; i++) {
    const v = bp.views[i] as Record<string, unknown>;
    if (!v.type || !['agent', 'anchor', 'plugin', 'zone'].includes(v.type as string)) {
      return `Invalid view at index ${i}: unknown type "${v.type}"`;
    }
    if (v.type === 'plugin' && (!v.pluginWidgetType || !v.pluginId)) {
      return `Invalid plugin view at index ${i}: missing pluginWidgetType or pluginId`;
    }
  }
  return null;
}
