import React, { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import type { PluginContext, PluginAPI, PluginModule, PluginAgentDetailedStatus, CompletedQuickAgentInfo } from '../../../../shared/plugin-types';
import { createHubStore } from './useHubStore';
import { PaneContainer } from './PaneContainer';
import type { PaneComponentProps } from './PaneContainer';
import { HubPane } from './HubPane';
import { AgentPicker } from './AgentPicker';
import { CrossProjectAgentPicker } from './CrossProjectAgentPicker';

const PANE_PREFIX = 'hub';

// Separate store instances for project vs app mode so they don't collide
export const useProjectHubStore = createHubStore(PANE_PREFIX);
export const useAppHubStore = createHubStore(PANE_PREFIX);

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const disposable = api.commands.register('split-pane', () => {
    const store = api.context.mode === 'app' ? useAppHubStore : useProjectHubStore;
    const { focusedPaneId } = store.getState();
    store.getState().splitPane(focusedPaneId, 'horizontal', PANE_PREFIX);
  });
  ctx.subscriptions.push(disposable);
}

export function deactivate(): void {
  // subscriptions auto-disposed
}

export function MainPanel({ api }: { api: PluginAPI }) {
  const isAppMode = api.context.mode === 'app';
  const store = isAppMode ? useAppHubStore : useProjectHubStore;
  const storage = isAppMode ? api.storage.global : api.storage.projectLocal;

  const paneTree = store((s) => s.paneTree);
  const focusedPaneId = store((s) => s.focusedPaneId);
  const loaded = store((s) => s.loaded);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load persisted state
  useEffect(() => {
    store.getState().loadHub(storage, PANE_PREFIX);
  }, [store, storage]);

  // Debounced auto-save
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      store.getState().saveHub(storage);
    }, 500);
  }, [store, storage]);

  useEffect(() => {
    if (!loaded) return;
    scheduleSave();
  }, [paneTree, loaded, scheduleSave]);

  // Force re-render when agents change so the list stays fresh
  const [agentTick, setAgentTick] = useState(0);
  useEffect(() => {
    const sub = api.agents.onAnyChange(() => {
      setAgentTick((n) => n + 1);
    });
    return () => sub.dispose();
  }, [api]);

  // Agents — recomputed on each tick
  const agents = useMemo(() => api.agents.list(), [api, agentTick]);
  const agentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);

  useEffect(() => {
    if (loaded) store.getState().validateAgents(agentIds);
  }, [loaded, agentIds, store]);

  const detailedStatuses = useMemo(() => {
    const map: Record<string, PluginAgentDetailedStatus | null> = {};
    for (const a of agents) {
      map[a.id] = api.agents.getDetailedStatus(a.id);
    }
    return map;
  }, [agents, api, agentTick]);

  const completedAgents = useMemo(() => {
    if (isAppMode) {
      const projects = api.projects.list();
      const all: CompletedQuickAgentInfo[] = [];
      for (const p of projects) {
        all.push(...api.agents.listCompleted(p.id));
      }
      return all;
    }
    return api.agents.listCompleted();
  }, [api, isAppMode, agentTick]);

  const handleSplit = useCallback((paneId: string, dir: 'horizontal' | 'vertical', pos: 'before' | 'after' = 'after') => {
    store.getState().splitPane(paneId, dir, PANE_PREFIX, pos);
  }, [store]);

  const handleClose = useCallback((paneId: string) => {
    store.getState().closePane(paneId, PANE_PREFIX);
  }, [store]);

  const handleSwap = useCallback((id1: string, id2: string) => {
    store.getState().swapPanes(id1, id2);
  }, [store]);

  const handleAssign = useCallback((paneId: string, agentId: string | null, projectId?: string) => {
    store.getState().assignAgent(paneId, agentId, projectId);
  }, [store]);

  const handleFocus = useCallback((paneId: string) => {
    store.getState().setFocusedPane(paneId);
  }, [store]);

  const zoomedPaneId = store((s) => s.zoomedPaneId);

  const handleSplitResize = useCallback((splitId: string, ratio: number) => {
    store.getState().setSplitRatio(splitId, ratio);
  }, [store]);

  const handleZoom = useCallback((paneId: string) => {
    store.getState().toggleZoom(paneId);
  }, [store]);

  // ── Stable PaneComponent identity ──────────────────────────────────────
  // Keep volatile data (agents, statuses) in a ref so the component callback
  // never changes identity. This prevents React from unmounting/remounting
  // all pane components on every agent tick, which caused race conditions
  // where pane assignments were lost during resume.
  const dataRef = useRef({ api, agents, detailedStatuses, completedAgents, isAppMode, handleSplit, handleClose, handleSwap, handleAssign, handleFocus, handleZoom, zoomedPaneId });
  dataRef.current = { api, agents, detailedStatuses, completedAgents, isAppMode, handleSplit, handleClose, handleSwap, handleAssign, handleFocus, handleZoom, zoomedPaneId };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const HubPaneComponent = useCallback(({ pane, focused, canClose }: PaneComponentProps) => {
    const d = dataRef.current;
    const picker = d.isAppMode
      ? React.createElement(CrossProjectAgentPicker, {
          api: d.api,
          agents: d.agents,
          onPick: (agentId: string, projectId: string) => d.handleAssign(pane.id, agentId, projectId),
        })
      : React.createElement(AgentPicker, {
          api: d.api,
          agents: d.agents,
          onPick: (agentId: string) => d.handleAssign(pane.id, agentId),
        });

    return React.createElement(HubPane, {
      pane,
      api: d.api,
      focused,
      canClose,
      onSplit: d.handleSplit,
      onClose: d.handleClose,
      onSwap: d.handleSwap,
      onAssign: d.handleAssign,
      onFocus: d.handleFocus,
      onZoom: d.handleZoom,
      isZoomed: d.zoomedPaneId === pane.id,
      agents: d.agents,
      detailedStatuses: d.detailedStatuses,
      completedAgents: d.completedAgents,
    }, picker);
  }, []); // Empty deps — stable identity, reads latest values from ref

  if (!loaded) {
    return React.createElement('div', { className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs' }, 'Loading hub...');
  }

  return React.createElement(PaneContainer, {
    tree: paneTree,
    focusedPaneId,
    PaneComponent: HubPaneComponent,
    zoomedPaneId,
    onSplitResize: handleSplitResize,
  });
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
