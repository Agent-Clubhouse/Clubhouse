import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { AgentTerminal } from '../agents/AgentTerminal';
import { SleepingAgent } from '../agents/SleepingAgent';
import { AgentAvatarWithRing } from '../agents/AgentAvatar';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import type { PaneNode, LeafPane, SplitPane } from '../../plugins/builtin/hub/pane-tree';
import { syncCounterToTree, collectLeaves } from '../../plugins/builtin/hub/pane-tree';
import type { HubInstanceData } from '../../plugins/builtin/hub/useHubStore';

interface PopoutHubViewProps {
  hubId?: string;
  projectId?: string;
}

interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

export function PopoutHubView({ hubId, projectId }: PopoutHubViewProps) {
  const [hubData, setHubData] = useState<HubInstanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadHubData();
  }, [hubId, projectId]);

  async function loadHubData() {
    if (!hubId) {
      setError('No hub ID specified');
      setLoading(false);
      return;
    }

    try {
      // Resolve projectPath from projectId
      let projectPath: string | undefined;
      const scope = projectId ? 'project-local' : 'global';

      if (projectId) {
        const projects: ProjectInfo[] = await window.clubhouse.project.list();
        const project = projects.find((p) => p.id === projectId);
        if (project) {
          projectPath = project.path;
        }
      }

      const instances = await window.clubhouse.plugin.storageRead({
        pluginId: 'hub',
        scope,
        key: 'hub-instances',
        projectPath,
      }) as HubInstanceData[] | null;

      if (!instances || !Array.isArray(instances)) {
        setError('No hub data found');
        setLoading(false);
        return;
      }

      const hub = instances.find((h) => h.id === hubId);
      if (!hub) {
        setError(`Hub "${hubId}" not found`);
        setLoading(false);
        return;
      }

      syncCounterToTree(hub.paneTree);
      setHubData(hub);
      setLoading(false);
    } catch (err) {
      setError(`Failed to load hub: ${err}`);
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
        Loading hub...
      </div>
    );
  }

  if (error || !hubData) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-sm">
        {error || 'Hub not found'}
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-hidden">
      <PopoutPaneTree tree={hubData.paneTree} />
    </div>
  );
}

// ── Lightweight pane tree renderer for popout ─────────────────────────

function PopoutPaneTree({ tree }: { tree: PaneNode }) {
  if (tree.type === 'leaf') {
    return <PopoutLeafPane pane={tree} />;
  }

  return <PopoutSplitPane split={tree} />;
}

function PopoutSplitPane({ split }: { split: SplitPane }) {
  const isHorizontal = split.direction === 'horizontal';
  const ratio = split.ratio ?? 0.5;
  const sizeProp = isHorizontal ? 'width' : 'height';

  return (
    <div
      className={`flex ${isHorizontal ? 'flex-row' : 'flex-col'} w-full h-full min-w-0 min-h-0`}
    >
      <div className="min-w-0 min-h-0 overflow-hidden" style={{ [sizeProp]: `calc(${ratio * 100}% - 2px)` }}>
        <PopoutPaneTree tree={split.children[0]} />
      </div>
      <div
        className="flex-shrink-0 bg-surface-2"
        style={{ [isHorizontal ? 'width' : 'height']: 4 }}
      />
      <div className="min-w-0 min-h-0 overflow-hidden" style={{ [sizeProp]: `calc(${(1 - ratio) * 100}% - 2px)` }}>
        <PopoutPaneTree tree={split.children[1]} />
      </div>
    </div>
  );
}

function PopoutLeafPane({ pane }: { pane: LeafPane }) {
  const agent = useAgentStore((s) => pane.agentId ? s.agents[pane.agentId] : undefined);
  const spawnDurableAgent = useAgentStore((s) => s.spawnDurableAgent);
  const killAgent = useAgentStore((s) => s.killAgent);
  const projects = useProjectStore((s) => s.projects);
  const [paneHovered, setPaneHovered] = useState(false);

  const handleKill = useCallback(async () => {
    if (pane.agentId) {
      await killAgent(pane.agentId);
    }
  }, [pane.agentId, killAgent]);

  const handleWake = useCallback(async () => {
    if (!agent || agent.kind !== 'durable') return;
    const agentProject = projects.find((p) => p.id === agent.projectId);
    if (!agentProject) return;
    const configs = await window.clubhouse.agent.listDurable(agentProject.path);
    const config = configs.find((c: any) => c.id === agent.id);
    if (config) {
      await spawnDurableAgent(agentProject.id, agentProject.path, config, true);
    }
  }, [agent, projects, spawnDurableAgent]);

  const handleView = useCallback(() => {
    if (pane.agentId) {
      window.clubhouse.window.focusMain(pane.agentId);
    }
  }, [pane.agentId]);

  if (!pane.agentId || !agent) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-ctp-base">
        <span className="text-xs text-ctp-overlay0">Empty pane</span>
      </div>
    );
  }

  const isRunning = agent.status === 'running';
  const expanded = paneHovered;

  return (
    <div
      className="relative w-full h-full overflow-hidden rounded-sm"
      style={{ boxShadow: 'inset 0 0 0 1px rgb(var(--ctp-surface2) / 1)' }}
      onMouseEnter={() => setPaneHovered(true)}
      onMouseLeave={() => setPaneHovered(false)}
    >
      {/* Content area */}
      <div className="w-full h-full">
        {isRunning ? (
          <AgentTerminal agentId={agent.id} focused={false} />
        ) : (
          <SleepingAgent agent={agent} />
        )}
      </div>

      {/* Floating name chip */}
      <div
        className={`
          absolute top-2 left-2 z-20 transition-all duration-150 ease-out
          ${expanded ? 'right-2' : ''}
        `}
        style={expanded ? undefined : { maxWidth: 'fit-content' }}
      >
        <div
          className={`
            flex items-center gap-1.5 rounded-lg backdrop-blur-md transition-all duration-150
            ${expanded
              ? 'bg-ctp-mantle/95 shadow-lg px-2.5 py-1.5'
              : 'bg-ctp-mantle/70 shadow px-2 py-1'
            }
          `}
        >
          <AgentAvatarWithRing agent={agent} />
          <span className="text-[11px] font-medium text-ctp-text truncate">
            {agent.name}
          </span>
          {expanded && (
            <>
              <div className="flex-1" />
              <div className="flex items-center gap-1 ml-1 flex-shrink-0">
                <button
                  onClick={handleView}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text"
                  title="View in main window"
                  data-testid="popout-pane-view"
                >
                  View
                </button>
                {isRunning && (
                  <button
                    onClick={handleKill}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                    title="Stop agent"
                    data-testid="popout-pane-stop"
                  >
                    Stop
                  </button>
                )}
                {!isRunning && agent.kind === 'durable' && (
                  <button
                    onClick={handleWake}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 hover:bg-green-500/30"
                    title="Wake agent"
                    data-testid="popout-pane-wake"
                  >
                    Wake
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
