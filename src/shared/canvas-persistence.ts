/**
 * Rules for reading persisted canvas data, shared by the canvas plugin
 * (renderer) and the main process. The main process reads the same stores at
 * startup to rebuild wire bindings and to answer "which canvases is this agent
 * on" before any canvas has been opened (#1544), so both sides must agree on
 * which wires are stale and which views count as an agent's card.
 */

/** View types dropped when a canvas is loaded (retired widget kinds). */
export const REMOVED_CANVAS_VIEW_TYPES: ReadonlySet<string> = new Set([
  'browser', 'file', 'legacy-file', 'terminal', 'legacy-terminal', 'git-diff', 'legacy-git-diff',
]);

/** The fields of a persisted view that wire reconciliation and membership read. */
export interface CanvasViewLike {
  id: string;
  type?: string;
  agentId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** The fields of a persisted canvas instance that the main process reads. */
export interface CanvasInstanceLike {
  id: string;
  name: string;
  views: CanvasViewLike[];
}

/** The fields every persisted wire definition must carry. */
export interface PersistedWireLike {
  agentId: string;
  targetId: string;
  targetKind: string;
  label: string;
}

/**
 * Every id a wire may point at on these views: view ids (browser widgets),
 * agent ids on agent cards, and group project ids on group project cards.
 */
export function collectCanvasEndpointIds(views: readonly CanvasViewLike[]): Set<string> {
  const ids = new Set<string>();
  for (const v of views) {
    ids.add(v.id);
    if (v.type === 'agent' && v.agentId) ids.add(v.agentId);
    const gpId = v.metadata?.groupProjectId;
    if (typeof gpId === 'string' && gpId) ids.add(gpId);
  }
  return ids;
}

/**
 * The persisted wires that should come back on load: well-formed entries whose
 * source and target are both still on a canvas. When there are no views at
 * all, nothing is reconciled (a fresh canvas may not have its cards yet).
 */
export function reconcilePersistedWires<T extends PersistedWireLike>(saved: readonly T[], views: readonly CanvasViewLike[]): T[] {
  const validIds = collectCanvasEndpointIds(views);
  const shouldReconcile = validIds.size > 0;
  return saved.filter((entry) => {
    if (!entry || !entry.agentId || !entry.targetId || !entry.label || !entry.targetKind) return false;
    if (shouldReconcile && (!validIds.has(entry.agentId) || !validIds.has(entry.targetId))) return false;
    return true;
  });
}

/** One canvas that holds a card for an agent. */
export interface AgentCanvasHit {
  canvasId: string;
  name: string;
  viewId: string;
}

/** The canvases holding an agent card for `agentId`, in canvas order. */
export function findAgentCanvasHits(canvases: readonly CanvasInstanceLike[], agentId: string): AgentCanvasHit[] {
  const out: AgentCanvasHit[] = [];
  for (const c of canvases) {
    const view = c.views.find((v) => v.type === 'agent' && v.agentId === agentId);
    if (view) out.push({ canvasId: c.id, name: c.name, viewId: view.id });
  }
  return out;
}
