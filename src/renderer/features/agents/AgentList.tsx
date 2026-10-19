import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, memo } from 'react';
import { useOrderedShallow } from '../../hooks/useOrderedShallow';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { useUIStore } from '../../stores/uiStore';
import { AgentListItem } from './AgentListItem';
import { AddAgentDialog } from './AddAgentDialog';
import { AgentGalleryDialog } from './AgentGalleryDialog';
import { TemplateConfigDialog, type TemplateConfig } from './TemplateConfigDialog';
import { DeleteAgentDialog } from './DeleteAgentDialog';
import { ApplyPersonaDialog } from './ApplyPersonaDialog';
import { ExtractPersonaDialog } from './ExtractPersonaDialog';
import { QuickAgentGhostCompact } from './QuickAgentGhost';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useEffectiveOrchestrators } from '../../hooks/useEffectiveOrchestrators';
import { useRemoteProjectStore, isRemoteProjectId, parseNamespacedId } from '../../stores/remoteProjectStore';
import { useToastStore } from '../../stores/toastStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import type { Agent, CompletedQuickAgent } from '../../../shared/types';
import type { PersonaTemplate } from '../personas';
import { EmptyState } from '../../components/EmptyState';
import { requestLeaveAgentSettings } from './agentSettingsPages';
import { createDurableAgent, createDurableAgentFromTemplate } from './create-agent';
import { buildAgentForest, forestSiblingGroups, moveWithinGroup, type AgentNode } from '../../chrome/sidebar/treeModel';
import { useChromeStore, syncCollapsedAgentsWithAgents, ensureChromeStateLoaded } from '../../chrome/chromeStore';

const EMPTY_COMPLETED: CompletedQuickAgent[] = [];
const EMPTY_AGENTS: Agent[] = [];

/** Left padding of a top-level row (px-3). */
const ROW_PAD = 12;
/** How much further in each level of helpers sits. */
const HELPER_INDENT = 28;
/** Extra indent of a quick agent under its durable parent (pl-7 against px-3). */
const QUICK_INDENT = 16;
/** Half the width of a row's avatar: the guide line runs under the parent's avatar centre. */
const AVATAR_HALF = 18;
/** How far the first guide stroke reaches up into the parent row, to just under its avatar. */
const GUIDE_REACH = 14;
const HelperCaret = ({ open }: { open: boolean }) => (
  <svg
    width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

/** A thin neutral stroke of the helper guide line; decoration only. */
function GuideStroke({ style, testId }: { style: React.CSSProperties; testId?: string }) {
  return <span aria-hidden="true" data-testid={testId} className="absolute bg-surface-2 pointer-events-none" style={style} />;
}

// Module-level activity map — bypasses Zustand to avoid store updates on
// every PTY chunk. Re-renders are driven by a boolean idle→active transition
// and a 2-second tick interval, not by individual activity recordings.
export const activityTimestamps: Record<string, number> = {};

type ProjectAgentBuckets = {
  projectAgents: Agent[];
  durableAgents: Agent[];
  quickAgents: Agent[];
  orphanQuickAgents: Agent[];
};

export function useProjectAgentBuckets(
  agents: Record<string, Agent>,
  activeProjectId: string | null
): ProjectAgentBuckets {
  return useMemo(() => {
    if (!activeProjectId) {
      return {
        projectAgents: EMPTY_AGENTS,
        durableAgents: EMPTY_AGENTS,
        quickAgents: EMPTY_AGENTS,
        orphanQuickAgents: EMPTY_AGENTS,
      };
    }

    const projectAgents = Object.values(agents).filter((agent) => agent.projectId === activeProjectId);
    const durableAgents = projectAgents.filter((agent) => agent.kind === 'durable');
    const quickAgents = projectAgents.filter((agent) => agent.kind === 'quick');
    const orphanQuickAgents = quickAgents.filter((agent) => !agent.parentAgentId);

    return {
      projectAgents,
      durableAgents,
      quickAgents,
      orphanQuickAgents,
    };
  }, [agents, activeProjectId]);
}

function AgentListInner() {
  const localAgents = useAgentStore(useOrderedShallow((s) => s.agents));
  const remoteAgents = useRemoteProjectStore((s) => s.remoteAgents);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const spawnQuickAgent = useAgentStore((s) => s.spawnQuickAgent);
  const loadDurableAgents = useAgentStore((s) => s.loadDurableAgents);
  const deleteDialogAgent = useAgentStore((s) => s.deleteDialogAgent);
  const applyPersonaDialogAgent = useAgentStore((s) => s.applyPersonaDialogAgent);
  const extractPersonaDialogAgent = useAgentStore((s) => s.extractPersonaDialogAgent);
  const reorderAgents = useAgentStore((s) => s.reorderAgents);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const satelliteProjects = useRemoteProjectStore((s) => s.satelliteProjects);
  const { options: MODEL_OPTIONS } = useModelOptions();
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);

  const isRemote = activeProjectId ? isRemoteProjectId(activeProjectId) : false;
  const agents = isRemote ? remoteAgents : localAgents;
  const activeProject = useMemo(() => {
    if (!activeProjectId) return undefined;
    if (isRemote) {
      for (const rps of Object.values(satelliteProjects)) {
        const found = rps.find((p) => p.id === activeProjectId);
        if (found) return found;
      }
      return undefined;
    }
    return projects.find((p) => p.id === activeProjectId);
  }, [activeProjectId, isRemote, projects, satelliteProjects]);
  const { effectiveOrchestrators: enabledOrchestrators, activeProfile, isOrchestratorInProfile } = useEffectiveOrchestrators(activeProject?.path);
  const allCompleted = useQuickAgentStore((s) => s.completedAgents);
  const completedAgents = useMemo(
    () => (activeProjectId ? allCompleted[activeProjectId] ?? EMPTY_COMPLETED : EMPTY_COMPLETED),
    [allCompleted, activeProjectId]
  );
  const dismissCompleted = useQuickAgentStore((s) => s.dismissCompleted);
  const clearCompleted = useQuickAgentStore((s) => s.clearCompleted);
  const selectCompleted = useQuickAgentStore((s) => s.selectCompleted);
  const [showDialog, setShowDialog] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<{ persona: PersonaTemplate; color: string } | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showMissionInput, setShowMissionInput] = useState(false);
  const [quickTargetParentId, setQuickTargetParentId] = useState<string | null>(null);
  const [mission, setMission] = useState('');
  const [quickModel, setQuickModel] = useState('default');
  const [quickOrchestrator, setQuickOrchestrator] = useState('');
  const [quickFreeAgentMode, setQuickFreeAgentMode] = useState(false);
  const missionInputRef = useRef<HTMLInputElement>(null);
  const dropdownBtnRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const isTickActiveRef = useRef(false);
  const [isTickActive, setIsTickActive] = useState(false);

  // Drag-to-reorder state for durable agents. A row moves only among its
  // siblings: the top-level agents, or the helpers of one parent.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const isDragging = dragId !== null;
  // Mirrors `isDragging` for long-lived callbacks (the pty.onData
  // subscription) that must not re-subscribe on every drag.
  const isDraggingRef = useRef(false);
  isDraggingRef.current = isDragging;

  // Collapsible completed section (persisted in localStorage)
  const [completedCollapsed, setCompletedCollapsed] = useState(() => {
    try {
      return localStorage.getItem('clubhouse_completed_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  // Parents whose helpers are folded away: the same saved state the new
  // sidebar uses, so a fold carries across layouts.
  const collapsedAgentIds = useChromeStore((s) => s.collapsedAgentIds);
  const toggleHelpers = useChromeStore((s) => s.toggleAgentCollapsed);
  const collapsedHelpers = useMemo(() => new Set(collapsedAgentIds), [collapsedAgentIds]);
  // With the new layout off the shared state isn't loaded at startup; load it before paint.
  useLayoutEffect(() => { ensureChromeStateLoaded(); }, []);
  useEffect(() => syncCollapsedAgentsWithAgents(), []);

  const toggleCompletedCollapsed = useCallback(() => {
    setCompletedCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('clubhouse_completed_collapsed', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Load durable agents on project switch
  useEffect(() => {
    if (activeProject) {
      loadDurableAgents(activeProject.id, activeProject.path);
    }
  }, [activeProject, loadDurableAgents]);

  // Track activity from pty data — writes to module-level map (no store
  // updates) and flips isTickActive on the first event to start the tick.
  const lastActivityRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const THROTTLE_MS = 150;
    const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const record = (agentId: string) => {
      activityTimestamps[agentId] = Date.now();
      // Never start the tick mid-drag — see the tick effect below.
      if (isDraggingRef.current) return;
      if (!isTickActiveRef.current) {
        isTickActiveRef.current = true;
        setIsTickActive(true);
      }
    };

    const unsub = window.clubhouse.pty.onData((agentId: string) => {
      const now = Date.now();
      const last = lastActivityRef.current[agentId] ?? 0;
      if (now - last >= THROTTLE_MS) {
        lastActivityRef.current[agentId] = now;
        record(agentId);
      } else if (!pendingTimers.has(agentId)) {
        // Schedule a trailing call so we don't miss the last burst of activity
        const delay = THROTTLE_MS - (now - last);
        pendingTimers.set(agentId, setTimeout(() => {
          lastActivityRef.current[agentId] = Date.now();
          record(agentId);
          pendingTimers.delete(agentId);
        }, delay));
      }
    });

    return () => {
      unsub();
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
    };
  }, []);

  // Tick for activity status refresh — only while agents have recent activity.
  // The tick also auto-stops after 5 s of inactivity so we don't re-render
  // when the app is idle.
  //
  // Suspended while a reorder drag is in flight. The tick re-renders every row
  // (flipping "Thinking..." labels, the pulse-ring class, and the running-vs-
  // sleeping action buttons, which re-runs the responsive-collapse
  // ResizeObserver). That DOM churn underneath the drag source aborts the
  // native macOS HTML5 drag loop, so a reorder was impossible whenever an
  // agent was streaming pty output — i.e. whenever the selected agent was
  // awake, since only the selected agent's terminal is mounted. Refreshing
  // activity labels mid-drag has no value; resume when the drag ends.
  useEffect(() => {
    if (!isTickActive || isDragging) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const anyRecent = Object.values(activityTimestamps).some(
        (last) => now - last < 5000
      );
      if (!anyRecent) {
        isTickActiveRef.current = false;
        setIsTickActive(false);
      }
      setTick((t) => t + 1);
    }, 2000);
    return () => clearInterval(interval);
  }, [isTickActive, isDragging]);

  const { durableAgents, quickAgents, orphanQuickAgents } = useProjectAgentBuckets(
    agents,
    activeProjectId
  );

  // Pre-compute child lookup maps so render loop avoids per-item .filter() allocations
  const childQuickByParent = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const agent of quickAgents) {
      if (agent.parentAgentId) {
        const list = map.get(agent.parentAgentId);
        if (list) list.push(agent);
        else map.set(agent.parentAgentId, [agent]);
      }
    }
    return map;
  }, [quickAgents]);

  // Helpers nest under their orchestrator, as in the new sidebar (#2231).
  const forest = useMemo(() => buildAgentForest(durableAgents), [durableAgents]);
  const reorderGroupOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const group of forestSiblingGroups(forest)) {
      for (const id of group) map.set(id, group);
    }
    return map;
  }, [forest]);

  // Selecting a helper inside a folded parent unfolds it, so the active row is
  // visible. Only a change of selection does this: folding a parent while one
  // of its helpers is selected must stay folded, so the agents and the fold
  // state are read through a ref and the store, not as dependencies.
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  useEffect(() => {
    if (!activeAgentId) return;
    const all = agentsRef.current;
    const collapsed = new Set(useChromeStore.getState().collapsedAgentIds);
    const folded: string[] = [];
    const seen = new Set<string>();
    let parentId = all[activeAgentId]?.parentAgentId;
    while (parentId && !seen.has(parentId) && all[parentId]?.kind === 'durable') {
      seen.add(parentId);
      if (collapsed.has(parentId)) folded.push(parentId);
      parentId = all[parentId]?.parentAgentId;
    }
    if (folded.length > 0) useChromeStore.getState().expandAgents(folded);
  }, [activeAgentId]);


  useEffect(() => {
    if (showMissionInput && missionInputRef.current) {
      missionInputRef.current.focus();
    }
  }, [showMissionInput]);

  const openQuickAgentDialog = useUIStore((s) => s.openQuickAgentDialog);

  const handleQuickAgent = () => {
    setShowDropdown(false);
    openQuickAgentDialog();
  };

  const handleSpawnQuickChild = useCallback((durableId: string) => {
    setQuickTargetParentId(durableId);
    setShowMissionInput(true);
  }, []);

  const handleSelectAgent = useCallback((agentId: string) => requestLeaveAgentSettings(() => {
    selectCompleted(null);
    setActiveAgent(agentId, activeProjectId ?? undefined);
  }), [selectCompleted, setActiveAgent, activeProjectId]);

  const handleMissionSubmit = async () => {
    if (!activeProject || !mission.trim()) return;
    const selectedModel = quickModel;
    const parentId = quickTargetParentId;
    const selectedOrchestrator = quickOrchestrator || undefined;
    const freeMode = quickFreeAgentMode || undefined;
    setShowMissionInput(false);
    try {
      await spawnQuickAgent(activeProject.id, activeProject.path, mission.trim(), selectedModel, parentId || undefined, parentId ? undefined : selectedOrchestrator, freeMode);
    } catch (err) {
      console.error('Failed to spawn quick agent:', err);
      useToastStore.getState().addToast(`Failed to create agent: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    setMission('');
    setQuickModel('default');
    setQuickOrchestrator('');
    setQuickFreeAgentMode(false);
    setQuickTargetParentId(null);
  };

  const handleCancelMission = () => {
    setShowMissionInput(false);
    setMission('');
    setQuickModel('default');
    setQuickOrchestrator('');
    setQuickFreeAgentMode(false);
    setQuickTargetParentId(null);
  };


  const sendAgentReorder = useAnnexClientStore((s) => s.sendAgentReorder);

  const handleCreateDurable = async (name: string, color: string, model: string, useWorktree: boolean, orchestrator?: string, freeAgentMode?: boolean, mcpIds?: string[], persona?: string) => {
    if (!activeProject) return;
    setShowDialog(false);
    await createDurableAgent(
      { id: activeProject.id, path: activeProject.path },
      { name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds, persona },
    );
  };

  const handleGallerySelect = (persona: PersonaTemplate, color: string) => {
    setShowGallery(false);
    setPendingTemplate({ persona, color });
  };

  const handleCreateFromTemplate = async (templateConfig: TemplateConfig) => {
    if (!activeProject) return;
    setPendingTemplate(null);
    await createDurableAgentFromTemplate({ id: activeProject.id, path: activeProject.path }, templateConfig);
  };

  const isThinking = useCallback((id: string) => {
    const last = activityTimestamps[id];
    if (!last) return false;
    return Date.now() - last < 3000;
  }, []);

  // Drag-to-reorder handlers for durable agents
  const handleDragStart = useCallback((e: React.DragEvent, agentId: string) => {
    // Select the dragged agent up-front so reorder never depends on a prior
    // click (GH #1521). On the native macOS HTML5-DnD loop a drag begun on a
    // non-active row does not complete a reorder — the only path that works is
    // dragging the already-active row. Activating the row here, synchronously
    // at drag start, puts every drag into that known-good state. Pure
    // interaction logic: it reuses the existing active styling, adds no layout
    // change, and is a no-op when the row is already active.
    selectCompleted(null);
    setActiveAgent(agentId, activeProjectId ?? undefined);
    setDragId(agentId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', agentId);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5';
    }
  }, [selectCompleted, setActiveAgent, activeProjectId]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1';
    }
    setDragId(null);
    setDragOverId(null);
  }, []);

  /** Whether the dragged row may land on `targetId`: only among its own siblings. */
  const isSiblingTarget = useCallback((targetId: string) => (
    dragId !== null && reorderGroupOf.get(dragId) === reorderGroupOf.get(targetId)
  ), [dragId, reorderGroupOf]);

  const handleDragOver = useCallback((e: React.DragEvent, targetId: string) => {
    if (!isSiblingTarget(targetId)) return; // not a drop target: no preventDefault
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(targetId);
  }, [isSiblingTarget]);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const group = dragId !== null && isSiblingTarget(targetId) ? reorderGroupOf.get(dragId) : undefined;
    // Moving down lands after the target and moving up before it, as in the new sidebar.
    const nextIds = group && dragId !== null
      ? moveWithinGroup(durableAgents.map((a) => a.id), group, dragId, targetId)
      : null;
    if (!nextIds) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    const byId = new Map(durableAgents.map((a) => [a.id, a]));
    const newOrder = nextIds.map((id) => byId.get(id)!);

    if (activeProject) {
      if (isRemote && activeProjectId) {
        // Remote project: send reorder to satellite via annex client
        const parsed = parseNamespacedId(activeProjectId);
        if (parsed) {
          const originalIds = newOrder.map((a) => {
            const p = parseNamespacedId(a.id);
            return p ? p.agentId : a.id;
          });
          sendAgentReorder(parsed.satelliteId, parsed.agentId, originalIds);
        }
      } else {
        reorderAgents(activeProject.path, newOrder.map((a) => a.id));
      }
    }

    setDragId(null);
    setDragOverId(null);
  }, [dragId, isSiblingTarget, reorderGroupOf, durableAgents, activeProject, isRemote, activeProjectId, reorderAgents, sendAgentReorder]);

  // Get the parent durable agent name for the mission input label
  const targetParentAgent = quickTargetParentId ? agents[quickTargetParentId] : null;

  const renderMissionInput = (isNested: boolean, indent?: number) => {
    // Resolve orchestrator for capabilities check
    const resolvedOrchId = isNested
      ? targetParentAgent?.orchestrator || enabledOrchestrators[0]?.id
      : quickOrchestrator || enabledOrchestrators[0]?.id;
    const resolvedOrch = allOrchestrators.find((o) => o.id === resolvedOrchId);
    const supportsPermissions = resolvedOrch?.capabilities?.permissions ?? false;

    return (
      <div
        className={`py-3 border-b border-surface-0/50 space-y-2 ${indent !== undefined ? 'pr-3' : isNested ? 'pl-7 pr-3' : 'px-3'}`}
        style={indent !== undefined ? { paddingLeft: indent } : undefined}
      >
        {targetParentAgent && (
          <div className="text-xs text-ctp-overlay0">
            Quick agent in {targetParentAgent.name}'s worktree
          </div>
        )}
        <input
          ref={missionInputRef}
          type="text"
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && mission.trim()) handleMissionSubmit();
            if (e.key === 'Escape') handleCancelMission();
          }}
          placeholder="What should this quick agent do?"
          className="w-full px-2 py-1.5 text-xs rounded border border-surface-0
            bg-ctp-base text-ctp-text placeholder:text-ctp-overlay0
            focus-ring"
        />
        <div className="flex gap-1.5">
          <select
            value={quickModel}
            onChange={(e) => setQuickModel(e.target.value)}
            className="flex-1 min-w-0 px-1.5 py-1 text-xs rounded bg-surface-0 border border-surface-2
              text-ctp-text focus-ring"
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
          {!isNested && enabledOrchestrators.length > 1 && (
            <select
              value={quickOrchestrator || enabledOrchestrators[0]?.id}
              onChange={(e) => setQuickOrchestrator(e.target.value)}
              className="flex-1 min-w-0 px-1.5 py-1 text-xs rounded bg-surface-0 border border-surface-2
                text-ctp-text focus-ring"
            >
              {enabledOrchestrators.map((o) => (
                <option key={o.id} value={o.id}>{o.displayName}</option>
              ))}
            </select>
          )}
        </div>
        {/* Free Agent Mode toggle */}
        <label
          className={`flex items-center gap-1.5 ${supportsPermissions ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
          title={supportsPermissions ? 'Skip all permission prompts' : 'Not supported by this CLI'}
        >
          <input
            type="checkbox"
            checked={quickFreeAgentMode}
            onChange={(e) => setQuickFreeAgentMode(e.target.checked)}
            disabled={!supportsPermissions}
            className="w-3 h-3 rounded border-surface-2 bg-surface-0 text-ctp-error focus:ring-ctp-error accent-red-500"
          />
          <span className="text-xs text-ctp-subtext0">Free Agent Mode</span>
          {quickFreeAgentMode && supportsPermissions && (
            <span className="text-xs text-ctp-error">skip all permissions</span>
          )}
        </label>
        <div className="flex gap-1.5">
          <button
            onClick={handleMissionSubmit}
            disabled={!mission.trim()}
            className="flex-1 px-2 py-1 text-xs rounded bg-ctp-accent/20 text-ctp-accent
              hover:bg-ctp-accent/30 transition-colors cursor-pointer
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Start
          </button>
          <button
            onClick={handleCancelMission}
            className="px-2 py-1 text-xs rounded border border-surface-0
              hover:bg-surface-0 transition-colors cursor-pointer text-ctp-subtext1"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  };

  /**
   * A durable agent's row with its quick agents, then, unless folded, its
   * helpers a level deeper on a thin guide line. Each row is its own drag
   * source, so a helper drags without its parent and only among its siblings.
   */
  const renderDurable = (node: AgentNode, depth: number, index: number, siblingCount: number, reachUp = false): React.ReactNode => {
    const durable = node.agent;
    const indent = ROW_PAD + depth * HELPER_INDENT;
    const guideX = indent - HELPER_INDENT + AVATAR_HALF; // under the parent's avatar
    const first = index === 0;
    const last = index === siblingCount - 1;
    const guideTop = first && reachUp ? -GUIDE_REACH : 0;
    const childQuick = childQuickByParent.get(durable.id) ?? [];
    const isMissionTarget = showMissionInput && quickTargetParentId === durable.id;
    const helperCount = node.children.length;
    const helpersOpen = helperCount > 0 && !collapsedHelpers.has(durable.id);
    const group = reorderGroupOf.get(durable.id) ?? [];
    const showDropLine = dragOverId === durable.id && dragId !== null && dragId !== durable.id;
    const dropBelow = showDropLine && group.indexOf(dragId!) < group.indexOf(durable.id);
    // The helpers' guide line reaches up into this row only when nothing sits between them.
    const helpersReachUp = childQuick.length === 0 && !isMissionTarget;

    return (
      <div key={durable.id} className="relative" data-testid={depth > 0 ? `helper-subtree-${durable.id}` : undefined}>
        {depth > 0 && !last && (
          // Continues past this helper's subtree to the next sibling.
          <GuideStroke testId="helper-guide-line" style={{ left: guideX, width: 1, top: guideTop, bottom: 0 }} />
        )}
        <div
          draggable
          onDragStart={(e) => handleDragStart(e, durable.id)}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => handleDragOver(e, durable.id)}
          onDrop={(e) => handleDrop(e, durable.id)}
          className="relative"
          data-testid={depth === 0 ? `durable-drag-${index}` : `helper-drag-${durable.id}`}
          data-agent-id={durable.id}
          data-depth={depth}
        >
          {showDropLine && (
            <div
              data-testid="drag-indicator"
              className={`absolute ${dropBelow ? '-bottom-px' : '-top-px'} right-3 h-0.5 bg-ctp-accent rounded-full z-10`}
              style={{ left: indent }}
            />
          )}
          <div className="relative">
            {depth > 0 && (
              <>
                {last && <GuideStroke testId="helper-guide-line" style={{ left: guideX, width: 1, top: guideTop, height: `calc(50% + ${-guideTop}px)` }} />}
                <GuideStroke style={{ left: guideX, top: '50%', height: 1, width: indent - guideX - 4 }} />
              </>
            )}
            {helperCount > 0 && (
              <button
                type="button"
                draggable={false}
                data-testid={`helpers-toggle-${durable.id}`}
                aria-expanded={helpersOpen}
                aria-label={helpersOpen
                  ? `Hide helpers of ${durable.name}`
                  : `Show ${helperCount} ${helperCount === 1 ? 'helper' : 'helpers'} of ${durable.name}`}
                title={helpersOpen ? 'Hide helpers' : `Show ${helperCount} ${helperCount === 1 ? 'helper' : 'helpers'}`}
                onClick={(e) => { e.stopPropagation(); toggleHelpers(durable.id); }}
                className="absolute top-0 bottom-0 z-10 w-3 flex items-center justify-center text-ctp-overlay0 hover:text-ctp-text cursor-pointer"
                style={{ left: indent - 12 }}
              >
                <HelperCaret open={helpersOpen} />
              </button>
            )}
            <AgentListItem
              agent={durable}
              isActive={durable.id === activeAgentId}
              isThinking={isThinking(durable.id)}
              onSelect={handleSelectAgent}
              onSpawnQuickChild={handleSpawnQuickChild}
              {...(depth > 0 && { indent })}
            />
            {activeProfile && durable.orchestrator && !isOrchestratorInProfile(durable.orchestrator) && (
              <span
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-yellow-500"
                title={`${durable.orchestrator} is not configured in the "${activeProfile.name}" profile`}
              >
                ⚠
              </span>
            )}
          </div>
          {/* Inline mission input targeting this durable */}
          {isMissionTarget && renderMissionInput(true, depth > 0 ? indent + QUICK_INDENT : undefined)}
          {/* Child quick agents (indented). Completed children are not
              nested here — they move to the Completed footer below. */}
          {childQuick.map((child) => (
            <AgentListItem
              key={child.id}
              agent={child}
              isActive={child.id === activeAgentId}
              isThinking={isThinking(child.id)}
              onSelect={handleSelectAgent}
              isNested
              {...(depth > 0 && { indent: indent + QUICK_INDENT })}
            />
          ))}
        </div>
        {helpersOpen && node.children.map((child, k) => renderDurable(child, depth + 1, k, helperCount, helpersReachUp))}
      </div>
    );
  };

  if (!activeProject) {
    return (
      <div className="p-3">
        <EmptyState title="Select a project to manage agents" compact />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="agent-list">
      {/* Header with split button */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
          Agents
        </span>
        <div ref={dropdownBtnRef} className="relative flex">
          <button
            onClick={() => setShowDialog(true)}
            className="px-2 py-1 text-xs rounded-l bg-ctp-accent/20 text-ctp-accent
              hover:bg-ctp-accent/30 transition-colors cursor-pointer"
          >
            + Agent
          </button>
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="px-1.5 py-1 text-xs rounded-r bg-ctp-accent/20 text-ctp-accent
              hover:bg-ctp-accent/30 transition-colors cursor-pointer border-l border-ctp-accent/30"
          >
            {'\u25BE'}
          </button>
          {showDropdown && (() => {
            const rect = dropdownBtnRef.current?.getBoundingClientRect();
            return (
              <div
                className="fixed bg-ctp-mantle border border-surface-0 rounded-lg shadow-xl py-1 z-dropdown min-w-[160px]"
                style={rect ? { top: rect.bottom + 4, right: window.innerWidth - rect.right } : undefined}
              >
                <button
                  onClick={() => { setShowDropdown(false); setShowDialog(true); }}
                  className="w-full px-3 py-1.5 text-xs text-left text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer flex items-center gap-2 whitespace-nowrap"
                >
                  <svg className="flex-shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="16" />
                    <line x1="8" y1="12" x2="16" y2="12" />
                  </svg>
                  Durable
                </button>
                <button
                  onClick={handleQuickAgent}
                  className="w-full px-3 py-1.5 text-xs text-left text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer flex items-center gap-2 whitespace-nowrap"
                >
                  <svg className="flex-shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  Quick Agent
                </button>
                <div className="border-t border-surface-0/50 my-1" />
                <button
                  onClick={() => { setShowDropdown(false); setShowGallery(true); }}
                  className="w-full px-3 py-1.5 text-xs text-left text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer flex items-center gap-2 whitespace-nowrap"
                >
                  <svg className="flex-shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <rect x="14" y="14" width="7" height="7" rx="1" />
                  </svg>
                  From Template
                </button>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Close dropdown on outside click */}
      {showDropdown && (
        <div className="fixed inset-0 z-dropdown-backdrop" onClick={() => setShowDropdown(false)} />
      )}

      <div className="flex-1 overflow-y-auto min-h-0" data-testid="agent-list-content">
        {/* ALL section — durables with their nested children */}
        {durableAgents.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-surface-0/50">
              All
            </div>
            {forest.map((node, i) => renderDurable(node, 0, i, forest.length))}
          </div>
        )}

        {/* Orphan mission input (targeting project root) */}
        {showMissionInput && quickTargetParentId === null && renderMissionInput(false)}

        {/* Orphan Quick Sessions */}
        {orphanQuickAgents.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-surface-0/50">
              Quick Sessions
            </div>
            {orphanQuickAgents.map((agent) => (
              <AgentListItem
                key={agent.id}
                agent={agent}
                isActive={agent.id === activeAgentId}
                isThinking={isThinking(agent.id)}
                onSelect={handleSelectAgent}
              />
            ))}
          </div>
        )}

        {durableAgents.length === 0 && quickAgents.length === 0 && completedAgents.length === 0 && (
          <EmptyState
            title="No agents yet"
            description='Click + Agent to create a durable agent, or use the dropdown for a quick session.'
            compact
          />
        )}
      </div>

      {/* Completed footer — pinned to bottom, expands upward */}
      <div className="flex-shrink-0 border-t border-surface-0" data-testid="completed-footer">
        <div className="px-3 py-1.5 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider flex items-center justify-between">
          <button
            onClick={toggleCompletedCollapsed}
            data-testid="completed-toggle"
            className="flex items-center gap-1 cursor-pointer hover:text-ctp-text transition-colors"
          >
            <svg
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`transition-transform duration-200 ${completedCollapsed ? '' : 'rotate-90'}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span>Completed ({completedAgents.length})</span>
          </button>
          {!completedCollapsed && completedAgents.length > 0 && (
            <button
              onClick={() => activeProjectId && clearCompleted(activeProjectId)}
              data-testid="completed-clear-all"
              className="text-xs normal-case tracking-normal text-ctp-overlay0 hover:text-ctp-text cursor-pointer font-normal"
            >
              Clear all
            </button>
          )}
        </div>
        <div
          data-testid="completed-items"
          className="overflow-hidden transition-[max-height,min-height] duration-300 ease-in-out"
          style={{
            maxHeight: completedCollapsed ? 0 : '33vh',
            minHeight: completedCollapsed ? 0 : (completedAgents.length > 0 ? '120px' : 0),
          }}
        >
          <div className="overflow-y-auto pb-2" style={{ maxHeight: '33vh' }}>
            {completedAgents.map((completed) => (
              <QuickAgentGhostCompact
                key={completed.id}
                completed={completed}
                onDismiss={() => activeProjectId && dismissCompleted(activeProjectId, completed.id)}
                onDelete={() => activeProjectId && dismissCompleted(activeProjectId, completed.id)}
                onSelect={() => { setActiveAgent(null, activeProjectId ?? undefined); selectCompleted(completed.id); }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Dialogs */}
      {showDialog && (
        <AddAgentDialog
          onClose={() => setShowDialog(false)}
          onCreate={handleCreateDurable}
          projectPath={activeProject?.path}
        />
      )}
      {showGallery && (
        <AgentGalleryDialog
          onClose={() => setShowGallery(false)}
          onCreate={handleGallerySelect}
        />
      )}
      {pendingTemplate && (
        <TemplateConfigDialog
          persona={pendingTemplate.persona}
          personaColor={pendingTemplate.color}
          projectPath={activeProject?.path}
          onClose={() => setPendingTemplate(null)}
          onCreate={handleCreateFromTemplate}
        />
      )}
      {deleteDialogAgent && <DeleteAgentDialog />}
      {applyPersonaDialogAgent && <ApplyPersonaDialog />}
      {extractPersonaDialogAgent && <ExtractPersonaDialog />}
    </div>
  );
}

export const AgentList = memo(AgentListInner);
