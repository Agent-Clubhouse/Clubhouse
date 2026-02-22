import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { AgentTerminal } from '../agents/AgentTerminal';
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
  const leafCount = useMemo(() => collectLeaves(tree).length, [tree]);

  if (tree.type === 'leaf') {
    return <PopoutLeafPane pane={tree} />;
  }

  return <PopoutSplitPane split={tree} />;
}

function PopoutSplitPane({ split }: { split: SplitPane }) {
  const isHorizontal = split.direction === 'horizontal';
  const ratio = split.ratio ?? 0.5;
  const sizeProp = isHorizontal ? 'width' : 'height';
  const parentRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={parentRef}
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
  const [status, setStatus] = useState<'running' | 'sleeping'>('running');

  useEffect(() => {
    if (!pane.agentId) return;

    const removeExit = window.clubhouse.pty.onExit((exitAgentId: string) => {
      if (exitAgentId === pane.agentId) {
        setStatus('sleeping');
      }
    });

    const removeHook = window.clubhouse.agent.onHookEvent((hookAgentId: string, event: { kind: string }) => {
      if (hookAgentId === pane.agentId) {
        if (event.kind === 'stop') {
          setStatus('sleeping');
        } else if (status !== 'running') {
          setStatus('running');
        }
      }
    });

    return () => {
      removeExit();
      removeHook();
    };
  }, [pane.agentId, status]);

  const handleKill = useCallback(async () => {
    if (pane.agentId && pane.projectId) {
      await window.clubhouse.agent.killAgent(pane.agentId, pane.projectId);
    } else if (pane.agentId) {
      await window.clubhouse.pty.kill(pane.agentId);
    }
  }, [pane.agentId, pane.projectId]);

  if (!pane.agentId) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-ctp-base">
        <span className="text-xs text-ctp-overlay0">Empty pane</span>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <AgentTerminal agentId={pane.agentId} focused={false} />
      {status === 'running' && (
        <div className="absolute top-2 right-2 z-20">
          <button
            onClick={handleKill}
            className="text-[10px] px-2 py-0.5 rounded backdrop-blur-md bg-red-500/20 text-red-400 hover:bg-red-500/30 shadow-lg"
          >
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
