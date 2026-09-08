import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { GroupProjectPanelSidebar, useGroupProjectPanelLayout, stopPlainWheelPropagation } from './GroupProjectPanelSidebar';
import type { CanvasWidgetComponentProps, AnnexAPI } from '../../../../shared/plugin-types';
import type { TopicDigest, BulletinMessage } from '../../../../shared/group-project-types';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
import { useBulletinReadStore } from '../../../stores/bulletinReadStore';
import { renderMarkdownSafe } from '../../../utils/safe-markdown';
import { useRemoteProject } from '../../../hooks/useRemoteProject';
import { useAgentStore } from '../../../stores/agentStore';
import { pollingNudgeMsg } from '../../../../shared/polling-messages';
import { getProjectAdmins, isProjectAdmin, addAdmin, removeAdmin } from '../../../../shared/group-project-admin';
import { useMcpSettingsStore } from '../../../stores/mcpSettingsStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { useGroupProjectContext, type GroupProjectContextValue, type GroupProjectMember } from './useGroupProjectContext';
import { useUIStore } from '../../../stores/uiStore';
import { showApprovalDialog, showConfirmDialog } from '../../PluginDialog';
import { WireToolPermissionsDialog } from '../canvas/WireToolPermissionsDialog';
import {
  GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION,
  GROUP_PROJECT_CORE_TOOL_SUFFIXES,
  GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES,
  getDefaultGroupProjectDisabledToolsFromMetadata,
} from '../../../../shared/group-project-permissions';

const EXPANDED_WIDTH_THRESHOLD = 500;
const POLL_INTERVAL_MS = 5000;
const ALL_TOPICS_KEY = '__all__';

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

  // Detect remote app-level canvas: app mode with an active satellite host.
  // useRemoteProject only works for project-level canvases (namespaced project IDs).
  // For app-level canvases over Annex, activeHostId provides the satellite context.
  const activeHostId = useUIStore((s) => s.activeHostId);
  const isRemoteApp = isAppMode && !remote.isRemote && !!activeHostId;
  const isRemote = remote.isRemote || isRemoteApp;
  const satelliteId = remote.isRemote ? remote.satelliteId : isRemoteApp ? activeHostId : null;

  const mcpEnabled = !!useMcpSettingsStore((s) => s.enabled);

  // MCP check — only relevant for local (remote satellites manage their own MCP)
  if (!isRemote && !mcpEnabled) {
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
          <div className="text-xs text-ctp-overlay0 max-w-[200px]">
            Group Project requires MCP to be enabled. Enable it in Settings &gt; MCP.
          </div>
        </div>
      </div>
    );
  }

  const groupProjectId = metadata.groupProjectId as string | undefined;

  if (!groupProjectId && !isRemote) {
    return <CreationForm onUpdateMetadata={onUpdateMetadata} />;
  }

  if (!groupProjectId) {
    return <div className="flex items-center justify-center h-full text-xs text-ctp-overlay0 italic p-4">No group project selected</div>;
  }

  return (
    <ProjectView
      groupProjectId={groupProjectId}
      onUpdateMetadata={onUpdateMetadata}
      isRemote={isRemote}
      satelliteId={satelliteId}
      annex={api.annex}
    />
  );
}

/* ---------- Creation Form ---------- */

function CreationForm({
  onUpdateMetadata,
}: {
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    try {
      const project = await create(trimmed);
      onUpdateMetadata({ groupProjectId: project.id, name: project.name });
    } catch (err) {
      // Surface the failure instead of silently resetting the card. The most
      // common cause is an unregistered IPC handler ("No handler registered for
      // 'group-project:create'"), but disk/permission errors during the registry
      // flush surface here too.
      const message = err instanceof Error ? err.message : String(err);
      console.error('[group-project] create failed:', message);
      setError(`Couldn't create project: ${message}`);
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
        onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
        onKeyDown={handleKeyDown}
        placeholder="Project name..."
        className="w-full px-3 py-1.5 text-sm bg-surface-0 border border-surface-2 rounded-md text-ctp-text placeholder:text-ctp-overlay0 focus-ring"
        autoFocus
      />
      <button
        onClick={handleCreate}
        disabled={!name.trim() || creating}
        className="px-4 py-1.5 text-xs font-medium bg-ctp-accent text-ctp-base rounded-md hover:opacity-90 disabled:opacity-40 transition-opacity"
      >
        {creating ? 'Creating...' : 'Create'}
      </button>
      {error && (
        <div role="alert" className="w-full text-xs text-ctp-red bg-ctp-red/10 border border-ctp-red/30 rounded-md px-3 py-1.5">
          {error}
        </div>
      )}
    </div>
  );
}

/* ---------- Project View (detects compact vs expanded) ---------- */

function ProjectView({
  groupProjectId,
  onUpdateMetadata,
  isRemote,
  satelliteId,
  annex,
}: {
  groupProjectId: string;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
  isRemote: boolean;
  satelliteId: string | null;
  annex: AnnexAPI;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const ctx = useGroupProjectContext(groupProjectId, isRemote, satelliteId, annex);

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
        <ExpandedProjectView groupProjectId={groupProjectId} onUpdateMetadata={onUpdateMetadata} ctx={ctx} />
      ) : (
        <ProjectCard groupProjectId={groupProjectId} onUpdateMetadata={onUpdateMetadata} ctx={ctx} />
      )}
    </div>
  );
}

/* ---------- Unread / read-state helpers ---------- */

/**
 * The digest entry for the channel the user has open, or null.
 *
 * The "All" pane deliberately marks nothing read: it is the default selection,
 * so treating it as a read of every channel would clear every badge the moment
 * the widget renders and make unread counts useless.
 */
export function openChannel(topics: TopicDigest[], selectedTopic: string): TopicDigest | null {
  if (selectedTopic === ALL_TOPICS_KEY) return null;
  return topics.find((t) => t.topic === selectedTopic) ?? null;
}

/** Zero the unread badge for a channel, so it clears without a poll round-trip. */
export function clearUnread(topics: TopicDigest[], channel: TopicDigest | null): TopicDigest[] {
  if (!channel) return topics;
  return topics.map((t) => (t.topic === channel.topic ? { ...t, newMessageCount: 0 } : t));
}

/* ---------- Compact Card ---------- */

function ProjectCard({
  groupProjectId,
  onUpdateMetadata,
  ctx,
}: {
  groupProjectId: string;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
  ctx: GroupProjectContextValue;
}) {
  const { project, members, loaded, loadProjects, update, setPolling, fetchDigest, injectMessage } = ctx;

  const [showTapModal, setShowTapModal] = useState(false);
  const [topics, setTopics] = useState<TopicDigest[]>([]);
  const getLastRead = useBulletinReadStore((s) => s.getLastRead);

  useEffect(() => {
    if (!loaded) loadProjects();
  }, [loaded, loadProjects]);

  // Poll bulletin digest for activity summary. The compact card has no channel
  // list to open, so it only reports unread — it never marks anything read.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (cancelled) return;
      try {
        const digest = await fetchDigest(groupProjectId, getLastRead(groupProjectId));
        if (!cancelled) setTopics(digest);
      } catch { /* ignore */ }
    };
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [groupProjectId, fetchDigest, getLastRead]);

  const hasActivity = members.length > 0;
  const description = project?.description || '';
  const pollingEnabled = !!(project?.metadata?.pollingEnabled);

  const totalMessages = topics.reduce((sum, t) => sum + t.messageCount, 0);
  const totalNew = topics.reduce((sum, t) => sum + t.newMessageCount, 0);

  const admins = getProjectAdmins(project?.metadata);
  const handleToggleAdmin = useCallback(async (agentId: string) => {
    const next = isProjectAdmin(project?.metadata, agentId)
      ? removeAdmin(project?.metadata, agentId)
      : addAdmin(project?.metadata, agentId);
    await update(groupProjectId, { metadata: { admins: next } });
    onUpdateMetadata({ admins: next });
  }, [project?.metadata, groupProjectId, update, onUpdateMetadata]);

  const handleTogglePolling = useCallback(async () => {
    const newVal = !pollingEnabled;
    // Delegate persist + member start/stop side-effect to the shared main-process
    // code path (setProjectPolling), the same one the toggle_polling MCP command
    // uses, so the setting and the injected instructions can't diverge.
    await setPolling(groupProjectId, newVal);
    onUpdateMetadata({ pollingEnabled: newVal });
  }, [pollingEnabled, setPolling, groupProjectId, onUpdateMetadata]);

  const handleNudgePolling = useCallback(() => {
    const name = project?.name || groupProjectId;
    const agents = useAgentStore.getState().agents;
    for (const member of members) {
      const orchestrator = agents[member.agentId]?.orchestrator;
      void injectMessage(member.agentId, pollingNudgeMsg(name, orchestrator));
    }
  }, [members, project, groupProjectId, injectMessage]);

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
          {members.length} agent{members.length !== 1 ? 's' : ''}
        </span>
        {/* Megaphone button */}
        <button
          onClick={() => setShowTapModal(true)}
          className="p-1 text-ctp-overlay1 hover:text-ctp-accent transition-colors flex-shrink-0"
          title="Broadcast message"
        >
          <MegaphoneIcon size={14} />
        </button>
        {/* Polling nudge */}
        <button
          onClick={handleNudgePolling}
          className="p-1 text-ctp-overlay1 hover:text-ctp-yellow transition-colors flex-shrink-0"
          title="Nudge all agents to start polling if not already"
        >
          <NudgeIcon size={14} />
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
          <span className="text-xs font-medium">{pollingEnabled ? 'Poll: On' : 'Poll: Off'}</span>
        </button>
      </div>

      {/* Activity summary */}
      <div className="flex items-center gap-3 text-xs text-ctp-subtext0">
        <span>{topics.length} topic{topics.length !== 1 ? 's' : ''}</span>
        <span>{totalMessages} msg{totalMessages !== 1 ? 's' : ''}{totalNew > 0 && <span className="text-ctp-green ml-0.5">+{totalNew} new</span>}</span>
      </div>

      {/* Description snippet */}
      {description && (
        <div className="text-xs text-ctp-subtext0 truncate" title={description}>
          {description}
        </div>
      )}

      {/* Agent list — click a member to toggle their project-lead (admin) role.
          Admins show a star and get the privileged group-project tools. */}
      {members.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {members.map((m) => {
            const admin = admins.includes(m.agentId);
            return (
              <button
                key={m.agentId}
                onClick={(e) => { e.stopPropagation(); void handleToggleAdmin(m.agentId); }}
                title={admin ? 'Project lead — click to remove admin' : 'Click to make project lead (admin)'}
                className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded-full transition-colors ${
                  admin
                    ? 'bg-ctp-accent/20 text-ctp-accent'
                    : 'bg-surface-0 text-ctp-subtext1 hover:bg-surface-1'
                }`}
              >
                {admin && <StarIcon size={9} filled />}
                {m.agentName || m.agentId}
              </button>
            );
          })}
        </div>
      )}

      {/* Shoulder Tap Modal */}
      {showTapModal && (
        <ShoulderTapModal
          members={members}
          projectInstructions={project?.instructions || ''}
          onClose={() => setShowTapModal(false)}
          injectMessage={injectMessage}
        />
      )}
    </div>
  );
}

/* ---------- Expanded 3-Pane View ---------- */

function ExpandedProjectView({
  groupProjectId,
  onUpdateMetadata,
  ctx,
}: {
  groupProjectId: string;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
  ctx: GroupProjectContextValue;
}) {
  const { project, members, loaded, loadProjects, update, setPolling, fetchDigest, fetchTopicMessages, fetchAllMessages, postBulletinMessage, injectMessage, deleteMessage, deleteTopic, setTopicProtection, clearAllMessages } = ctx;

  const {
    topicsWidth,
    topicsCollapsed,
    messagesWidth,
    messagesCollapsed,
    resizeTopics,
    toggleTopicsCollapse,
    resizeMessages,
    toggleMessagesCollapse,
  } = useGroupProjectPanelLayout();

  const [selectedTopic, setSelectedTopic] = useState<string>(ALL_TOPICS_KEY);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [topics, setTopics] = useState<TopicDigest[]>([]);
  const [messages, setMessages] = useState<BulletinMessage[]>([]);
  const [showTapModal, setShowTapModal] = useState(false);
  const [showRetentionSettings, setShowRetentionSettings] = useState(false);
  const [confirmDeleteTopic, setConfirmDeleteTopic] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [bulletinTopic, setBulletinTopic] = useState('');
  const [bulletinBody, setBulletinBody] = useState('');
  const [postingBulletin, setPostingBulletin] = useState(false);

  // Read state is pulled at call time rather than subscribed to, so marking a
  // channel read doesn't tear down and restart the polling interval.
  const getLastRead = useBulletinReadStore((s) => s.getLastRead);
  const markTopicRead = useBulletinReadStore((s) => s.markTopicRead);

  useEffect(() => {
    if (!loaded) loadProjects();
  }, [loaded, loadProjects]);

  // Inline editable description, instructions & connection defaults
  const [editDesc, setEditDesc] = useState(project?.description || '');
  const [editInstr, setEditInstr] = useState(project?.instructions || '');
  const [saving, setSaving] = useState(false);
  const [showDefaultPermissionsDialog, setShowDefaultPermissionsDialog] = useState(false);

  const getDefaultDisabledTools = () =>
    getDefaultGroupProjectDisabledToolsFromMetadata(project?.metadata);

  const [defaultDisabledTools, setDefaultDisabledTools] = useState<string[]>(() => getDefaultDisabledTools());

  // Sync local state when project data loads or changes externally
  useEffect(() => {
    if (project) {
      setEditDesc(project.description || '');
      setEditInstr(project.instructions || '');
      setDefaultDisabledTools(getDefaultGroupProjectDisabledToolsFromMetadata(project.metadata));
    }
  }, [project?.description, project?.instructions, project?.metadata?.defaultDisabledTools]);

  const computeDefaultDisabledTools = useCallback(() => {
    return [...defaultDisabledTools];
  }, [defaultDisabledTools]);

  const hasUnsavedChanges = project
    ? editDesc !== (project.description || '') ||
      editInstr !== (project.instructions || '') ||
      JSON.stringify(computeDefaultDisabledTools().sort()) !==
        JSON.stringify(getDefaultDisabledTools().sort())
    : false;

  const setDisabledTools = useMcpBindingStore((s) => s.setDisabledTools);

  const handleSaveDescInstr = useCallback(async () => {
    if (!hasUnsavedChanges || saving) return;
    // Wave 10 #8: confirm Save with the new-vs-existing choice INSIDE the
    // dialog so the user picks scope at confirm time, instead of forcing them
    // to pre-commit by clicking one of two ambiguous side-by-side buttons.
    const { promise } = showApprovalDialog({
      title: 'Save default permissions',
      summary:
        'Apply the new defaults to future connections only, or also retroactively apply them to every existing wire on this project?',
      actions: [
        { value: 'cancel', label: 'Cancel', style: 'default' },
        { value: 'future', label: 'Apply to new only', style: 'default' },
        { value: 'all', label: 'Apply to all', style: 'primary' },
      ],
    });
    const choice = await promise;
    if (choice !== 'future' && choice !== 'all') return;
    const applyToAll = choice === 'all';

    setSaving(true);
    try {
      const defaultDisabledTools = computeDefaultDisabledTools();
      await update(groupProjectId, {
        description: editDesc,
        instructions: editInstr,
        metadata: { defaultDisabledTools, defaultDisabledToolsVersion: GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION },
      });

      if (applyToAll) {
        const allBindings = useMcpBindingStore.getState().bindings;
        const projectBindings = allBindings.filter(
          b => b.targetId === groupProjectId && b.targetKind === 'group-project',
        );
        for (const binding of projectBindings) {
          await setDisabledTools(binding.agentId, binding.targetId, defaultDisabledTools);
        }
      }
    } finally {
      setSaving(false);
    }
  }, [hasUnsavedChanges, saving, update, groupProjectId, editDesc, editInstr, computeDefaultDisabledTools, setDisabledTools]);

  const displayName = project?.name || 'Group Project';
  const pollingEnabled = !!(project?.metadata?.pollingEnabled);
  const enabledPrivilegedDefaults = GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES.filter(
    (suffix) => !defaultDisabledTools.includes(suffix),
  ).length;
  const disabledDefaultCount = defaultDisabledTools.length;

  // Poll for digest + messages
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (cancelled) return;
      try {
        const digest = await fetchDigest(groupProjectId, getLastRead(groupProjectId));
        if (!cancelled) {
          // The channel the user has open counts as read, including messages
          // that arrive while they are sitting on it.
          const open = openChannel(digest, selectedTopic);
          setTopics(clearUnread(digest, open));
          if (open) markTopicRead(groupProjectId, open.topic, open.latestTimestamp);
        }
      } catch { /* ignore */ }

      // Message fetches stay unfiltered — `since` drives unread counts only,
      // the panes still show the full history of the selected channel.
      if (selectedTopic === ALL_TOPICS_KEY) {
        try {
          const allMsgs = await fetchAllMessages(groupProjectId);
          if (!cancelled) setMessages(allMsgs);
        } catch { /* ignore */ }
      } else if (selectedTopic) {
        try {
          const msgs = await fetchTopicMessages(groupProjectId, selectedTopic);
          if (!cancelled) setMessages(msgs);
        } catch { /* ignore */ }
      }
    };

    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [groupProjectId, selectedTopic, fetchDigest, fetchAllMessages, fetchTopicMessages, getLastRead, markTopicRead]);

  // Sort messages newest-first by the numeric timestamp embedded in the message ID
  // (msg_<epoch_ms>_<random>) to match the backend's numeric sort order and avoid
  // localeCompare producing wrong results for same-millisecond messages.
  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => {
      const tsA = parseInt(a.id.split('_')[1] || '0', 10);
      const tsB = parseInt(b.id.split('_')[1] || '0', 10);
      return tsB - tsA;
    }),
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
    // Clear the badge immediately rather than waiting for the next poll.
    const open = openChannel(topics, topic);
    if (open) {
      markTopicRead(groupProjectId, open.topic, open.latestTimestamp);
      setTopics((prev) => clearUnread(prev, open));
    }
  }, [topics, groupProjectId, markTopicRead]);

  const handleTogglePolling = useCallback(async () => {
    const newVal = !pollingEnabled;
    // Delegate persist + member start/stop side-effect to the shared main-process
    // code path (setProjectPolling), the same one the toggle_polling MCP command
    // uses, so the setting and the injected instructions can't diverge.
    await setPolling(groupProjectId, newVal);
    onUpdateMetadata({ pollingEnabled: newVal });
  }, [pollingEnabled, setPolling, groupProjectId, onUpdateMetadata]);

  const handleNudgePolling = useCallback(() => {
    const name = project?.name || groupProjectId;
    const agents = useAgentStore.getState().agents;
    for (const member of members) {
      const orchestrator = agents[member.agentId]?.orchestrator;
      void injectMessage(member.agentId, pollingNudgeMsg(name, orchestrator));
    }
  }, [members, project, groupProjectId, injectMessage]);

  const handleDeleteMessage = useCallback(async (topic: string, messageId: string) => {
    const { promise } = showConfirmDialog('Delete this message?');
    if (!(await promise)) return;
    await deleteMessage(groupProjectId, topic, messageId);
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    if (selectedMessageId === messageId) setSelectedMessageId(null);
  }, [groupProjectId, deleteMessage, selectedMessageId]);

  const handleDeleteTopic = useCallback(async (topic: string) => {
    await deleteTopic(groupProjectId, topic);
    setTopics((prev) => prev.filter((t) => t.topic !== topic));
    if (selectedTopic === topic) {
      setSelectedTopic(ALL_TOPICS_KEY);
      setSelectedMessageId(null);
      setMessages([]);
    }
    setConfirmDeleteTopic(null);
  }, [groupProjectId, deleteTopic, selectedTopic]);

  const handleToggleProtection = useCallback(async (topic: string, currentlyProtected: boolean) => {
    await setTopicProtection(groupProjectId, topic, !currentlyProtected);
    setTopics((prev) => prev.map((t) => t.topic === topic ? { ...t, isProtected: !currentlyProtected } : t));
  }, [groupProjectId, setTopicProtection]);

  const handleClearAll = useCallback(async () => {
    await clearAllMessages(groupProjectId);
    setTopics([]);
    setMessages([]);
    setSelectedTopic(ALL_TOPICS_KEY);
    setSelectedMessageId(null);
    setConfirmClearAll(false);
  }, [groupProjectId, clearAllMessages]);

  const handlePostBulletin = useCallback(async () => {
    const topic = bulletinTopic.trim();
    const body = bulletinBody.trim();
    if (!topic || !body || postingBulletin) return;
    setPostingBulletin(true);
    try {
      await postBulletinMessage(groupProjectId, topic, body);
      setBulletinTopic('');
      setBulletinBody('');
    } finally {
      setPostingBulletin(false);
    }
  }, [bulletinTopic, bulletinBody, postingBulletin, postBulletinMessage, groupProjectId]);

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
        onNudgePolling={handleNudgePolling}
        onToggleRetention={() => setShowRetentionSettings((v) => !v)}
        showRetentionSettings={showRetentionSettings}
      />

      {showDefaultPermissionsDialog && (
        <WireToolPermissionsDialog
          binding={{
            agentId: 'group-project-defaults',
            targetId: groupProjectId,
            targetKind: 'group-project',
            label: `${displayName} defaults`,
            disabledTools: defaultDisabledTools,
          }}
          onSave={setDefaultDisabledTools}
          onClose={() => setShowDefaultPermissionsDialog(false)}
        />
      )}

      {/* Retention Settings (collapsible) */}
      {showRetentionSettings && (
        <RetentionSettings groupProjectId={groupProjectId} />
      )}

      <div className="flex items-end gap-2 px-3 py-2 border-t border-surface-1 bg-ctp-mantle/50">
        <input
          value={bulletinTopic}
          onChange={(e) => setBulletinTopic(e.target.value)}
          placeholder="Topic"
          aria-label="Bulletin topic"
          className="w-28 px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus-ring"
        />
        <textarea
          value={bulletinBody}
          onChange={(e) => setBulletinBody(e.target.value)}
          placeholder="Post a bulletin message..."
          aria-label="Bulletin message"
          rows={2}
          className="flex-1 px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus-ring resize-none"
        />
        <button
          onClick={() => void handlePostBulletin()}
          disabled={!bulletinTopic.trim() || !bulletinBody.trim() || postingBulletin}
          className="px-2 py-1.5 text-xs font-medium bg-ctp-accent text-white rounded hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          {postingBulletin ? 'Posting...' : 'Post'}
        </button>
      </div>

      {/* Inline Description & Instructions Editor */}
      <div className="flex gap-3 px-3 py-2 border-t border-surface-1 bg-ctp-mantle/50">
        <div className="flex-1 min-w-0">
          <label className="block text-xs font-semibold uppercase tracking-wider text-ctp-subtext0 mb-1">Description</label>
          <textarea
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            placeholder="Purpose of this group project..."
            rows={5}
            className="w-full px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus-ring resize-none"
          />
        </div>
        <div className="flex-1 min-w-0">
          <label className="block text-xs font-semibold uppercase tracking-wider text-ctp-subtext0 mb-1">Instructions</label>
          <textarea
            value={editInstr}
            onChange={(e) => setEditInstr(e.target.value)}
            placeholder="Rules agents must follow..."
            rows={5}
            className="w-full px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus-ring resize-none"
          />
        </div>
        <div className="flex flex-col justify-between flex-shrink-0 gap-1.5 w-44">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-ctp-subtext0 mb-0.5">Default permissions</div>
            <div className="text-xs text-ctp-subtext0 leading-snug">
              {GROUP_PROJECT_CORE_TOOL_SUFFIXES.length} message tools on.
              {' '}
              {enabledPrivilegedDefaults === 0
                ? 'Privileged actions off.'
                : `${enabledPrivilegedDefaults} privileged action${enabledPrivilegedDefaults === 1 ? '' : 's'} on.`}
            </div>
            <button
              onClick={() => setShowDefaultPermissionsDialog(true)}
              className="mt-1 px-2 py-1 text-xs font-medium rounded bg-surface-0 text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors"
              data-testid="group-project-default-permissions-button"
            >
              Set defaults
            </button>
          </div>
          {/* Wave 10 #7+#8: single Save (scope chosen inside the confirm
              dialog) + Clear All on its own row so neither gets clipped at
              the column's fixed width. */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => handleSaveDescInstr()}
                disabled={!hasUnsavedChanges || saving}
                className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-all ${
                  hasUnsavedChanges
                    ? 'bg-ctp-accent text-white shadow-md hover:opacity-90'
                    : 'bg-surface-0 text-ctp-overlay0 cursor-default'
                }`}
                data-testid="group-project-save-defaults-button"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <span className="text-xs text-ctp-overlay0 whitespace-nowrap" title={`${disabledDefaultCount} tools disabled by default`}>
                {disabledDefaultCount} off
              </span>
            </div>
            {confirmClearAll ? (
              <button
                onClick={handleClearAll}
                className="w-full px-2 py-1.5 text-xs font-medium bg-ctp-red text-white rounded hover:opacity-90 transition-opacity"
                data-testid="group-project-confirm-clear-all"
              >
                Confirm Clear
              </button>
            ) : (
              <button
                onClick={() => setConfirmClearAll(true)}
                className="w-full px-2 py-1.5 text-xs font-medium text-ctp-red bg-ctp-red/10 rounded hover:bg-ctp-red/20 transition-colors"
                title="Clear all messages (keeps description, instructions, and wires)"
                data-testid="group-project-clear-all"
              >
                Clear All
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 3-Pane Content */}
      <div className="flex flex-1 min-h-0 border-t border-surface-1">
        {/* Topic Sidebar */}
        <GroupProjectPanelSidebar
          width={topicsWidth}
          collapsed={topicsCollapsed}
          onResize={resizeTopics}
          onToggleCollapse={toggleTopicsCollapse}
        >
          <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider bg-ctp-accent/10 text-ctp-accent sticky top-0 z-10">
            Topics
          </div>
          {/* All virtual topic */}
          <button
            onClick={() => handleTopicClick(ALL_TOPICS_KEY)}
            className={`w-full text-left px-3 py-2 text-xs border-b border-surface-0 hover:bg-surface-0 transition-colors ${
              selectedTopic === ALL_TOPICS_KEY
                ? 'bg-surface-0 text-ctp-accent border-l-2 border-l-ctp-accent'
                : 'text-ctp-subtext1'
            }`}
          >
            <div className="font-medium">All</div>
            <div className="text-xs text-ctp-overlay0 mt-0.5">
              {topics.reduce((sum, t) => sum + t.messageCount, 0)} msgs
            </div>
          </button>
          {topics.map((t) => (
            <div
              key={t.topic}
              className={`group relative text-xs border-b border-surface-0 hover:bg-surface-0 transition-colors ${
                selectedTopic === t.topic
                  ? 'bg-surface-0 text-ctp-accent border-l-2 border-l-ctp-accent'
                  : 'text-ctp-subtext1'
              }`}
            >
              <button
                onClick={() => handleTopicClick(t.topic)}
                className="w-full text-left px-3 py-2"
              >
                <div className="font-medium truncate flex items-center gap-1">
                  {t.isProtected && <ShieldIcon size={10} />}
                  {t.topic}
                </div>
                <div className="text-xs text-ctp-overlay0 mt-0.5">
                  {t.messageCount} msg{t.messageCount !== 1 ? 's' : ''}
                  {t.newMessageCount > 0 && (
                    <span className="ml-1 text-ctp-green">+{t.newMessageCount}</span>
                  )}
                </div>
              </button>
              {/* Topic actions (show on hover) */}
              <div className="absolute top-1 right-1 hidden group-hover:flex items-center gap-0.5">
                <button
                  onClick={(e) => { e.stopPropagation(); void handleToggleProtection(t.topic, !!t.isProtected); }}
                  className={`p-0.5 rounded transition-colors ${t.isProtected ? 'text-ctp-yellow' : 'text-ctp-overlay0 hover:text-ctp-yellow'}`}
                  title={t.isProtected ? 'Remove protection' : 'Protect topic (never prune)'}
                >
                  <ShieldIcon size={10} />
                </button>
                {confirmDeleteTopic === t.topic ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); void handleDeleteTopic(t.topic); }}
                    className="px-1 py-0.5 text-[9px] bg-ctp-red text-white rounded"
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteTopic(t.topic); }}
                    className="p-0.5 text-ctp-overlay0 hover:text-ctp-red rounded transition-colors"
                    title="Delete topic"
                  >
                    <TrashIcon size={10} />
                  </button>
                )}
              </div>
            </div>
          ))}
          {topics.length === 0 && (
            <div className="p-3 text-xs text-ctp-overlay0 italic">No topics yet</div>
          )}
        </GroupProjectPanelSidebar>

        {/* Message List (compact preview pane) */}
        <GroupProjectPanelSidebar
          width={messagesWidth}
          collapsed={messagesCollapsed}
          onResize={resizeMessages}
          onToggleCollapse={toggleMessagesCollapse}
        >
          {sortedMessages.length === 0 ? (
            <div className="p-3 text-xs text-ctp-overlay0 italic">
              {selectedTopic === ALL_TOPICS_KEY ? 'No messages yet' : `No messages in "${selectedTopic}"`}
            </div>
          ) : (
            sortedMessages.map((m) => (
              <div
                key={m.id}
                className={`group relative border-b border-surface-0 hover:bg-surface-0 transition-colors ${
                  selectedMessageId === m.id ? 'bg-surface-0' : ''
                }`}
              >
                <button
                  onClick={() => setSelectedMessageId(m.id)}
                  className="w-full text-left px-3 py-2"
                >
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="bg-ctp-accent/15 text-ctp-accent rounded px-1 py-0.5 text-xs font-medium truncate max-w-[80px]">
                      {senderShort(m.sender)}
                    </span>
                    <span className="ml-auto text-xs text-ctp-overlay0 flex-shrink-0">
                      {formatTime(m.timestamp)}
                    </span>
                  </div>
                  <div
                    className="text-xs text-ctp-subtext0 truncate mt-0.5 prose prose-xs prose-invert max-w-none [&>*]:inline [&>*]:m-0"
                    dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(m.body.slice(0, 80)) }}
                  />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); void handleDeleteMessage(m.topic, m.id); }}
                  className="absolute top-1 right-1 hidden group-hover:block p-0.5 text-ctp-overlay0 hover:text-ctp-red rounded transition-colors"
                  title="Delete message"
                >
                  <TrashIcon size={10} />
                </button>
              </div>
            ))
          )}
        </GroupProjectPanelSidebar>

        {/* Message Detail (main content area) */}
        <div
          className="flex-1 min-w-0 overflow-y-auto p-3"
          onWheel={stopPlainWheelPropagation}
          data-testid="group-project-message-detail-scroll"
        >
          {selectedMessage ? (
            <div className="text-xs space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="bg-ctp-accent/15 text-ctp-accent rounded px-1.5 py-0.5 text-xs font-medium">
                  {selectedMessage.sender}
                </span>
                <span className="text-ctp-overlay0">
                  {formatTime(selectedMessage.timestamp)}
                </span>
                {selectedTopic === ALL_TOPICS_KEY && (
                  <span className="text-ctp-overlay0">
                    in <span className="text-ctp-subtext1">{selectedMessage.topic}</span>
                  </span>
                )}
                <button
                  onClick={() => void handleDeleteMessage(selectedMessage.topic, selectedMessage.id)}
                  className="ml-auto p-1 text-ctp-overlay0 hover:text-ctp-red rounded transition-colors"
                  title="Delete message"
                >
                  <TrashIcon size={12} />
                </button>
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
        <span className="text-xs text-ctp-subtext0">
          {members.length} agent{members.length !== 1 ? 's' : ''} connected
        </span>
      </div>

      {/* Shoulder Tap Modal */}
      {showTapModal && (
        <ShoulderTapModal
          members={members}
          projectInstructions={project?.instructions || ''}
          onClose={() => setShowTapModal(false)}
          injectMessage={injectMessage}
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
  onNudgePolling,
  onToggleRetention,
  showRetentionSettings,
}: {
  displayName: string;
  groupProjectId: string;
  update: (id: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }) => Promise<void>;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
  onShowTapModal: () => void;
  pollingEnabled: boolean;
  onTogglePolling: () => void;
  onNudgePolling: () => void;
  onToggleRetention: () => void;
  showRetentionSettings: boolean;
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
    <div className="flex items-center gap-2 px-3 py-2 bg-ctp-mantle border-b-2 border-ctp-accent/30">
      {editing ? (
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSaveEdit}
          className="px-2 py-0.5 text-sm font-semibold bg-surface-0 border border-surface-2 rounded text-ctp-text focus-ring"
          autoFocus
        />
      ) : (
        <button
          onClick={handleStartEdit}
          className="text-sm font-semibold text-ctp-text hover:text-ctp-accent transition-colors truncate"
          title="Click to rename"
        >
          {displayName}
        </button>
      )}
      <div className="flex-1" />
      {/* Retention settings */}
      <button
        onClick={onToggleRetention}
        className={`p-1 transition-colors flex-shrink-0 ${showRetentionSettings ? 'text-ctp-accent' : 'text-ctp-overlay1 hover:text-ctp-accent'}`}
        title="Retention settings"
      >
        <GearIcon size={14} />
      </button>
      {/* Megaphone broadcast */}
      <button
        onClick={onShowTapModal}
        className="p-1 text-ctp-overlay1 hover:text-ctp-accent transition-colors flex-shrink-0"
        title="Broadcast message"
      >
        <MegaphoneIcon size={14} />
      </button>
      {/* Polling nudge */}
      <button
        onClick={onNudgePolling}
        className="p-1 text-ctp-overlay1 hover:text-ctp-yellow transition-colors flex-shrink-0"
        title="Nudge all agents to start polling if not already"
      >
        <NudgeIcon size={14} />
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
        <span className="text-xs font-medium">{pollingEnabled ? 'Poll: On' : 'Poll: Off'}</span>
      </button>
    </div>
  );
}

/* ---------- Shoulder Tap Modal ---------- */

function ShoulderTapModal({
  members,
  projectInstructions,
  onClose,
  injectMessage,
}: {
  members: GroupProjectMember[];
  projectInstructions: string;
  onClose: () => void;
  injectMessage: (agentId: string, message: string) => Promise<void>;
}) {
  const [target, setTarget] = useState<string>('all');
  const [message, setMessage] = useState('');
  const [includeInstructions, setIncludeInstructions] = useState(false);
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    const msg = message.trim();
    if (!msg && !includeInstructions) return;
    if (sending) return;
    setSending(true);

    try {
      const parts: string[] = [];
      if (includeInstructions && projectInstructions.trim()) {
        parts.push(`Project Instructions:\n${projectInstructions.trim()}`);
      }
      if (msg) parts.push(msg);
      const fullMessage = parts.join('\n\n');

      const targets = target === 'all'
        ? members
        : members.filter((m) => m.agentId === target);

      await Promise.all(targets.map((member) => injectMessage(member.agentId, fullMessage)));

      onClose();
    } catch (err) {
      console.error('Broadcast message failed:', err);
    } finally {
      setSending(false);
    }
  }, [message, includeInstructions, projectInstructions, sending, target, members, onClose, injectMessage]);

  return (
    <div
      // eslint-disable-next-line no-restricted-syntax
      className="absolute inset-0 bg-ctp-crust/80 flex items-center justify-center z-modal"
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
            className="w-full px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text focus-ring"
          >
            <option value="all">Broadcast to all</option>
            {members.map((m) => (
              <option key={m.agentId} value={m.agentId}>
                {m.agentName || m.agentId}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includeInstructions}
            onChange={(e) => setIncludeInstructions(e.target.checked)}
            className="accent-ctp-accent"
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
            className="w-full px-2 py-1.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text placeholder:text-ctp-overlay0 focus-ring resize-none"
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
            className="px-3 py-1.5 text-xs font-medium bg-ctp-accent text-white rounded hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Retention Settings ---------- */

function RetentionSettings({ groupProjectId }: { groupProjectId: string }) {
  const [maxPerTopic, setMaxPerTopic] = useState(100);
  const [maxTotal, setMaxTotal] = useState(500);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [trimEstimate, setTrimEstimate] = useState<number | null>(null);
  const [confirmTrim, setConfirmTrim] = useState(false);

  useEffect(() => {
    window.clubhouse.groupProject.getRetentionConfig(groupProjectId).then((config) => {
      setMaxPerTopic(config.maxPerTopic);
      setMaxTotal(config.maxTotal);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [groupProjectId]);

  // Estimate trim impact when values change
  useEffect(() => {
    if (!loaded) return;
    window.clubhouse.groupProject.estimateTrim(groupProjectId, maxPerTopic, maxTotal)
      .then(({ wouldRemove }) => setTrimEstimate(wouldRemove))
      .catch(() => setTrimEstimate(null));
  }, [loaded, groupProjectId, maxPerTopic, maxTotal]);

  const handleSave = useCallback(async () => {
    // If trim estimate shows messages will be removed, require confirmation
    if (trimEstimate && trimEstimate > 0 && !confirmTrim) {
      setConfirmTrim(true);
      return;
    }
    setSaving(true);
    try {
      await window.clubhouse.groupProject.saveRetentionConfig(groupProjectId, maxPerTopic, maxTotal);
      setConfirmTrim(false);
    } finally {
      setSaving(false);
    }
  }, [groupProjectId, maxPerTopic, maxTotal, trimEstimate, confirmTrim]);

  if (!loaded) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-t border-surface-1 bg-ctp-mantle/30">
      <span className="text-xs font-semibold uppercase tracking-wider text-ctp-subtext0">Retention</span>
      <label className="flex items-center gap-1.5 text-xs text-ctp-subtext1">
        Per topic:
        <input
          type="number"
          min={1}
          value={maxPerTopic}
          onChange={(e) => { setMaxPerTopic(Math.max(1, parseInt(e.target.value) || 1)); setConfirmTrim(false); }}
          className="w-20 px-1.5 py-0.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text focus-ring"
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-ctp-subtext1">
        Total:
        <input
          type="number"
          min={1}
          value={maxTotal}
          onChange={(e) => { setMaxTotal(Math.max(1, parseInt(e.target.value) || 1)); setConfirmTrim(false); }}
          className="w-20 px-1.5 py-0.5 text-xs bg-surface-0 border border-surface-2 rounded text-ctp-text focus-ring"
        />
      </label>
      {trimEstimate != null && trimEstimate > 0 && (
        <span className="text-xs text-ctp-red font-medium">
          {trimEstimate} msg{trimEstimate !== 1 ? 's' : ''} will be removed
        </span>
      )}
      {confirmTrim ? (
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-2 py-0.5 text-xs font-medium bg-ctp-red text-white rounded hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          {saving ? 'Trimming...' : 'Confirm Trim'}
        </button>
      ) : (
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-2 py-0.5 text-xs font-medium bg-ctp-accent text-white rounded hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      )}
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

function NudgeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <line x1="12" y1="2" x2="12" y2="4" />
    </svg>
  );
}

function ShieldIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function StarIcon({ size = 14, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function GearIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
