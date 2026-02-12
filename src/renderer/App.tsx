import { useCallback, useEffect, useRef, useState } from 'react';
import { ProjectRail } from './panels/ProjectRail';
import { ExplorerRail } from './panels/ExplorerRail';
import { AccessoryPanel } from './panels/AccessoryPanel';
import { MainContentView } from './panels/MainContentView';
import { Dashboard } from './features/projects/Dashboard';
import { GitBanner } from './features/projects/GitBanner';
import { ResizeHandle } from './components/ResizeHandle';
import { CollapsedExplorerStrip } from './components/CollapsedExplorerStrip';
import { useProjectStore } from './stores/projectStore';
import { useAgentStore } from './stores/agentStore';
import { useUIStore } from './stores/uiStore';
import { useNotificationStore } from './stores/notificationStore';
import { useQuickAgentStore } from './stores/quickAgentStore';
import {
  useLayoutStore,
  EXPLORER_MIN,
  EXPLORER_MAX,
  EXPLORER_DEFAULT,
  ACCESSORY_MIN,
  ACCESSORY_MAX,
  ACCESSORY_DEFAULT,
  PROJECT_RAIL_WIDTH,
} from './stores/layoutStore';

const SNAP_THRESHOLD = 30;

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const updateAgentStatus = useAgentStore((s) => s.updateAgentStatus);
  const handleHookEvent = useAgentStore((s) => s.handleHookEvent);
  const agents = useAgentStore((s) => s.agents);
  const loadDurableAgents = useAgentStore((s) => s.loadDurableAgents);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const setSettingsSubPage = useUIStore((s) => s.setSettingsSubPage);
  const isFullWidth = explorerTab === 'terminal' || explorerTab === 'hub';
  const loadNotificationSettings = useNotificationStore((s) => s.loadSettings);
  const checkAndNotify = useNotificationStore((s) => s.checkAndNotify);
  const addCompleted = useQuickAgentStore((s) => s.addCompleted);
  const loadCompleted = useQuickAgentStore((s) => s.loadCompleted);
  const removeAgent = useAgentStore((s) => s.removeAgent);

  // Layout state
  const explorerWidth = useLayoutStore((s) => s.explorerWidth);
  const accessoryWidth = useLayoutStore((s) => s.accessoryWidth);
  const explorerCollapsed = useLayoutStore((s) => s.explorerCollapsed);
  const accessoryCollapsed = useLayoutStore((s) => s.accessoryCollapsed);
  const setExplorerWidth = useLayoutStore((s) => s.setExplorerWidth);
  const setAccessoryWidth = useLayoutStore((s) => s.setAccessoryWidth);
  const setExplorerCollapsed = useLayoutStore((s) => s.setExplorerCollapsed);
  const setAccessoryCollapsed = useLayoutStore((s) => s.setAccessoryCollapsed);
  const toggleExplorerCollapsed = useLayoutStore((s) => s.toggleExplorerCollapsed);
  const toggleAccessoryCollapsed = useLayoutStore((s) => s.toggleAccessoryCollapsed);

  // Track whether we're actively dragging (to skip transition class)
  const [draggingExplorer, setDraggingExplorer] = useState(false);
  const [draggingAccessory, setDraggingAccessory] = useState(false);

  // Live width refs for smooth drag (avoid store updates every pixel)
  const explorerDragWidth = useRef(explorerWidth);
  const accessoryDragWidth = useRef(accessoryWidth);
  const explorerPaneRef = useRef<HTMLDivElement>(null);
  const accessoryPaneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadProjects();
    loadNotificationSettings();
  }, [loadProjects, loadNotificationSettings]);

  useEffect(() => {
    const remove = window.clubhouse.app.onOpenSettings(() => {
      setExplorerTab('settings');
      setSettingsSubPage('notifications');
    });
    return () => remove();
  }, [setExplorerTab, setSettingsSubPage]);

  // Load durable agents for all projects so the dashboard shows them
  useEffect(() => {
    for (const p of projects) {
      loadDurableAgents(p.id, p.path);
    }
  }, [projects, loadDurableAgents]);

  // Load completed quick agents for all projects
  useEffect(() => {
    for (const p of projects) {
      loadCompleted(p.id);
    }
  }, [projects, loadCompleted]);

  useEffect(() => {
    const removeExitListener = window.clubhouse.pty.onExit(
      async (agentId: string, exitCode: number) => {
        const agent = useAgentStore.getState().agents[agentId];
        updateAgentStatus(agentId, 'sleeping', exitCode);

        // Handle quick agent completion
        if (agent?.kind === 'quick' && agent.mission) {
          let summary: string | null = null;
          let filesModified: string[] = [];

          try {
            const result = await window.clubhouse.agent.readQuickSummary(agentId);
            if (result) {
              summary = result.summary;
              filesModified = result.filesModified;
            }
          } catch {
            // Summary not available
          }

          addCompleted({
            id: agentId,
            projectId: agent.projectId,
            name: agent.name,
            mission: agent.mission,
            summary,
            filesModified,
            exitCode,
            completedAt: Date.now(),
            parentAgentId: agent.parentAgentId,
          });

          removeAgent(agentId);
        }
      }
    );
    return () => removeExitListener();
  }, [updateAgentStatus, addCompleted, removeAgent]);

  useEffect(() => {
    const removeHookListener = window.clubhouse.agent.onHookEvent(
      (agentId, event) => {
        handleHookEvent(agentId, event);
        const agent = useAgentStore.getState().agents[agentId];
        const name = agent?.name ?? agentId;
        checkAndNotify(name, event.eventName, event.toolName);

        // Auto-exit quick agents when Claude finishes (Stop event)
        if (event.eventName === 'Stop' && agent?.kind === 'quick') {
          window.clubhouse.pty.write(agentId, '/exit\n');
        }
      }
    );
    return () => removeHookListener();
  }, [handleHookEvent, checkAndNotify]);

  // Window resize: clamp pane widths if they exceed available space
  useEffect(() => {
    const handleWindowResize = () => {
      const layout = useLayoutStore.getState();
      if (layout.explorerCollapsed && layout.accessoryCollapsed) return;
      const available = window.innerWidth - PROJECT_RAIL_WIDTH - 300; // 300px min for content
      let ew = layout.explorerCollapsed ? 0 : layout.explorerWidth;
      let aw = layout.accessoryCollapsed ? 0 : layout.accessoryWidth;
      const total = ew + aw;
      if (total > available && total > 0) {
        const ratio = available / total;
        if (!layout.explorerCollapsed) {
          useLayoutStore.getState().setExplorerWidth(Math.max(EXPLORER_MIN, ew * ratio));
        }
        if (!layout.accessoryCollapsed) {
          useLayoutStore.getState().setAccessoryWidth(Math.max(ACCESSORY_MIN, aw * ratio));
        }
      }
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  // Explorer resize handler
  const handleExplorerResize = useCallback(
    (delta: number) => {
      if (explorerCollapsed) {
        // If collapsed and dragged outward, expand
        if (delta > SNAP_THRESHOLD) {
          setExplorerCollapsed(false);
          explorerDragWidth.current = EXPLORER_DEFAULT;
          if (explorerPaneRef.current) {
            explorerPaneRef.current.style.width = EXPLORER_DEFAULT + 'px';
          }
        }
        return;
      }
      const newWidth = explorerDragWidth.current + delta;
      // Snap to collapse
      if (newWidth < EXPLORER_MIN - SNAP_THRESHOLD) {
        setExplorerCollapsed(true);
        setDraggingExplorer(false);
        return;
      }
      const clamped = Math.round(Math.min(EXPLORER_MAX, Math.max(EXPLORER_MIN, newWidth)));
      explorerDragWidth.current = clamped;
      if (explorerPaneRef.current) {
        explorerPaneRef.current.style.width = clamped + 'px';
      }
    },
    [explorerCollapsed, setExplorerCollapsed],
  );

  const handleExplorerResizeEnd = useCallback(() => {
    setDraggingExplorer(false);
    if (!explorerCollapsed) {
      setExplorerWidth(explorerDragWidth.current);
    }
  }, [explorerCollapsed, setExplorerWidth]);

  // Accessory resize handler
  const handleAccessoryResize = useCallback(
    (delta: number) => {
      if (accessoryCollapsed) {
        // If collapsed and dragged outward (leftward = negative delta)
        if (delta < -SNAP_THRESHOLD) {
          setAccessoryCollapsed(false);
          accessoryDragWidth.current = ACCESSORY_DEFAULT;
          if (accessoryPaneRef.current) {
            accessoryPaneRef.current.style.width = ACCESSORY_DEFAULT + 'px';
          }
        }
        return;
      }
      // For accessory, negative delta = expand (handle is on the right side of accessory)
      const newWidth = accessoryDragWidth.current - delta;
      // Snap to collapse
      if (newWidth < ACCESSORY_MIN - SNAP_THRESHOLD) {
        setAccessoryCollapsed(true);
        setDraggingAccessory(false);
        return;
      }
      const clamped = Math.round(Math.min(ACCESSORY_MAX, Math.max(ACCESSORY_MIN, newWidth)));
      accessoryDragWidth.current = clamped;
      if (accessoryPaneRef.current) {
        accessoryPaneRef.current.style.width = clamped + 'px';
      }
    },
    [accessoryCollapsed, setAccessoryCollapsed],
  );

  const handleAccessoryResizeEnd = useCallback(() => {
    setDraggingAccessory(false);
    if (!accessoryCollapsed) {
      setAccessoryWidth(accessoryDragWidth.current);
    }
  }, [accessoryCollapsed, setAccessoryWidth]);

  // Sync drag width refs when store values change (e.g. from expand)
  useEffect(() => {
    explorerDragWidth.current = explorerWidth;
  }, [explorerWidth]);
  useEffect(() => {
    accessoryDragWidth.current = accessoryWidth;
  }, [accessoryWidth]);

  const isHome = activeProjectId === null;
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const TAB_LABELS: Record<string, string> = {
    agents: 'Agents',
    files: 'Files',
    terminal: 'Terminal',
    git: 'Git',
    notes: 'Notes',
    hub: 'Hub',
    settings: 'Settings',
  };

  const titleText = isHome
    ? 'Home'
    : activeProject
      ? `${TAB_LABELS[explorerTab] || explorerTab} (${activeProject.name})`
      : TAB_LABELS[explorerTab] || explorerTab;

  if (isHome) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
        <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center">
          <span className="text-xs text-ctp-subtext0 select-none">{titleText}</span>
        </div>
        <div className="flex-1 min-h-0 grid grid-cols-[60px_1fr]">
          <ProjectRail />
          <Dashboard />
        </div>
      </div>
    );
  }

  const showAccessory = !isFullWidth && !accessoryCollapsed;
  const showAccessoryHandle = !isFullWidth;
  const explorerTransition = !draggingExplorer ? 'pane-transition' : '';
  const accessoryTransition = !draggingAccessory ? 'pane-transition' : '';

  return (
    <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
      {/* Title bar */}
      <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center">
        <span className="text-xs text-ctp-subtext0 select-none">{titleText}</span>
      </div>
      {/* Git banner */}
      <GitBanner />
      {/* Main content area */}
      <div className="flex-1 min-h-0 flex flex-row overflow-hidden">
        {/* Project rail - fixed width */}
        <div className="flex-shrink-0" style={{ width: PROJECT_RAIL_WIDTH }}>
          <ProjectRail />
        </div>

        {/* Explorer rail - resizable or collapsed strip */}
        {explorerCollapsed ? (
          <CollapsedExplorerStrip />
        ) : (
          <div
            ref={explorerPaneRef}
            className={`flex-shrink-0 min-w-0 overflow-hidden ${explorerTransition}`}
            style={{ width: explorerWidth }}
          >
            <ExplorerRail />
          </div>
        )}

        {/* Explorer resize handle */}
        <ResizeHandle
          direction="horizontal"
          onResize={(delta) => {
            if (!draggingExplorer) setDraggingExplorer(true);
            handleExplorerResize(delta);
          }}
          onResizeEnd={handleExplorerResizeEnd}
          onDoubleClick={toggleExplorerCollapsed}
          collapsed={explorerCollapsed}
          collapseDirection="left"
        />

        {/* Accessory panel - resizable or hidden */}
        {showAccessory && (
          <div
            ref={accessoryPaneRef}
            className={`flex-shrink-0 min-w-0 overflow-hidden ${accessoryTransition}`}
            style={{ width: accessoryWidth }}
          >
            <AccessoryPanel />
          </div>
        )}

        {/* Accessory resize handle */}
        {showAccessoryHandle && (
          <ResizeHandle
            direction="horizontal"
            onResize={(delta) => {
              if (!draggingAccessory) setDraggingAccessory(true);
              handleAccessoryResize(delta);
            }}
            onResizeEnd={handleAccessoryResizeEnd}
            onDoubleClick={toggleAccessoryCollapsed}
            collapsed={accessoryCollapsed}
            collapseDirection="right"
          />
        )}

        {/* Main content - fills remaining space */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <MainContentView />
        </div>
      </div>
    </div>
  );
}
