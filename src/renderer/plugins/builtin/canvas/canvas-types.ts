// ── Canvas data model ─────────────────────────────────────────────────
import type { CanvasWidgetMetadata } from '../../../../shared/plugin-types';

/**
 * Built-in canvas view types. Plugin widget types use the 'plugin' discriminant.
 * Browser, file, terminal, and git views are provided by their respective plugins
 * via the widget API (type: 'plugin').
 */
export type CanvasViewType = 'agent' | 'anchor' | 'plugin';

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  panX: number;
  panY: number;
  zoom: number;
}

// ── View types ───────────────────────────────────────────────────────

interface CanvasViewBase {
  id: string;
  type: CanvasViewType;
  position: Position;
  size: Size;
  title: string;
  /** Auto-deduplicated user-facing display name. */
  displayName: string;
  zIndex: number;
  /** Queryable metadata bag — every widget type populates relevant keys. */
  metadata: CanvasWidgetMetadata;
}

export interface AgentCanvasView extends CanvasViewBase {
  type: 'agent';
  agentId: string | null;
  projectId?: string;
}

export interface AnchorCanvasView extends CanvasViewBase {
  type: 'anchor';
  /** User-defined anchor label — stored in displayName for search/navigation. */
  label: string;
  /** When true, the anchor collapses to just its icon on mouse-leave and expands on hover. */
  autoCollapse?: boolean;
}

export interface PluginCanvasView extends CanvasViewBase {
  type: 'plugin';
  /** Fully-qualified plugin widget type: "plugin:{pluginId}:{widgetId}". */
  pluginWidgetType: string;
  /** The plugin ID that owns this widget. */
  pluginId: string;
}

export type CanvasView = AgentCanvasView | AnchorCanvasView | PluginCanvasView;

// ── Canvas instance (one per tab) ────────────────────────────────────

export interface CanvasInstance {
  id: string;
  name: string;
  views: CanvasView[];
  viewport: Viewport;
  nextZIndex: number;
  zoomedViewId: string | null;
  /** Which view is currently selected (receives keyboard/scroll events). Ephemeral — not persisted. */
  selectedViewId: string | null;
}

/** Serialisable snapshot persisted to storage */
export interface CanvasInstanceData {
  id: string;
  name: string;
  views: CanvasView[];
  viewport: Viewport;
  nextZIndex: number;
  zoomedViewId?: string | null;
}

// ── Display name deduplication ────────────────────────────────────────

/**
 * Given a base display name and the list of existing display names on the canvas,
 * returns a unique name by appending " (2)", " (3)", etc. if needed.
 */
export function deduplicateDisplayName(baseName: string, existingNames: string[]): string {
  if (!existingNames.includes(baseName)) return baseName;
  let suffix = 2;
  while (existingNames.includes(`${baseName} (${suffix})`)) {
    suffix++;
  }
  return `${baseName} (${suffix})`;
}

// ── Attention system ─────────────────────────────────────────────────

/** Attention level indicates a card requires user action. */
export type CanvasViewAttentionLevel = 'warning' | 'error';

export interface CanvasViewAttention {
  level: CanvasViewAttentionLevel;
  message: string;
  /** The view that needs attention. */
  viewId: string;
}

// ── Constants ────────────────────────────────────────────────────────

export const GRID_SIZE = 20;
export const MIN_VIEW_WIDTH = 200;
export const MIN_VIEW_HEIGHT = 150;
export const DEFAULT_VIEW_WIDTH = 480;
export const DEFAULT_VIEW_HEIGHT = 480;
export const DEFAULT_ANCHOR_WIDTH = 240;
export const DEFAULT_ANCHOR_HEIGHT = 50;
/** Anchors have a fixed height — they cannot be resized vertically. */
export const ANCHOR_HEIGHT = 50;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.0;
export const CANVAS_SIZE = 20000;
