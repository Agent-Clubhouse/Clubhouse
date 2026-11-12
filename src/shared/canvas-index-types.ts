/** Types for the main-process canvas index (#1544), shared with the renderer. */
import type { TargetCanvasHit } from './canvas-persistence';

/** One canvas that holds a card for an agent, read from the persisted stores. */
export interface CanvasMembership {
  /** 'app' is the app-wide (Home) canvas store; 'project' a project's store. */
  scope: 'app' | 'project';
  /** Set for project-scoped canvases. */
  projectId?: string;
  canvasId: string;
  name: string;
  /** The agent card's view id on that canvas. */
  viewId: string;
}

/** Each store is separate so a loaded renderer store can replace its disk snapshot. */
export interface CanvasTargetStore {
  scope: 'app' | 'project';
  projectId?: string;
  projectName?: string;
  hits: TargetCanvasHit[];
  error?: string;
}

export interface CanvasTargetIndex {
  stores: CanvasTargetStore[];
  /** A failed project inventory means even the list of scopes is incomplete. */
  error?: string;
}

/** A wire definition as the canvas plugin persists it in canvas-wires.json. */
export interface PersistedCanvasWire {
  agentId: string;
  targetId: string;
  targetKind: string;
  label: string;
  agentName?: string;
  targetName?: string;
  projectName?: string;
  instructions?: Record<string, string>;
  disabledTools?: string[];
}
