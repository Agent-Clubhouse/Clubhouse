import React, { useState, useCallback, useMemo, useEffect } from 'react';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';

export function GroupProjectCanvasWidget({
  widgetId: _widgetId,
  api: _api,
  metadata,
  onUpdateMetadata,
  size: _size,
}: CanvasWidgetComponentProps) {
  const groupProjectId = metadata.groupProjectId as string | undefined;

  if (!groupProjectId) {
    return <CreationForm onUpdateMetadata={onUpdateMetadata} />;
  }

  return <ProjectCard groupProjectId={groupProjectId} onUpdateMetadata={onUpdateMetadata} />;
}

function CreationForm({
  onUpdateMetadata,
}: {
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const create = useGroupProjectStore((s) => s.create);
  const loadProjects = useGroupProjectStore((s) => s.loadProjects);
  const loaded = useGroupProjectStore((s) => s.loaded);

  useEffect(() => {
    if (!loaded) loadProjects();
  }, [loaded, loadProjects]);

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const project = await create(trimmed);
      onUpdateMetadata({ groupProjectId: project.id, name: project.name });
    } finally {
      setCreating(false);
    }
  }, [name, creating, create, onUpdateMetadata]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleCreate();
    },
    [handleCreate],
  );

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
      <div className="text-xs text-ctp-subtext0 font-medium uppercase tracking-wider">
        New Group Project
      </div>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Project name..."
        className="w-full px-3 py-1.5 text-sm bg-ctp-surface0 border border-surface-2 rounded-md text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue"
        autoFocus
      />
      <button
        onClick={handleCreate}
        disabled={!name.trim() || creating}
        className="px-4 py-1.5 text-xs font-medium bg-ctp-blue text-ctp-base rounded-md hover:opacity-90 disabled:opacity-40 transition-opacity"
      >
        {creating ? 'Creating...' : 'Create'}
      </button>
    </div>
  );
}

function ProjectCard({
  groupProjectId,
  onUpdateMetadata,
}: {
  groupProjectId: string;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
}) {
  const bindings = useMcpBindingStore((s) => s.bindings);
  const projects = useGroupProjectStore((s) => s.projects);
  const loaded = useGroupProjectStore((s) => s.loaded);
  const loadProjects = useGroupProjectStore((s) => s.loadProjects);
  const update = useGroupProjectStore((s) => s.update);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');

  useEffect(() => {
    if (!loaded) loadProjects();
  }, [loaded, loadProjects]);

  const project = useMemo(
    () => projects.find((p) => p.id === groupProjectId),
    [projects, groupProjectId],
  );

  const connectedAgents = useMemo(
    () =>
      bindings.filter(
        (b) => b.targetKind === 'group-project' && b.targetId === groupProjectId,
      ),
    [bindings, groupProjectId],
  );

  const hasActivity = useMemo(() => connectedAgents.length > 0, [connectedAgents]);

  const displayName = project?.name || 'Group Project';

  const handleStartEdit = useCallback(() => {
    setEditName(displayName);
    setEditing(true);
  }, [displayName]);

  const handleSaveEdit = useCallback(async () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== displayName) {
      await update(groupProjectId, { name: trimmed });
      onUpdateMetadata({ name: trimmed });
    }
    setEditing(false);
  }, [editName, displayName, update, groupProjectId, onUpdateMetadata]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSaveEdit();
      if (e.key === 'Escape') setEditing(false);
    },
    [handleSaveEdit],
  );

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      {/* Header with name */}
      <div className="flex items-center gap-2">
        <div
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
            hasActivity ? 'bg-ctp-green animate-pulse' : 'bg-ctp-overlay0'
          }`}
        />
        {editing ? (
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSaveEdit}
            className="flex-1 px-2 py-0.5 text-sm font-semibold bg-ctp-surface0 border border-surface-2 rounded text-ctp-text focus:outline-none focus:border-ctp-blue"
            autoFocus
          />
        ) : (
          <button
            onClick={handleStartEdit}
            className="flex-1 text-left text-sm font-semibold text-ctp-text hover:text-ctp-blue transition-colors truncate"
            title="Click to rename"
          >
            {displayName}
          </button>
        )}
      </div>

      {/* Agent count */}
      <div className="flex items-center gap-2 text-xs text-ctp-subtext0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <span>
          {connectedAgents.length} agent{connectedAgents.length !== 1 ? 's' : ''} connected
        </span>
      </div>

      {/* Agent list */}
      {connectedAgents.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {connectedAgents.map((b) => (
            <span
              key={b.agentId}
              className="px-2 py-0.5 text-[10px] bg-ctp-surface0 text-ctp-subtext1 rounded-full"
            >
              {b.agentName || b.agentId}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

