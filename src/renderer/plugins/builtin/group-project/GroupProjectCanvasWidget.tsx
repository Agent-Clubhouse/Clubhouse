import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { CanvasWidgetComponentProps } from '../../../../shared/plugin-types';
import type { TopicDigest, BulletinMessage } from '../../../../shared/group-project-types';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { renderMarkdownSafe } from '../../../utils/safe-markdown';
import { ptyWrite } from '../../../services/project-proxy';
import { useRemoteProject } from '../../../hooks/useRemoteProject';
import { AnnexUnsupportedPlaceholder } from '../../../features/annex/AnnexUnsupportedPlaceholder';
import { useAgentStore } from '../../../stores/agentStore';
import { pollingStartMsg, pollingStopMsg } from '../../../../shared/polling-messages';
import { useMcpSettingsStore } from '../../../stores/mcpSettingsStore';
import { Toggle } from '../../../components/Toggle';

const EXPANDED_WIDTH_THRESHOLD = 500;
const POLL_INTERVAL_MS = 5000;
const ALL_TOPICS_KEY = '__all__';

/** Inject a message into an agent's PTY using bracketed paste + Enter. */
function injectPtyMessage(agentId: string, message: string): void {
  const isMultiLine = message.includes('\n');
  if (isMultiLine) {
    ptyWrite(agentId, `\x1b[200~${message}\x1b[201~`);
  } else {
    ptyWrite(agentId, message);
  }
  // Delayed Enter so the agent processes the pasted content first
  setTimeout(() => ptyWrite(agentId, '\r'), 150);
}

export function GroupProjectCanvasWidget({
  widgetId: _widgetId,
  api,
  metadata,
  onUpdateMetadata,
  size: _size,
}: CanvasWidgetComponentProps) {
  const isAppMode = api.context.mode === 'app';
  const projectId = (metadata.projectId as string) || (isAppMode ? undefined : api.context.projectId);
  const remote = useRemoteProject(projectId);

  const mcpEnabled = !!useMcpSettingsStore((s) => s.enabled);

  // Group project bulletin board is not yet proxied over annex
  if (remote.isRemote) {
    const name = metadata.name as string | undefined;
    return (
      <AnnexUnsupportedPlaceholder
        widgetType="Group Project"
        reason={name ? `"${name}" is running on the satellite.` : 'Group project data is not yet available over Annex.'}
      />
    );
  }

  if (!mcpEnabled) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center" data-testid="group-project-mcp-disabled">
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
            Group Project requires MCP to be enabled. Enable it in Settings &gt; MCP.
          </div>
        </div>
      </div>
    );
  }

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

/* ---------- Deduplicate connected agents helper ---------- */

function dedupeAgents(bindings: McpBindingEntry[], groupProjectId: string): McpBindingEntry[] {
  const seen = new Set<string>();
  return bindings.filter((b) => {
    if (b.targetKind !== 'group-project' || b.targetId !== groupProjectId) return false;
    const key = `${b.agentId}:${b.targetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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


  const [showTapModal, setShowTapModal] = useState(false);
  const [topics, setTopics] = useState<TopicDigest[]>([]);

  useEffect(() => {
    if (!loaded) loadProjects();
  }, [loaded, loadProjects]);

  // Poll bulletin digest for activity summary
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (cancelled) return;
      try {
        const digest = await window.clubhouse.groupProject.getBulletinDigest(groupProjectId) as TopicDigest[];
        if (!cancelled) setTopics(digest);
      } catch { /* ignore */ }
    };
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [groupProjectId]);

  const project = useMemo(
    () => projects.find((p) => p.id === groupProjectId),
    [projects, groupProjectId],
  );

  const connectedAgents = useMemo(
    () => dedupeAgents(bindings, groupProjectId),
    [bindings, groupProjectId],
  );

  const hasActivity = connectedAgents.length > 0;
  const description = project?.description || '';
  const pollingEnabled = !!(project?.metadata?.pollingEnabled);

  const totalMessages = topics.reduce((sum, t) => sum + t.messageCount, 0);
  const totalNew = topics.reduce((sum, t) => sum + t.newMessageCount, 0);

  const handleTogglePolling = useCallback(async () => {
    const newVal = !pollingEnabled;
    await update(groupProjectId, { metadata: { pollingEnabled: newVal } } as any);
    onUpdateMetadata({ pollingEnabled: newVal });
    const name = project?.name || groupProjectId;
    const agents = useAgentStore.getState().agents;
    for (const agent of connectedAgents) {
      const orchestrator = agents[agent.agentId]?.orchestrator;
      const msg = newVal ? pollingStartMsg(name, orchestrator) : pollingStopMsg(name, orchestrator);
      injectPtyMessage(agent.agentId, msg);
    }
  }, [pollingEnabled, update, groupProjectId, onUpdateMetadata, connectedAgents, project]);

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      {/* Status + actions row */}
      <div className="flex items-center gap-2">
        <div
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
            hasActivity ? 'bg-ctp-green' : 'bg-ctp-overlay0'
          }`}
        />
        <RobotIcon size={14} />
        <span className="text-xs text-ctp-subtext0 flex-1 truncate">
          {connectedAgents.length} agent{connectedAgents.length !== 1 ? 's' : ''}
        </span>
        {/* Megaphone button */}
        <button
          onClick={() => setShowTapModal(true)}
          className="p-1 text-ctp-overlay1 hover:text-ctp-blue transition-colors flex-shrink-0"
          title="Broadcast message"
        >
          <MegaphoneIcon size={14} />
        </button>
        {/* Polling toggle */}
        <button
          onClick={handleTogglePolling}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors flex-shrink-0 ${
            pollingEnabled
              ? 'text-ctp-green bg-ctp-green/10'
              : 'text-ctp-overlay0 bg-surface-0'
          }`}
          title={pollingEnabled ? 'Polling active — click to stop' : 'Enable agent polling'}
        >
          <PollingIcon size={12} active={pollingEnabled} />
          <span className="text-[10px] font-medium">{pollingEnabled ? 'Poll: On' : 'Poll: Off'}</span>
        </button>
      </div>

      {/* Activity summary */}
      <div className="flex items-center gap-3 text-[10px] text-ctp-subtext0">
        <span>{topics.length} topic{topics.length !== 1 ? 's' : ''}</span>
        <span>{totalMessages} msg{totalMessages !== 1 ? 's' : ''}{totalNew > 0 && <span className="text-ctp-green ml-0.5">+{totalNew} new</span>}</span>
      </div>

      {/* Description snippet */}
      {description && (
        <div className="text-xs text-ctp-subtext0 truncate" title={description}>
          {description}
        </div>
      )}

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

      {/* Shoulder Tap Modal */}
      {showTapModal && (
        <ShoulderTapModal
          connectedAgents={connectedAgents}
          projectInstructions={project?.instructions || ''}
          onClose={() => setShowTapModal(false)}
        />
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


  const [selectedTopic, setSelectedTopic] = useState<string>(ALL_TOPICS_KEY);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [topics, setTopics] = useState<TopicDigest[]>([]);
  const [messages, setMessages] = useState<BulletinMessage[]>([]);
  const [showTapModal, setShowTapModal] = useState(false);

  useEffect(() => {
    if (!loaded) loadProjects();
  }, [loaded, loadProjects]);

  const project = useMemo(
    () => projects.find((p) => p.id === groupProjectId),
    [projects, groupProjectId],
  );

  // Inline editable description, instructions & shoulder tap toggle
  const [editDesc, setEditDesc] = useState(project?.description || '');
  const [editInstr, setEditInstr] = useState(project?.instructions || '');
  const [shoulderTapEnabled, setShoulderTapEnabled] = useState(!!(project?.metadata?.shoulderTapEnabled));
  const [saving, setSaving] = useState(false);

  // Sync local state when project data loads or changes externally
  useEffect(() => {
    if (project) {
      setEditDesc(project.description || '');
      setEditInstr(project.instructions || '');
      setShoulderTapEnabled(!!(project.metadata?.shoulderTapEnabled));
    }
  }, [project?.description, project?.instructions, project?.metadata?.shoulderTapEnabled]);

  const hasUnsavedChanges = project
    ? editDesc !== (project.description || '') ||
      editInstr !== (project.instructions || '') ||
      shoulderTapEnabled !== !!(project.metadata?.shoulderTapEnabled)
    : false;

  const handleSaveDescInstr = useCallback(async () => {
    if (!hasUnsavedChanges || saving) return;
    setSaving(true);
    try {
      await update(groupProjectId, {
        description: editDesc,
        instructions: editInstr,
        metadata: { shoulderTapEnabled },
      } as any);
    } finally {
      setSaving(false);
    }
  }, [hasUnsavedChanges, saving, update, groupProjectId, editDesc, editInstr, shoulderTapEnabled]);

  const connectedAgents = useMemo(
    () => dedupeAgents(bindings, groupProjectId),
    [bindings, groupProjectId],
  );

  const displayName = project?.name || 'Group Project';
  const pollingEnabled = !!(project?.metadata?.pollingEnabled);

  // Poll for digest + messages
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (cancelled) return;
      try {
        const digest = await window.clubhouse.groupProject.getBulletinDigest(groupProjectId) as TopicDigest[];
        if (!cancelled) setTopics(digest);
      } catch { /* ignore */ }

      if (selectedTopic === ALL_TOPICS_KEY) {
        try {
          const allMsgs = await window.clubhouse.groupProject.getAllMessages(groupProjectId) as BulletinMessage[];
          if (!cancelled) setMessages(allMsgs);
        } catch { /* ignore */ }
      } else if (selectedTopic) {
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

  // Sort messages newest-first so the feed shows latest on top
  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [messages],
  );

  const selectedMessage = useMemo(
    () => messages.find((m) => m.id === selectedMessageId) ?? null,
    [messages, selectedMessageId],
  );

  const handleTopicClick = useCallback((topic: string) => {
    setSelectedTopic(topic);
    setSelectedMessageId(null);
    setMessages([]);
  }, []);

  const handleTogglePolling = useCallback(async () => {
    const newVal = !pollingEnabled;
    await update(groupProjectId, { metadata: { pollingEnabled: newVal } } as any);
    onUpdateMetadata({ pollingEnabled: newVal });
    const name = project?.name || groupProjectId;
    const agents = useAgentStore.getState().agents;
    for (const agent of connectedAgents) {
      const orchestrator = agents[agent.agentId]?.orchestrator;
      const msg = newVal ? pollingStartMsg(name, orchestrator) : pollingStopMsg(name, orchestrator);
      injectPtyMessage(agent.agentId, msg);
    }
  }, [pollingEnabled, update, groupProjectId, onUpdateMetadata, connectedAgents, project]);

  return (
    <div className="flex flex-col h-full text-ctp-text">
      {/* Header */}
      <ExpandedHeader
        displayName={displayName}
        groupProjectId={groupProjectId}
        update={update}
        onUpdateMetadata={onUpdateMetadata}
        onShowTapModal={() => setShowTapModal(true)}
        pollingEnabled={pollingEnabled}
        onTogglePolling={handleTogglePolling}
      />

      {/* Inline Description & Instructions Editor */}
      <div className="flex gap-3 px-3 py-2 border-t border-surface-1 bg-ctp-mantle/50">
        <div className="flex-1 min-w-0">
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-ctp-subtext0 mb-1">Description</label>
          <textarea
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            placeholder="Purpose of this group project..."
            rows={5}
            className="w-full px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue resize-none"
          />
        </div>
        <div className="flex-1 min-w-0">
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-ctp-subtext0 mb-1">Instructions</label>
          <textarea
            value={editInstr}
            onChange={(e) => setEditInstr(e.target.value)}
            placeholder="Rules agents must follow..."
            rows={5}
            className="w-full px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue resize-none"
          />
        </div>
        <div className="flex flex-col justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <Toggle checked={shoulderTapEnabled} onChange={setShoulderTapEnabled} />
            <span className="text-[10px] text-ctp-subtext0 whitespace-nowrap" title="Allow agents to inject messages into each other's terminals">Shoulder Tap</span>
          </div>
          <button
            onClick={handleSaveDescInstr}
            disabled={!hasUnsavedChanges || saving}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-all ${
              hasUnsavedChanges
                ? 'bg-ctp-blue text-white shadow-md hover:opacity-90'
                : 'bg-surface-0 text-ctp-overlay0 cursor-default'
            }`}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* 3-Pane Content */}
      <div className="flex flex-1 min-h-0 border-t border-surface-1">
        {/* Topic Sidebar */}
        <div className="w-36 flex-shrink-0 border-r border-surface-1 overflow-y-auto">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider bg-ctp-blue/10 text-ctp-blue">
            Topics
          </div>
          {/* All virtual topic */}
          <button
            onClick={() => handleTopicClick(ALL_TOPICS_KEY)}
            className={`w-full text-left px-3 py-2 text-xs border-b border-surface-0 hover:bg-surface-0 transition-colors ${
              selectedTopic === ALL_TOPICS_KEY
                ? 'bg-surface-0 text-ctp-blue border-l-2 border-l-ctp-blue'
                : 'text-ctp-subtext1'
            }`}
          >
            <div className="font-medium">All</div>
            <div className="text-[10px] text-ctp-overlay0 mt-0.5">
              {topics.reduce((sum, t) => sum + t.messageCount, 0)} msgs
            </div>
          </button>
          {topics.map((t) => (
            <button
              key={t.topic}
              onClick={() => handleTopicClick(t.topic)}
              className={`w-full text-left px-3 py-2 text-xs border-b border-surface-0 hover:bg-surface-0 transition-colors ${
                selectedTopic === t.topic
                  ? 'bg-surface-0 text-ctp-blue border-l-2 border-l-ctp-blue'
                  : 'text-ctp-subtext1'
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
          ))}
          {topics.length === 0 && (
            <div className="p-3 text-xs text-ctp-overlay0 italic">No topics yet</div>
          )}
        </div>

        {/* Message List (compact preview pane) */}
        <div className="w-48 flex-shrink-0 border-r border-surface-1 overflow-y-auto">
          {sortedMessages.length === 0 ? (
            <div className="p-3 text-xs text-ctp-overlay0 italic">
              {selectedTopic === ALL_TOPICS_KEY ? 'No messages yet' : `No messages in "${selectedTopic}"`}
            </div>
          ) : (
            sortedMessages.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelectedMessageId(m.id)}
                className={`w-full text-left px-3 py-2 border-b border-surface-0 hover:bg-surface-0 transition-colors ${
                  selectedMessageId === m.id ? 'bg-surface-0' : ''
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="bg-ctp-blue/15 text-ctp-blue rounded px-1 py-0.5 text-[10px] font-medium truncate max-w-[80px]">
                    {senderShort(m.sender)}
                  </span>
                  <span className="ml-auto text-[10px] text-ctp-overlay0 flex-shrink-0">
                    {formatTime(m.timestamp)}
                  </span>
                </div>
                <div
                  className="text-xs text-ctp-subtext0 truncate mt-0.5 prose prose-xs prose-invert max-w-none [&>*]:inline [&>*]:m-0"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(m.body.slice(0, 80)) }}
                />
              </button>
            ))
          )}
        </div>

        {/* Message Detail (main content area) */}
        <div className="flex-1 min-w-0 overflow-y-auto p-3">
          {selectedMessage ? (
            <div className="text-xs space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="bg-ctp-blue/15 text-ctp-blue rounded px-1.5 py-0.5 text-[10px] font-medium">
                  {selectedMessage.sender}
                </span>
                <span className="text-ctp-overlay0">
                  {new Date(selectedMessage.timestamp).toLocaleString()}
                </span>
                {selectedTopic === ALL_TOPICS_KEY && (
                  <span className="text-ctp-overlay0">
                    in <span className="text-ctp-subtext1">{selectedMessage.topic}</span>
                  </span>
                )}
              </div>
              <div
                className="border-t border-surface-1 pt-2 mt-2 prose prose-xs prose-invert max-w-none break-words"
                dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(selectedMessage.body) }}
              />
            </div>
          ) : (
            <div className="text-xs text-ctp-overlay0 italic">Select a message</div>
          )}
        </div>
      </div>

      {/* Action Bar (agent count only) */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-surface-1 bg-ctp-mantle">
        <RobotIcon size={12} />
        <span className="text-[10px] text-ctp-subtext0">
          {connectedAgents.length} agent{connectedAgents.length !== 1 ? 's' : ''} connected
        </span>
      </div>

      {/* Shoulder Tap Modal */}
      {showTapModal && (
        <ShoulderTapModal
          connectedAgents={connectedAgents}
          projectInstructions={project?.instructions || ''}
          onClose={() => setShowTapModal(false)}
        />
      )}
    </div>
  );
}

/* ---------- Expanded Header ---------- */

function ExpandedHeader({
  displayName,
  groupProjectId,
  update,
  onUpdateMetadata,
  onShowTapModal,
  pollingEnabled,
  onTogglePolling,
}: {
  displayName: string;
  groupProjectId: string;
  update: (id: string, fields: { name?: string }) => Promise<void>;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
  onShowTapModal: () => void;
  pollingEnabled: boolean;
  onTogglePolling: () => void;
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
    <div className="flex items-center gap-2 px-3 py-2 bg-ctp-mantle border-b-2 border-ctp-blue/30">
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
      <div className="flex-1" />
      {/* Megaphone broadcast */}
      <button
        onClick={onShowTapModal}
        className="p-1 text-ctp-overlay1 hover:text-ctp-blue transition-colors flex-shrink-0"
        title="Broadcast message"
      >
        <MegaphoneIcon size={14} />
      </button>
      {/* Polling toggle */}
      <button
        onClick={onTogglePolling}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors flex-shrink-0 ${
          pollingEnabled
            ? 'text-ctp-green bg-ctp-green/10'
            : 'text-ctp-overlay0 bg-surface-0'
        }`}
        title={pollingEnabled ? 'Polling active — click to stop' : 'Enable agent polling'}
      >
        <PollingIcon size={12} active={pollingEnabled} />
        <span className="text-[10px] font-medium">{pollingEnabled ? 'Poll: On' : 'Poll: Off'}</span>
      </button>
    </div>
  );
}

/* ---------- Shoulder Tap Modal ---------- */

function ShoulderTapModal({
  connectedAgents,
  projectInstructions,
  onClose,
}: {
  connectedAgents: McpBindingEntry[];
  projectInstructions: string;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<string>('all');
  const [message, setMessage] = useState('');
  const [includeInstructions, setIncludeInstructions] = useState(false);
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(() => {
    const msg = message.trim();
    if (!msg && !includeInstructions) return;
    if (sending) return;
    setSending(true);

    const parts: string[] = [];
    if (includeInstructions && projectInstructions.trim()) {
      parts.push(`Project Instructions:\n${projectInstructions.trim()}`);
    }
    if (msg) parts.push(msg);
    const fullMessage = parts.join('\n\n');

    const targets = target === 'all'
      ? connectedAgents
      : connectedAgents.filter((a) => a.agentId === target);

    for (const agent of targets) {
      injectPtyMessage(agent.agentId, fullMessage);
    }

    setSending(false);
    onClose();
  }, [message, includeInstructions, projectInstructions, sending, target, connectedAgents, onClose]);

  return (
    <div
      className="absolute inset-0 bg-ctp-crust/80 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-ctp-base border border-surface-1 rounded-lg shadow-xl w-[90%] max-w-sm p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ctp-text flex items-center gap-2">
            <MegaphoneIcon size={16} />
            Broadcast Message
          </h3>
          <button onClick={onClose} className="text-ctp-overlay1 hover:text-ctp-text text-lg leading-none">&times;</button>
        </div>

        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Target</label>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text focus:outline-none focus:border-ctp-blue"
          >
            <option value="all">Broadcast to all</option>
            {connectedAgents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.agentName || a.agentId}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includeInstructions}
            onChange={(e) => setIncludeInstructions(e.target.checked)}
            className="accent-ctp-blue"
            disabled={!projectInstructions.trim()}
          />
          <span className={`text-xs ${projectInstructions.trim() ? 'text-ctp-subtext1' : 'text-ctp-overlay0'}`}>
            Include project instructions
          </span>
        </label>

        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Message</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your message..."
            rows={4}
            className="w-full px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue resize-none"
            autoFocus
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
            onClick={handleSend}
            disabled={(!message.trim() && !includeInstructions) || sending}
            className="px-3 py-1.5 text-xs font-medium bg-ctp-blue text-white rounded hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Icons ---------- */

function RobotIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="7" height="8" rx="1" />
      <rect x="14" y="11" width="7" height="8" rx="1" />
      <circle cx="5" cy="14" r="1" fill="currentColor" />
      <circle cx="8" cy="14" r="1" fill="currentColor" />
      <circle cx="16" cy="14" r="1" fill="currentColor" />
      <circle cx="19" cy="14" r="1" fill="currentColor" />
      <line x1="6.5" y1="11" x2="6.5" y2="8" />
      <line x1="17.5" y1="11" x2="17.5" y2="8" />
      <rect x="4" y="3" width="16" height="5" rx="1" />
      <line x1="8" y1="5.5" x2="16" y2="5.5" />
    </svg>
  );
}

function MegaphoneIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11l18-5v12L3 13v-2z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  );
}

function PollingIcon({ size = 14, active = false }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {active ? (
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      ) : (
        <line x1="2" y1="12" x2="22" y2="12" />
      )}
    </svg>
  );
}

/* ---------- Helpers ---------- */

function senderShort(sender: string): string {
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
