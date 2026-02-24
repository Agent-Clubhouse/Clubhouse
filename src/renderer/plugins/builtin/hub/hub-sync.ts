/**
 * Hub state synchronisation between main window (leader) and pop-out
 * windows (followers).
 *
 * The main window's hub stores (per-project via `getProjectHubStore()` /
 * `useAppHubStore`) are the single source of truth.  Pop-outs forward mutations here;
 * this module applies them and broadcasts the resulting state to all
 * pop-out windows via IPC.
 */
import type { StoreApi, UseBoundStore } from 'zustand';
import type { HubState } from './useHubStore';
import type { HubMutation, HubStateSnapshot } from '../../../../shared/types';

const PANE_PREFIX = 'hub';

/**
 * Apply a mutation forwarded from a pop-out window to the correct hub
 * instance in the given store, then broadcast the updated state.
 */
export function applyHubMutation(
  store: UseBoundStore<StoreApi<HubState>>,
  hubId: string,
  mutation: HubMutation,
): void {
  const state = store.getState();

  // Temporarily switch to the target hub if it's not the active one
  const prevActive = state.activeHubId;
  if (prevActive !== hubId) {
    store.getState().setActiveHub(hubId);
  }

  switch (mutation.type) {
    case 'split':
      store.getState().splitPane(mutation.paneId, mutation.direction, PANE_PREFIX, mutation.position);
      break;
    case 'close':
      store.getState().closePane(mutation.paneId, PANE_PREFIX);
      break;
    case 'assign':
      store.getState().assignAgent(mutation.paneId, mutation.agentId, mutation.projectId);
      break;
    case 'swap':
      store.getState().swapPanes(mutation.id1, mutation.id2);
      break;
    case 'resize':
      store.getState().setSplitRatio(mutation.splitId, mutation.ratio);
      break;
    case 'zoom':
      store.getState().toggleZoom(mutation.paneId);
      break;
    case 'focus':
      store.getState().setFocusedPane(mutation.paneId);
      break;
  }

  // Restore active hub if we switched
  if (prevActive !== hubId) {
    store.getState().setActiveHub(prevActive);
  }

  // Broadcast updated state to pop-out windows
  broadcastHubState(store, hubId);
}

/**
 * Broadcast the current state of a hub instance to all pop-out windows.
 */
export function broadcastHubState(
  store: UseBoundStore<StoreApi<HubState>>,
  hubId: string,
): void {
  const state = store.getState();
  const hub = state.hubs.find((h) => h.id === hubId);
  if (!hub) return;

  const snapshot: HubStateSnapshot = {
    hubId: hub.id,
    paneTree: hub.paneTree,
    focusedPaneId: hub.focusedPaneId,
    zoomedPaneId: hub.zoomedPaneId,
  };

  window.clubhouse.window.broadcastHubState(snapshot);
}
