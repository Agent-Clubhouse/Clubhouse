import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';
import type { TopicDigest, BulletinMessage } from '../../../../shared/group-project-types';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';

const EXPANDED_WIDTH_THRESHOLD = 500;
const POLL_INTERVAL_MS = 5000;

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

  return <ProjectView groupProjectId={groupProjectId} onUpdateMetadata={onUpdateMetadata} />;
}

/* ---------- Creation Form ---------- */

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
        className="w-full px-3 py-1.5 text-sm bg-surface-0 border border-surface-2 rounded-md text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue"
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

/* ---------- Project View (detects compact vs expanded) ---------- */

function ProjectView({
  groupProjectId,
  onUpdateMetadata,
}: {
  groupProjectId: string;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsExpanded(entry.contentRect.width > EXPANDED_WIDTH_THRESHOLD);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="h-full w-full">
      {isExpanded ? (
        <ExpandedProjectView groupProjectId={groupProjectId} onUpdateMetadata={onUpdateMetadata} />
      ) : (
        <ProjectCard groupProjectId={groupProjectId} onUpdateMetadata={onUpdateMetadata} />
      )}
    </div>
  );
}

/* ---------- Compact Card ---------- */

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
  const description = project?.description || '';

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
            className="flex-1 px-2 py-0.5 text-sm font-semibold bg-surface-0 border border-surface-2 rounded text-ctp-text focus:outline-none focus:border-ctp-blue"
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

      {/* Description snippet */}
      {description && (
        <div className="text-xs text-ctp-subtext0 truncate" title={description}>
          {description}
        </div>
      )}

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
              className="px-2 py-0.5 text-[10px] bg-surface-0 text-ctp-subtext1 rounded-full"
            >
              {b.agentName || b.agentId}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Expanded 3-Pane View ---------- */

function ExpandedProjectView({
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
  const sendShoulderTap = useGroupProjectStore((s) => s.sendShoulderTap);

  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [topics, setTopics] = useState<TopicDigest[]>([]);
  const [messages, setMessages] = useState<BulletinMessage[]>([]);
  const [showSettings, setShowSettings] = useState(false);

  // Shoulder tap state
  const [tapTarget, setTapTarget] = useState<string>('all');
  const [tapMessage, setTapMessage] = useState('');
  const [tapSending, setTapSending] = useState(false);

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

  const displayName = project?.name || 'Group Project';

  // Poll for digest + messages
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (cancelled) return;
      try {
        const digest = await window.clubhouse.groupProject.getBulletinDigest(groupProjectId) as TopicDigest[];
        if (!cancelled) setTopics(digest);
      } catch { /* ignore */ }

      if (selectedTopic) {
        try {
          const msgs = await window.clubhouse.groupProject.getTopicMessages(groupProjectId, selectedTopic) as BulletinMessage[];
          if (!cancelled) setMessages(msgs);
        } catch { /* ignore */ }
      }
    };

    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [groupProjectId, selectedTopic]);

  // Auto-select first topic
  useEffect(() => {
    if (!selectedTopic && topics.length > 0) {
      setSelectedTopic(topics[0].topic);
    }
  }, [topics, selectedTopic]);

  const selectedMessage = useMemo(
    () => messages.find((m) => m.id === selectedMessageId) ?? null,
    [messages, selectedMessageId],
  );

  const handleTopicClick = useCallback((topic: string) => {
    setSelectedTopic(topic);
    setSelectedMessageId(null);
    setMessages([]);
  }, []);

  const handleSendTap = useCallback(async () => {
    const msg = tapMessage.trim();
    if (!msg || tapSending) return;
    setTapSending(true);
    try {
      await sendShoulderTap(
        groupProjectId,
        tapTarget === 'all' ? null : tapTarget,
        msg,
      );
      setTapMessage('');
    } finally {
      setTapSending(false);
    }
  }, [tapMessage, tapSending, tapTarget, groupProjectId, sendShoulderTap]);

  const handleTapKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendTap();
      }
    },
    [handleSendTap],
  );

  return (
    <div className="flex flex-col h-full text-ctp-text">
      {/* Header */}
      <ExpandedHeader
        displayName={displayName}
        description={project?.description || ''}
        groupProjectId={groupProjectId}
        update={update}
        onUpdateMetadata={onUpdateMetadata}
        onShowSettings={() => setShowSettings(true)}
      />

      {/* 3-Pane Content */}
      <div className="flex flex-1 min-h-0 border-t border-surface-1">
        {/* Topic Sidebar */}
        <div className="w-36 flex-shrink-0 border-r border-surface-1 overflow-y-auto">
          {topics.length === 0 ? (
            <div className="p-3 text-xs text-ctp-overlay0 italic">No topics yet</div>
          ) : (
            topics.map((t) => (
              <button
                key={t.topic}
                onClick={() => handleTopicClick(t.topic)}
                className={`w-full text-left px-3 py-2 text-xs border-b border-surface-0 hover:bg-surface-0 transition-colors ${
                  selectedTopic === t.topic ? 'bg-surface-0 text-ctp-blue' : 'text-ctp-subtext1'
                }`}
              >
                <div className="font-medium truncate">{t.topic}</div>
                <div className="text-[10px] text-ctp-overlay0 mt-0.5">
                  {t.messageCount} msg{t.messageCount !== 1 ? 's' : ''}
                  {t.newMessageCount > 0 && (
                    <span className="ml-1 text-ctp-green">+{t.newMessageCount}</span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Message List */}
        <div className="flex-1 min-w-0 border-r border-surface-1 overflow-y-auto">
          {selectedTopic ? (
            messages.length === 0 ? (
              <div className="p-3 text-xs text-ctp-overlay0 italic">No messages in "{selectedTopic}"</div>
            ) : (
              messages.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelectedMessageId(m.id)}
                  className={`w-full text-left px-3 py-2 border-b border-surface-0 hover:bg-surface-0 transition-colors ${
                    selectedMessageId === m.id ? 'bg-surface-0' : ''
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-medium text-ctp-blue truncate">{senderShort(m.sender)}</span>
                    <span className="ml-auto text-[10px] text-ctp-overlay0 flex-shrink-0">
                      {formatTime(m.timestamp)}
                    </span>
                  </div>
                  <div className="text-xs text-ctp-subtext0 truncate mt-0.5">
                    {m.body.slice(0, 100)}
                  </div>
                </button>
              ))
            )
          ) : (
            <div className="p-3 text-xs text-ctp-overlay0 italic">Select a topic</div>
          )}
        </div>

        {/* Message Detail */}
        <div className="w-56 flex-shrink-0 overflow-y-auto p-3">
          {selectedMessage ? (
            <div className="text-xs space-y-2">
              <div>
                <span className="text-ctp-overlay0">From:</span>{' '}
                <span className="text-ctp-blue font-medium">{selectedMessage.sender}</span>
              </div>
              <div>
                <span className="text-ctp-overlay0">Time:</span>{' '}
                {new Date(selectedMessage.timestamp).toLocaleString()}
              </div>
              <div>
                <span className="text-ctp-overlay0">Topic:</span>{' '}
                {selectedMessage.topic}
              </div>
              <div className="border-t border-surface-1 pt-2 mt-2 text-ctp-text whitespace-pre-wrap break-words">
                {selectedMessage.body}
              </div>
            </div>
          ) : (
            <div className="text-xs text-ctp-overlay0 italic">Select a message</div>
          )}
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-surface-1 bg-ctp-mantle">
        <div className="flex items-center gap-1 text-[10px] text-ctp-subtext0 flex-shrink-0">
          {connectedAgents.length} agent{connectedAgents.length !== 1 ? 's' : ''}
        </div>
        <div className="flex-shrink-0 text-[10px] text-ctp-overlay0">Tap:</div>
        <select
          value={tapTarget}
          onChange={(e) => setTapTarget(e.target.value)}
          className="px-1.5 py-1 text-[10px] bg-surface-0 border border-surface-2 rounded text-ctp-text focus:outline-none flex-shrink-0"
        >
          <option value="all">All</option>
          {connectedAgents.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.agentName || a.agentId}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={tapMessage}
          onChange={(e) => setTapMessage(e.target.value)}
          onKeyDown={handleTapKeyDown}
          placeholder="Shoulder tap message..."
          className="flex-1 min-w-0 px-2 py-1 text-[10px] bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue"
        />
        <button
          onClick={handleSendTap}
          disabled={!tapMessage.trim() || tapSending}
          className="px-2 py-1 text-[10px] font-medium bg-ctp-blue text-ctp-base rounded hover:opacity-90 disabled:opacity-40 transition-opacity flex-shrink-0"
        >
          {tapSending ? '...' : 'Send'}
        </button>
      </div>

      {/* Settings Modal */}
      {showSettings && project && (
        <SettingsModal
          project={project}
          groupProjectId={groupProjectId}
          update={update}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

/* ---------- Expanded Header ---------- */

function ExpandedHeader({
  displayName,
  description,
  groupProjectId,
  update,
  onUpdateMetadata,
  onShowSettings,
}: {
  displayName: string;
  description: string;
  groupProjectId: string;
  update: (id: string, fields: { name?: string }) => Promise<void>;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
  onShowSettings: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');

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
    <div className="flex items-center gap-2 px-3 py-2 bg-ctp-mantle">
      {editing ? (
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSaveEdit}
          className="px-2 py-0.5 text-sm font-semibold bg-surface-0 border border-surface-2 rounded text-ctp-text focus:outline-none focus:border-ctp-blue"
          autoFocus
        />
      ) : (
        <button
          onClick={handleStartEdit}
          className="text-sm font-semibold text-ctp-text hover:text-ctp-blue transition-colors truncate"
          title="Click to rename"
        >
          {displayName}
        </button>
      )}
      {description && (
        <span className="text-xs text-ctp-subtext0 truncate flex-1" title={description}>
          {description}
        </span>
      )}
      <button
        onClick={onShowSettings}
        className="ml-auto p-1 text-ctp-overlay1 hover:text-ctp-text transition-colors flex-shrink-0"
        title="Settings"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  );
}

/* ---------- Settings Modal ---------- */

function SettingsModal({
  project,
  groupProjectId,
  update,
  onClose,
}: {
  project: { description: string; instructions: string };
  groupProjectId: string;
  update: (id: string, fields: { description?: string; instructions?: string }) => Promise<void>;
  onClose: () => void;
}) {
  const [desc, setDesc] = useState(project.description);
  const [instr, setInstr] = useState(project.instructions);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await update(groupProjectId, { description: desc, instructions: instr });
      onClose();
    } finally {
      setSaving(false);
    }
  }, [desc, instr, groupProjectId, update, onClose]);

  return (
    <div className="absolute inset-0 bg-ctp-crust/80 flex items-center justify-center z-50">
      <div className="bg-ctp-base border border-surface-1 rounded-lg shadow-xl w-[90%] max-w-md p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ctp-text">Project Settings</h3>
          <button onClick={onClose} className="text-ctp-overlay1 hover:text-ctp-text text-lg leading-none">&times;</button>
        </div>

        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Description</label>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Purpose of this group project..."
            rows={3}
            className="w-full px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue resize-none"
          />
        </div>

        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Instructions (for agents)</label>
          <textarea
            value={instr}
            onChange={(e) => setInstr(e.target.value)}
            placeholder="Rules agents must follow..."
            rows={4}
            className="w-full px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue resize-none"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-ctp-subtext0 hover:text-ctp-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium bg-ctp-blue text-ctp-base rounded hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Helpers ---------- */

function senderShort(sender: string): string {
  // "robin@myapp" → "robin"
  const atIdx = sender.indexOf('@');
  return atIdx >= 0 ? sender.slice(0, atIdx) : sender;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
