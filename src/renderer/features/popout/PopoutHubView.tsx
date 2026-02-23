/**
 * Pop-out hub view — a follower viewport into the main window's hub state.
 *
 * Architecture:
 * - The main window's hub Zustand store is the single source of truth.
 * - This view subscribes to hub state changes via IPC and renders the
 *   same pane tree using the shared PaneContainer component.
 * - All mutations (split, close, assign, swap, resize, zoom) are
 *   forwarded to the main window via IPC — no local state modification.
 * - Periodic reconciliation (every 5 seconds) catches any missed events.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { PaneContainer } from '../../plugins/builtin/hub/PaneContainer';
import type { PaneComponentProps } from '../../plugins/builtin/hub/PaneContainer';
import { PopoutHubPane } from './PopoutHubPane';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import type { PaneNode } from '../../plugins/builtin/hub/pane-tree';
import { syncCounterToTree } from '../../plugins/builtin/hub/pane-tree';
import type { HubMutation, AgentDetailedStatus, CompletedQuickAgent, Agent } from '../../../shared/types';

interface PopoutHubViewProps {
  hubId?: string;
  projectId?: string;
}

const EMPTY_COMPLETED: CompletedQuickAgent[] = [];
const RECONCILE_INTERVAL_MS = 5000;

export function PopoutHubView({ hubId, projectId }: PopoutHubViewProps) {
  const [paneTree, setPaneTree] = useState<PaneNode | null>(null);
  const [focusedPaneId, setFocusedPaneId] = useState('');
  const [zoomedPaneId, setZoomedPaneId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const agents = useAgentStore((s) => s.agents);
  const agentDetailedStatus = useAgentStore((s) => s.agentDetailedStatus);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadCompleted = useQuickAgentStore((s) => s.loadCompleted);
  const completedAgents = useQuickAgentStore((s) => projectId ? (s.completedAgents[projectId] ?? EMPTY_COMPLETED) : EMPTY_COMPLETED);
  const dismissCompleted = useQuickAgentStore((s) => s.dismissCompleted);

  const scope = projectId ? 'project-local' : 'global';

  // ── Initial state load via IPC ────────────────────────────────────

  useEffect(() => {
    if (!hubId) {
      setError('No hub ID specified');
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      // Populate project store (required for SleepingAgent wake button)
      await loadProjects();

      // Load completed quick agents (localStorage-backed, not synced via IPC)
      if (projectId) loadCompleted(projectId);

      // Request hub state from the main window
      const snapshot = await window.clubhouse.window.getHubState(hubId, scope, projectId);
      if (cancelled) return;

      if (snapshot && snapshot.paneTree) {
        syncCounterToTree(snapshot.paneTree as PaneNode);
        setPaneTree(snapshot.paneTree as PaneNode);
        setFocusedPaneId(snapshot.focusedPaneId);
        setZoomedPaneId(snapshot.zoomedPaneId);
      } else {
        setError(`Hub "${hubId}" not found`);
      }
      setLoading(false);
    })().catch((err) => {
      if (!cancelled) {
        setError(`Failed to load hub: ${err}`);
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [hubId, projectId, scope, loadProjects, loadCompleted]);

  // ── Subscribe to hub state changes from main window ───────────────

  useEffect(() => {
    if (!hubId) return;
    const remove = window.clubhouse.window.onHubStateChanged((state) => {
      if (state.hubId !== hubId) return;
      const tree = state.paneTree as PaneNode;
      if (tree) syncCounterToTree(tree);
      setPaneTree(tree);
      setFocusedPaneId(state.focusedPaneId);
      setZoomedPaneId(state.zoomedPaneId);
    });
    return remove;
  }, [hubId]);

  // ── Periodic reconciliation ───────────────────────────────────────

  useEffect(() => {
    if (!hubId) return;
    const interval = setInterval(() => {
      window.clubhouse.window.getHubState(hubId, scope, projectId).then((snapshot) => {
        if (snapshot && snapshot.paneTree) {
          const tree = snapshot.paneTree as PaneNode;
          syncCounterToTree(tree);
          setPaneTree(tree);
          setFocusedPaneId(snapshot.focusedPaneId);
          setZoomedPaneId(snapshot.zoomedPaneId);
        }
      }).catch(() => { /* silent — main window may be busy */ });
    }, RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hubId, scope, projectId]);

  // ── Mutation forwarding via IPC ───────────────────────────────────

  const sendMutation = useCallback((mutation: HubMutation) => {
    if (!hubId) return;
    window.clubhouse.window.sendHubMutation(hubId, scope, mutation, projectId);
  }, [hubId, scope, projectId]);

  const handleSplit = useCallback((paneId: string, direction: 'horizontal' | 'vertical', position: 'before' | 'after') => {
    sendMutation({ type: 'split', paneId, direction, position });
  }, [sendMutation]);

  const handleClose = useCallback((paneId: string) => {
    sendMutation({ type: 'close', paneId });
  }, [sendMutation]);

  const handleSwap = useCallback((id1: string, id2: string) => {
    sendMutation({ type: 'swap', id1, id2 });
  }, [sendMutation]);

  const handleAssign = useCallback((paneId: string, agentId: string | null) => {
    sendMutation({ type: 'assign', paneId, agentId, projectId });
  }, [sendMutation, projectId]);

  const handleFocus = useCallback((paneId: string) => {
    sendMutation({ type: 'focus', paneId });
  }, [sendMutation]);

  const handleZoom = useCallback((paneId: string) => {
    sendMutation({ type: 'zoom', paneId });
  }, [sendMutation]);

  const handleSplitResize = useCallback((splitId: string, ratio: number) => {
    sendMutation({ type: 'resize', splitId, ratio });
  }, [sendMutation]);

  // ── PaneComponent for PaneContainer ───────────────────────────────

  const dataRef = useRef({
    agents, agentDetailedStatus, completedAgents, projectId,
    handleSplit, handleClose, handleSwap, handleAssign, handleFocus, handleZoom,
    zoomedPaneId, dismissCompleted,
  });
  dataRef.current = {
    agents, agentDetailedStatus, completedAgents, projectId,
    handleSplit, handleClose, handleSwap, handleAssign, handleFocus, handleZoom,
    zoomedPaneId, dismissCompleted,
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const PaneComponent = useCallback(({ pane, focused, canClose }: PaneComponentProps) => {
    const d = dataRef.current;
    return React.createElement(PopoutHubPane, {
      pane,
      focused,
      canClose,
      isZoomed: d.zoomedPaneId === pane.id,
      onSplit: d.handleSplit,
      onClose: d.handleClose,
      onSwap: d.handleSwap,
      onAssign: d.handleAssign,
      onFocus: d.handleFocus,
      onZoom: d.handleZoom,
      agents: d.agents,
      detailedStatuses: d.agentDetailedStatus,
      completedAgents: d.completedAgents,
      projectId: d.projectId,
      dismissCompleted: d.dismissCompleted,
    });
  }, []); // Stable identity — reads latest values from ref

  // ── Render ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
        Loading hub...
      </div>
    );
  }

  if (error || !paneTree) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-sm">
        {error || 'Hub not found'}
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-hidden" data-testid="popout-hub-view">
      <PaneContainer
        tree={paneTree}
        focusedPaneId={focusedPaneId}
        PaneComponent={PaneComponent}
        zoomedPaneId={zoomedPaneId}
        onSplitResize={handleSplitResize}
      />
    </div>
  );
}
