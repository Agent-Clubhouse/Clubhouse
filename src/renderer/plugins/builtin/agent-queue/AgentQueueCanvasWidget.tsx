import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';
import type { AgentQueueTaskSummary } from '../../../../shared/agent-queue-types';
import { useAgentQueueStore } from '../../../stores/agentQueueStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useMcpSettingsStore } from '../../../stores/mcpSettingsStore';

const POLL_INTERVAL_MS = 5000;

export function AgentQueueCanvasWidget({
  widgetId: _widgetId,
  api,
  metadata,
  onUpdateMetadata,
  size: _size,
}: CanvasWidgetComponentProps) {
  const mcpEnabled = !!useMcpSettingsStore((s) => s.enabled);

  if (!mcpEnabled) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center" data-testid="agent-queue-mcp-disabled">
        <div className="w-10 h-10 rounded-lg bg-surface-1 flex items-center justify-center">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-overlay1">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium text-ctp-subtext1">MCP Required</div>
          <div className="text-[10px] text-ctp-overlay0 max-w-[200px]">
            Agent Queue requires MCP to be enabled. Enable it in Settings &gt; MCP.
          </div>
        </div>
      </div>
    );
  }

  const queueId = metadata.queueId as string | undefined;

  if (!queueId) {
    return <CreationForm api={api} onUpdateMetadata={onUpdateMetadata} />;
  }

  return <QueueView queueId={queueId} onUpdateMetadata={onUpdateMetadata} />;
}

/* ---------- Creation Form ---------- */

function CreationForm({
  api,
  onUpdateMetadata,
}: {
  api: CanvasWidgetComponentProps['api'];
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const create = useAgentQueueStore((s) => s.create);
  const update = useAgentQueueStore((s) => s.update);
  const projects = useProjectStore((s) => s.projects);
  const loadProjects = useProjectStore((s) => s.loadProjects);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Default to active project or first project
  useEffect(() => {
    if (!selectedProjectId && projects.length > 0) {
      const contextProjectId = api.context.mode === 'project' ? api.context.projectId : undefined;
      setSelectedProjectId(contextProjectId || projects[0].id);
    }
  }, [projects, selectedProjectId, api.context]);

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const queue = await create(trimmed);
      const project = projects.find(p => p.id === selectedProjectId);
      if (project) {
        await update(queue.id, {
          projectId: project.id,
          projectPath: project.path,
        });
      }
      onUpdateMetadata({
        queueId: queue.id,
        name: queue.name,
        projectId: project?.id,
        projectPath: project?.path,
      });
    } finally {
      setCreating(false);
    }
  }, [name, creating, create, update, projects, selectedProjectId, onUpdateMetadata]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleCreate();
    },
    [handleCreate],
  );

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
      <div className="text-xs text-ctp-subtext0 font-medium uppercase tracking-wider">
        New Agent Queue
      </div>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Queue name..."
        className="w-full px-3 py-1.5 text-sm bg-surface-0 border border-surface-2 rounded-md text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue"
        autoFocus
      />
      {projects.length > 0 && (
        <select
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
          className="w-full px-3 py-1.5 text-sm bg-surface-0 border border-surface-2 rounded-md text-ctp-text focus:outline-none focus:border-ctp-blue"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName || p.name}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={handleCreate}
        disabled={!name.trim() || creating}
        className="px-4 py-1.5 text-xs font-medium bg-ctp-blue text-ctp-base rounded-md hover:opacity-90 disabled:opacity-40 transition-opacity"
      >
        {creating ? 'Creating...' : 'Create Queue'}
      </button>
    </div>
  );
}

/* ---------- Queue View ---------- */

function QueueView({
  queueId,
  onUpdateMetadata: _onUpdateMetadata,
}: {
  queueId: string;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
}) {
  const [tasks, setTasks] = useState<AgentQueueTaskSummary[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const listTasks = useAgentQueueStore((s) => s.listTasks);
  const queues = useAgentQueueStore((s) => s.queues);
  const queue = queues.find(q => q.id === queueId);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshTasks = useCallback(async () => {
    try {
      const result = await listTasks(queueId);
      setTasks(result || []);
    } catch { /* ignore */ }
  }, [queueId, listTasks]);

  useEffect(() => {
    refreshTasks();
    pollRef.current = setInterval(refreshTasks, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshTasks]);

  // Also refresh when task changes come in
  useEffect(() => {
    const cleanup = window.clubhouse.agentQueue.onTaskChanged((data) => {
      if (data.queueId === queueId) {
        refreshTasks();
      }
    });
    return cleanup;
  }, [queueId, refreshTasks]);

  const runningCount = tasks.filter(t => t.status === 'running').length;
  const pendingCount = tasks.filter(t => t.status === 'pending').length;
  const completedCount = tasks.filter(t => t.status === 'completed').length;
  const failedCount = tasks.filter(t => t.status === 'failed').length;

  if (!queue) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-ctp-overlay0">
        Queue not found
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full text-xs overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-ctp-text truncate">{queue.name}</span>
          <span className="text-[10px] text-ctp-overlay0">
            {runningCount > 0 && <span className="text-ctp-green mr-1">{runningCount} running</span>}
            {pendingCount > 0 && <span className="text-ctp-yellow mr-1">{pendingCount} pending</span>}
          </span>
        </div>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="p-1 rounded hover:bg-surface-1 text-ctp-overlay1 hover:text-ctp-text transition-colors shrink-0"
          title="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>

      {showSettings ? (
        <QueueSettings queueId={queueId} queue={queue} />
      ) : (
        /* Task List */
        <div className="flex-1 overflow-y-auto">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-ctp-overlay0 p-4">
              <div className="text-sm">No tasks yet</div>
              <div className="text-[10px] text-center max-w-[200px]">
                Wire an agent to this queue. The agent can then invoke tasks using MCP tools.
              </div>
            </div>
          ) : (
            <div className="divide-y divide-surface-1">
              {[...tasks].reverse().map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer status bar */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-surface-2 text-[10px] text-ctp-overlay0 shrink-0">
        <span>{tasks.length} total</span>
        {completedCount > 0 && <span className="text-ctp-green">{completedCount} done</span>}
        {failedCount > 0 && <span className="text-ctp-red">{failedCount} failed</span>}
        <span className="ml-auto">concurrency: {queue.concurrency || 1}</span>
      </div>
    </div>
  );
}

/* ---------- Task Row ---------- */

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-ctp-yellow',
  running: 'bg-ctp-green',
  completed: 'bg-ctp-blue',
  failed: 'bg-ctp-red',
  cancelled: 'bg-ctp-overlay0',
};

function TaskRow({ task }: { task: AgentQueueTaskSummary }) {
  return (
    <div className="px-3 py-2 hover:bg-surface-0 transition-colors">
      <div className="flex items-center gap-2">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[task.status] || 'bg-ctp-overlay0'}`} />
        <span className="text-ctp-text truncate flex-1" title={task.mission}>
          {task.mission.length > 80 ? task.mission.slice(0, 80) + '...' : task.mission}
        </span>
        <span className="text-[10px] text-ctp-overlay0 shrink-0">{task.status}</span>
      </div>
      {task.agentName && (
        <div className="text-[10px] text-ctp-overlay0 ml-3.5 mt-0.5">
          {task.agentName}
          {task.completedAt && ` \u00b7 ${formatDuration(task.createdAt, task.completedAt)}`}
        </div>
      )}
    </div>
  );
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

/* ---------- Settings Panel ---------- */

function QueueSettings({
  queueId,
  queue,
}: {
  queueId: string;
  queue: { concurrency: number; model?: string; freeAgentMode?: boolean; autoWorktree?: boolean };
}) {
  const update = useAgentQueueStore((s) => s.update);
  const [concurrency, setConcurrency] = useState(String(queue.concurrency || 1));
  const [model, setModel] = useState(queue.model || '');
  const [freeAgent, setFreeAgent] = useState(!!queue.freeAgentMode);
  const [autoWorktree, setAutoWorktree] = useState(!!queue.autoWorktree);

  const handleSave = useCallback(async () => {
    await update(queueId, {
      concurrency: Math.max(1, parseInt(concurrency, 10) || 1),
      model: model || undefined,
      freeAgentMode: freeAgent || undefined,
      autoWorktree: autoWorktree || undefined,
    });
  }, [queueId, concurrency, model, freeAgent, autoWorktree, update]);

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      <div>
        <label className="block text-[10px] text-ctp-overlay0 mb-1">Concurrency</label>
        <input
          type="number"
          min="1"
          max="20"
          value={concurrency}
          onChange={(e) => setConcurrency(e.target.value)}
          onBlur={handleSave}
          className="w-full px-2 py-1 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text focus:outline-none focus:border-ctp-blue"
        />
      </div>
      <div>
        <label className="block text-[10px] text-ctp-overlay0 mb-1">Model (optional)</label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={handleSave}
          placeholder="default"
          className="w-full px-2 py-1 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue"
        />
      </div>
      <div className="flex items-center justify-between">
        <label className="text-[10px] text-ctp-overlay0">Free Agent Mode</label>
        <input
          type="checkbox"
          checked={freeAgent}
          onChange={(e) => {
            setFreeAgent(e.target.checked);
            void update(queueId, { freeAgentMode: e.target.checked || undefined });
          }}
          className="rounded"
        />
      </div>
      <div className="flex items-center justify-between">
        <label className="text-[10px] text-ctp-overlay0">Auto Worktree</label>
        <input
          type="checkbox"
          checked={autoWorktree}
          onChange={(e) => {
            setAutoWorktree(e.target.checked);
            void update(queueId, { autoWorktree: e.target.checked || undefined });
          }}
          className="rounded"
        />
      </div>
    </div>
  );
}
