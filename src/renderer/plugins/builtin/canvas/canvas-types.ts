// ── Canvas data model ─────────────────────────────────────────────────
import type { CanvasWidgetMetadata } from '../../../../shared/plugin-types';

/** Built-in canvas view types. Plugin widget types use the 'plugin' discriminant. */
export type CanvasViewType = 'agent' | 'file' | 'browser' | 'git-diff' | 'plugin';

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

export interface FileCanvasView extends CanvasViewBase {
  type: 'file';
  projectId?: string;
  filePath?: string;
}

export interface BrowserCanvasView extends CanvasViewBase {
  type: 'browser';
  url: string;
}

export interface GitDiffCanvasView extends CanvasViewBase {
  type: 'git-diff';
  /** Project ID whose repo to diff. */
  projectId?: string;
  /** Worktree directory path (when diffing an agent worktree instead of the main repo). */
  worktreePath?: string;
  /** Relative file path currently being diffed. */
  filePath?: string;
}

export interface PluginCanvasView extends CanvasViewBase {
  type: 'plugin';
  /** Fully-qualified plugin widget type: "plugin:{pluginId}:{widgetId}". */
  pluginWidgetType: string;
  /** The plugin ID that owns this widget. */
  pluginId: string;
}

export type CanvasView = AgentCanvasView | FileCanvasView | BrowserCanvasView | GitDiffCanvasView | PluginCanvasView;

// ── Canvas instance (one per tab) ────────────────────────────────────

export interface CanvasInstance {
  id: string;
  name: string;
  views: CanvasView[];
  viewport: Viewport;
  nextZIndex: number;
  zoomedViewId: string | null;
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

// ── Constants ────────────────────────────────────────────────────────

export const GRID_SIZE = 20;
export const MIN_VIEW_WIDTH = 200;
export const MIN_VIEW_HEIGHT = 150;
export const DEFAULT_VIEW_WIDTH = 480;
export const DEFAULT_VIEW_HEIGHT = 480;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.0;
export const CANVAS_SIZE = 20000;
