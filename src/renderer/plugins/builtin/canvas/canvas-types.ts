// ── Canvas data model ─────────────────────────────────────────────────

export type CanvasViewType = 'agent' | 'file' | 'browser' | 'git-diff';

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
  zIndex: number;
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

export type CanvasView = AgentCanvasView | FileCanvasView | BrowserCanvasView | GitDiffCanvasView;

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

// ── Constants ────────────────────────────────────────────────────────

export const GRID_SIZE = 20;
export const MIN_VIEW_WIDTH = 200;
export const MIN_VIEW_HEIGHT = 150;
export const DEFAULT_VIEW_WIDTH = 480;
export const DEFAULT_VIEW_HEIGHT = 480;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.0;
export const CANVAS_SIZE = 20000;
