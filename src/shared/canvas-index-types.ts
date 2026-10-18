/** Types for the main-process canvas index (#1544), shared with the renderer. */

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
