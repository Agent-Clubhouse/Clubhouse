import type { CanvasInstance, CanvasView, Position, Size } from './canvas-types';
import { computeAdjacentPosition } from './canvas-operations';

/**
 * Sibling agent cards waiting to be placed (LB-M68, #2020).
 *
 * New agent from a card's picker creates the agent somewhere else: in the
 * New agent page, which replaces the pane, or in AddAgentDialog. While the
 * page is open the canvas is unmounted, and a remount reloads the canvas
 * from disk, so a card added in the meantime would be lost. Cards wait here,
 * per canvas store, and the canvas places them once it has loaded in its
 * current mount, against where the parent card is at that moment.
 *
 * The queue is in memory only: a card still waiting when the app quits (the
 * page closed onto another tab and the canvas never reopened) is not placed.
 * The agent itself exists and can be added from any card's picker.
 */

export interface PendingAgentCard {
  /** The canvas the parent card is on. */
  canvasId: string;
  parentViewId: string;
  /** The parent's bounds when New agent was chosen, used only if the parent is gone. */
  fallback: { position: Position; size: Size };
  agentId: string;
}

const queues = new WeakMap<object, PendingAgentCard[]>();
const listeners = new WeakMap<object, Set<() => void>>();

/** Queue a card for the canvas that `owner` (its store) backs. */
export function queueAgentCard(owner: object, card: PendingAgentCard): void {
  queues.set(owner, [...(queues.get(owner) ?? []), card]);
  listeners.get(owner)?.forEach((fn) => fn());
}

/**
 * Take the cards for the active canvas. Cards for another canvas stay queued
 * until it's active; cards for a canvas that no longer exists are dropped.
 */
export function takeAgentCards(owner: object, activeCanvasId: string, canvasIds: readonly string[]): PendingAgentCard[] {
  const all = queues.get(owner) ?? [];
  if (all.length === 0) return [];
  const live = new Set(canvasIds);
  const now = all.filter((c) => c.canvasId === activeCanvasId);
  const later = all.filter((c) => c.canvasId !== activeCanvasId && live.has(c.canvasId));
  queues.set(owner, later);
  return now;
}

/** Call `fn` whenever a card is queued for `owner`. Returns the unsubscribe. */
export function subscribeAgentCards(owner: object, fn: () => void): () => void {
  let set = listeners.get(owner);
  if (!set) {
    set = new Set();
    listeners.set(owner, set);
  }
  set.add(fn);
  return () => { set!.delete(fn); };
}

/**
 * Where the card goes: next to the parent as it is now (it may have moved or
 * been resized while the agent was being made), at the parent's size.
 */
export function placeAgentCard(card: PendingAgentCard, views: readonly CanvasView[]): { position: Position; size: Size } {
  const parent = views.find((v) => v.id === card.parentViewId);
  const base = parent ? { position: parent.position, size: parent.size } : card.fallback;
  return {
    position: computeAdjacentPosition(base.position, base.size, base.size, views as CanvasView[]),
    size: base.size,
  };
}

/** The canvas a card is on, or `fallback` when no canvas has it. */
export function canvasOfView(canvases: readonly Pick<CanvasInstance, 'id' | 'views'>[], viewId: string, fallback: string): string {
  return canvases.find((c) => c.views.some((v) => v.id === viewId))?.id ?? fallback;
}
