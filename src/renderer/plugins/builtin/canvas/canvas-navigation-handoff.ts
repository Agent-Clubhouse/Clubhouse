import type { StoreApi } from 'zustand';
import type { CanvasState } from './canvas-store';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { isCanvasTargetView, type NavigableCanvasTargetKind } from '../../../../shared/canvas-persistence';
import type { CanvasView } from './canvas-types';

export interface CanvasNavigationHandoff {
  state: CanvasState;
  inactiveWires: ReadonlySet<McpBindingEntry>;
  target: { canvasId: string; viewId: string; kind: NavigableCanvasTargetKind; targetId: string };
  structure: string;
  revealed: boolean;
  structureRetired: boolean;
  popoutWindowId?: number;
  dispose?: () => void;
}

const handoffs = new WeakMap<StoreApi<CanvasState>, CanvasNavigationHandoff>();
const pairKey = (wire: Pick<McpBindingEntry, 'agentId' | 'targetId'>) => `${wire.agentId}\0${wire.targetId}`;

/** Only the next mount skips restore: ordinary manual Canvas mounts are unchanged. */
export function prepareCanvasNavigation(store: StoreApi<CanvasState>, target: CanvasNavigationHandoff['target']): CanvasNavigationHandoff {
  handoffs.get(store)?.dispose?.();
  const state = store.getState();
  const active = new Set(useMcpBindingStore.getState().bindings.map(pairKey));
  const handoff: CanvasNavigationHandoff = {
    state,
    inactiveWires: new Set(state.wireDefinitions.filter((wire) => !active.has(pairKey(wire)))),
    target,
    structure: canvasStructure(state),
    revealed: false,
    structureRetired: false,
  };
  handoffs.set(store, handoff);
  return handoff;
}

export function viewStructure(views: readonly CanvasView[]): string {
  return JSON.stringify(views.map(({ zIndex: _zIndex, ...view }) => view));
}

function canvasStructure(state: CanvasState): string {
  return JSON.stringify([
    state.canvases.map((canvas) => [canvas.id, viewStructure(canvas.views)]),
    state.wireDefinitions, state.zoneWireDefinitions,
  ]);
}

export function navigationTargetAvailable(state: CanvasState, handoff: CanvasNavigationHandoff): boolean {
  const { target } = handoff;
  return state.canvases.some((canvas) => canvas.id === target.canvasId
    && canvas.views.some((view) => view.id === target.viewId && isCanvasTargetView(view, target.kind, target.targetId)));
}

/** Navigation focus is part of hydration, not a user edit that should autosave/reconnect. */
export function completeCanvasNavigationReveal(store: StoreApi<CanvasState>, handoff: CanvasNavigationHandoff): void {
  handoff.state = store.getState();
  handoff.structure = canvasStructure(handoff.state);
  handoff.revealed = true;
}

export function navigationWireDefinitions(state: CanvasState, handoff: CanvasNavigationHandoff): McpBindingEntry[] {
  if (canvasStructure(state) !== handoff.structure) handoff.structureRetired = true;
  if (handoff.structureRetired) return state.wireDefinitions;
  return state.wireDefinitions.filter((wire) => !handoff.inactiveWires.has(wire));
}

export function releaseNavigationWiresForAgent(handoff: CanvasNavigationHandoff, agentId: string): void {
  handoff.inactiveWires = new Set([...handoff.inactiveWires].filter((wire) =>
    wire.agentId !== agentId && (wire.targetKind !== 'agent' || wire.targetId !== agentId)));
}

export function getCanvasNavigationHandoff(store: StoreApi<CanvasState>): CanvasNavigationHandoff | undefined {
  return handoffs.get(store);
}

export function consumeCanvasNavigationHandoff(store: StoreApi<CanvasState>, handoff: CanvasNavigationHandoff): void {
  if (handoffs.get(store) === handoff) handoffs.delete(store);
  handoff.dispose?.();
  handoff.dispose = undefined;
}

export function isNavigationHydrationUnchanged(state: CanvasState, handoff: CanvasNavigationHandoff): boolean {
  return state.canvases === handoff.state.canvases && state.activeCanvasId === handoff.state.activeCanvasId
    && state.wireDefinitions === handoff.state.wireDefinitions && state.zoneWireDefinitions === handoff.state.zoneWireDefinitions;
}
