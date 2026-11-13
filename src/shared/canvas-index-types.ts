/** Types for the main-process canvas index (#1544), shared with the renderer. */
import type { NavigableCanvasTargetKind, TargetCanvasHit } from './canvas-persistence';
import type { CanvasStateSnapshot } from './types';
import type { DurableAgentConfig, Project } from './types';
import type { GroupProject } from './group-project-types';

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

export interface CanvasNavigationSnapshot {
  canvases: unknown[];
  wires: PersistedCanvasWire[];
  zoneWires: unknown[];
  groupProjects?: GroupProject[];
}

export type AgentNavigationTarget =
  | { project: Project; config?: DurableAgentConfig }
  | { error: string };

export interface GroupProjectNavigationIndex extends CanvasTargetIndex {
  /** A read-only registry snapshot also prevents widget mount from triggering migration. */
  groupProjects?: GroupProject[];
}

export interface CanvasPopoutReveal {
  requestId: string;
  windowId: number;
  canvasId: string;
  projectId?: string;
  viewId: string;
  targetKind: NavigableCanvasTargetKind;
  targetId: string;
  snapshot: CanvasStateSnapshot;
  groupProjects: GroupProject[];
}

export type CanvasPopoutRevealResult =
  | { requestId: string; viewport: { panX: number; panY: number; zoom: number } }
  | { requestId: string; error: string };

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
