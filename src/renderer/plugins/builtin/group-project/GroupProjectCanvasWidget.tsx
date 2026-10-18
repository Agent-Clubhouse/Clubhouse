import React, { useState, useCallback, useMemo, useEffect, useRef, useId } from 'react';
import { GroupProjectPanelSidebar, useGroupProjectPanelLayout } from './GroupProjectPanelSidebar';
import { useWheelContainment } from '../../../hooks/useWheelContainment';
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
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { Toggle } from '../../../components/Toggle';
import { Tooltip } from '../../../components/Tooltip';
import { AgentAvatar } from '../../../features/agents/AgentAvatar';
import { DOT_LABEL, StatusDot, agentDot } from '../../../features/agents/agent-status';
import { useAgentStatus } from '../../../features/agents/agent-status-store';
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
          <div className="text-[13px] font-medium text-ctp-text">MCP required</div>
          <div className="text-xs text-ctp-overlay1 max-w-[220px]">
            Group projects need MCP. Turn it on in Settings, under MCP.
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
    return <div className="flex items-center justify-center h-full text-xs text-ctp-overlay1 p-4">No group project selected</div>;
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
    <div className="flex flex-col justify-center h-full gap-2 p-4">
      <div className="text-[13px] font-medium text-ctp-text">New group project</div>
      <input
        type="text"
        value={name}
        onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
        onKeyDown={handleKeyDown}
        placeholder="Project name"
        aria-label="Project name"
        className="w-full h-7 px-2 text-xs bg-ctp-base border border-surface-1 rounded-md text-ctp-text placeholder:text-ctp-overlay1 focus-ring"
        autoFocus
      />
      <Button kind="primary" onClick={handleCreate} disabled={!name.trim() || creating} className="self-start">
        {creating ? 'Creating…' : 'Create'}
      </Button>
      {error && (
        <div role="alert" className="text-xs text-ctp-error">
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

  const activity = [
    `${topics.length} ${topics.length === 1 ? 'topic' : 'topics'}`,
    `${totalMessages} ${totalMessages === 1 ? 'message' : 'messages'}`,
    ...(totalNew > 0 ? [`${totalNew} new`] : []),
  ].join(' · ');

  return (
    <div className="flex flex-col h-full min-h-0 py-1.5">
      {/* Status and actions */}
      <div className="h-[30px] flex items-center gap-1 pl-3 pr-1.5 flex-shrink-0">
        <span className="text-[13px] text-ctp-text truncate" data-testid="group-project-member-count">
          {members.length} {members.length === 1 ? 'agent' : 'agents'}
        </span>
        <span className="flex-1" />
        <IconButton label="Broadcast message" onClick={() => setShowTapModal(true)}><MegaphoneIcon /></IconButton>
        <IconButton label="Ask agents to start polling" onClick={handleNudgePolling}><NudgeIcon /></IconButton>
        <PollingSwitch on={pollingEnabled} onToggle={handleTogglePolling} />
      </div>

      <div className="px-3 text-xs text-ctp-overlay1 flex-shrink-0" data-testid="group-project-activity">{activity}</div>

      {description && (
        <Tooltip content={description} onlyWhenTruncated>
          <div className="px-3 pt-1 text-xs text-ctp-subtext0 truncate flex-shrink-0">{description}</div>
        </Tooltip>
      )}

      {/* Members: the star makes an agent a project lead (admin), which gets the privileged tools. */}
      {members.length > 0 && (
        <ul className="mt-1.5 px-1.5 flex-1 min-h-0 overflow-y-auto" aria-label="Members">
          {members.map((m) => (
            <MemberRow
              key={m.agentId}
              member={m}
              lead={admins.includes(m.agentId)}
              onToggleLead={() => void handleToggleAdmin(m.agentId)}
            />
          ))}
        </ul>
      )}

      <BroadcastModal
        open={showTapModal}
        members={members}
        projectInstructions={project?.instructions || ''}
        onClose={() => setShowTapModal(false)}
        injectMessage={injectMessage}
      />
    </div>
  );
}

/* ---------- Shared pieces ---------- */

/**
 * A 28px icon button with a tooltip and an accessible name. A toggle passes
 * `pressed` and keeps one fixed `label`; the pressed state says whether it's on.
 */
function IconButton({ label, tooltip, onClick, pressed, testId, children }: {
  label: string;
  /** Tooltip text when it should say more than the label. */
  tooltip?: string;
  onClick: (e: React.MouseEvent) => void;
  pressed?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={tooltip ?? label}>
      <Button
        kind="quiet"
        icon={children}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        data-testid={testId}
        className={pressed ? 'bg-surface-0 text-ctp-text' : ''}
      />
    </Tooltip>
  );
}

export const POLLING_HINT = 'When on, member agents check the board for new messages on their own. When off, they only act when someone messages them.';

/** Polling on or off. The word is the switch's label, so clicking it toggles too. */
function PollingSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const switchId = useId();
  return (
    <span className="flex items-center gap-2 pl-1.5 pr-1.5 h-7 flex-shrink-0" data-testid="group-project-polling">
      <Tooltip content={POLLING_HINT}>
        <label htmlFor={switchId} className="text-xs text-ctp-subtext1 cursor-pointer">Polling</label>
      </Tooltip>
      <Toggle id={switchId} checked={on} onChange={onToggle} />
    </span>
  );
}

/** One member: 18px avatar, name, "Lead" for a project lead, and the agent's status as a dot and a word. */
function MemberRow({ member, lead, onToggleLead }: { member: GroupProjectMember; lead: boolean; onToggleLead: () => void }) {
  const agent = useAgentStore((s) => s.agents[member.agentId]);
  const detailed = useAgentStatus(agent ?? { id: member.agentId, status: 'sleeping' });
  const dot = agent ? agentDot(agent, detailed) : null;
  const name = member.agentName || member.agentId;
  return (
    <li className="group/member h-[30px] flex items-center gap-2 pl-1.5 rounded-md hover:bg-surface-0" data-testid="group-project-member">
      {agent ? <AgentAvatar agent={agent} size="2xs" /> : <span className="w-[18px] flex-shrink-0" aria-hidden="true" />}
      <span className="text-[13px] text-ctp-text truncate min-w-0">{name}</span>
      {lead && <span className="text-xs text-ctp-overlay1 flex-shrink-0">Lead</span>}
      <span className="flex-1" />
      {dot && (
        <span className="flex items-center gap-1.5 text-xs text-ctp-overlay1 flex-shrink-0">
          {/* The word says the status; the dot is decoration, so it isn't read out twice. */}
          <span aria-hidden="true" className="flex"><StatusDot dot={dot} /></span>
          {DOT_LABEL[dot]}
        </span>
      )}
      <IconButton
        label="Project lead"
        tooltip="Project lead: gets the privileged group project tools"
        pressed={lead}
        onClick={(e) => { e.stopPropagation(); onToggleLead(); }}
      >
        <StarIcon filled={lead} />
      </IconButton>
    </li>
  );
}

/** A label above a field, in sentence case. */
function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="block text-xs text-ctp-overlay1 mb-1">{children}</label>;
}

const FIELD = 'w-full px-2 text-xs bg-ctp-base border border-surface-1 rounded-md text-ctp-text placeholder:text-ctp-overlay1 focus-ring';

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

  const handleWheelContainment = useWheelContainment();

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
    const { promise } = showConfirmDialog(`Delete the "${topic}" topic and its messages?`);
    if (!(await promise)) return;
    await deleteTopic(groupProjectId, topic);
    setTopics((prev) => prev.filter((t) => t.topic !== topic));
    if (selectedTopic === topic) {
      setSelectedTopic(ALL_TOPICS_KEY);
      setSelectedMessageId(null);
      setMessages([]);
    }
  }, [groupProjectId, deleteTopic, selectedTopic]);

  const handleToggleProtection = useCallback(async (topic: string, currentlyProtected: boolean) => {
    await setTopicProtection(groupProjectId, topic, !currentlyProtected);
    setTopics((prev) => prev.map((t) => t.topic === topic ? { ...t, isProtected: !currentlyProtected } : t));
  }, [groupProjectId, setTopicProtection]);

  const handleClearAll = useCallback(async () => {
    const { promise } = showConfirmDialog('Clear every message? The description, instructions and wires stay.');
    if (!(await promise)) return;
    await clearAllMessages(groupProjectId);
    setTopics([]);
    setMessages([]);
    setSelectedTopic(ALL_TOPICS_KEY);
    setSelectedMessageId(null);
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

  const totalMessages = topics.reduce((sum, t) => sum + t.messageCount, 0);

  return (
    <div className="flex flex-col h-full text-ctp-text">
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

      {showRetentionSettings && <RetentionSettings groupProjectId={groupProjectId} />}

      {/* Post to the board */}
      <div className="flex items-start gap-2 px-3 py-2 border-b border-surface-0">
        <input
          value={bulletinTopic}
          onChange={(e) => setBulletinTopic(e.target.value)}
          placeholder="Topic"
          aria-label="Bulletin topic"
          className={`${FIELD} h-7 w-28 flex-shrink-0`}
        />
        <textarea
          value={bulletinBody}
          onChange={(e) => setBulletinBody(e.target.value)}
          placeholder="Post a message to the board"
          aria-label="Bulletin message"
          rows={2}
          className={`${FIELD} py-1.5 flex-1 resize-none`}
        />
        <Button
          kind="primary"
          onClick={() => void handlePostBulletin()}
          disabled={!bulletinTopic.trim() || !bulletinBody.trim() || postingBulletin}
        >
          {postingBulletin ? 'Posting…' : 'Post'}
        </Button>
      </div>

      {/* Description, instructions and connection defaults */}
      <div className="flex gap-3 px-3 py-2 border-b border-surface-0">
        <div className="flex-1 min-w-0">
          <FieldLabel htmlFor={`${groupProjectId}-description`}>Description</FieldLabel>
          <textarea
            id={`${groupProjectId}-description`}
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            placeholder="What this group project is for"
            rows={5}
            className={`${FIELD} py-1.5 resize-none`}
          />
        </div>
        <div className="flex-1 min-w-0">
          <FieldLabel htmlFor={`${groupProjectId}-instructions`}>Instructions</FieldLabel>
          <textarea
            id={`${groupProjectId}-instructions`}
            value={editInstr}
            onChange={(e) => setEditInstr(e.target.value)}
            placeholder="Rules every agent here follows"
            rows={5}
            className={`${FIELD} py-1.5 resize-none`}
          />
        </div>
        <div className="flex flex-col justify-between flex-shrink-0 gap-2 w-44">
          <div>
            <div className="text-xs text-ctp-overlay1 mb-1">Default permissions</div>
            <div className="text-xs text-ctp-subtext0 leading-snug">
              {GROUP_PROJECT_CORE_TOOL_SUFFIXES.length} message tools on.
              {' '}
              {enabledPrivilegedDefaults === 0
                ? 'Privileged actions off.'
                : `${enabledPrivilegedDefaults} privileged action${enabledPrivilegedDefaults === 1 ? '' : 's'} on.`}
              {' '}
              {disabledDefaultCount} {disabledDefaultCount === 1 ? 'tool' : 'tools'} off.
            </div>
            <Button
              kind="ghost"
              className="mt-1.5"
              onClick={() => setShowDefaultPermissionsDialog(true)}
              data-testid="group-project-default-permissions-button"
            >
              Set defaults
            </Button>
          </div>
          {/* One Save (the scope is chosen in its confirm dialog), and Clear all on its own row. */}
          <div className="flex flex-col gap-1.5">
            <Button
              kind={hasUnsavedChanges ? 'primary' : 'ghost'}
              onClick={() => handleSaveDescInstr()}
              disabled={!hasUnsavedChanges || saving}
              data-testid="group-project-save-defaults-button"
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button kind="danger" onClick={() => void handleClearAll()} data-testid="group-project-clear-all">
              Clear all messages
            </Button>
          </div>
        </div>
      </div>

      {/* Topics, messages and the open message */}
      <div className="flex flex-1 min-h-0">
        <GroupProjectPanelSidebar
          width={topicsWidth}
          collapsed={topicsCollapsed}
          onResize={resizeTopics}
          onToggleCollapse={toggleTopicsCollapse}
        >
          <div className="h-[30px] flex items-center px-3 text-xs text-ctp-overlay1 sticky top-0 z-10 bg-ctp-mantle">Topics</div>
          <ul className="px-1.5 pb-1.5">
            <li>
              <button
                onClick={() => handleTopicClick(ALL_TOPICS_KEY)}
                aria-current={selectedTopic === ALL_TOPICS_KEY || undefined}
                className={`w-full h-[30px] flex items-center gap-2 px-1.5 rounded-md text-left hover:bg-surface-0 ${selectedTopic === ALL_TOPICS_KEY ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1'}`}
              >
                <span className="text-[13px] flex-1 truncate">All</span>
                <span className="text-xs text-ctp-overlay1">{totalMessages}</span>
              </button>
            </li>
            {topics.map((t) => (
              <TopicRow
                key={t.topic}
                topic={t}
                selected={selectedTopic === t.topic}
                onSelect={() => handleTopicClick(t.topic)}
                onToggleProtection={() => void handleToggleProtection(t.topic, !!t.isProtected)}
                onDelete={() => void handleDeleteTopic(t.topic)}
              />
            ))}
          </ul>
          {topics.length === 0 && <div className="px-3 py-1.5 text-xs text-ctp-overlay1">No topics yet</div>}
        </GroupProjectPanelSidebar>

        <GroupProjectPanelSidebar
          width={messagesWidth}
          collapsed={messagesCollapsed}
          onResize={resizeMessages}
          onToggleCollapse={toggleMessagesCollapse}
        >
          {sortedMessages.length === 0 ? (
            <div className="px-3 py-2 text-xs text-ctp-overlay1">
              {selectedTopic === ALL_TOPICS_KEY ? 'No messages yet' : `No messages in ${selectedTopic}`}
            </div>
          ) : (
            <ul className="p-1.5">
              {sortedMessages.map((m) => (
                <li
                  key={m.id}
                  className={`group/msg relative rounded-md hover:bg-surface-0 ${selectedMessageId === m.id ? 'bg-surface-0' : ''}`}
                >
                  <button
                    onClick={() => setSelectedMessageId(m.id)}
                    aria-current={selectedMessageId === m.id || undefined}
                    className="w-full text-left px-1.5 py-1.5"
                  >
                    <div className="flex items-center gap-2 pr-7">
                      <span className="text-xs font-medium text-ctp-text truncate">{senderShort(m.sender)}</span>
                      <span className="ml-auto text-xs text-ctp-overlay1 flex-shrink-0">{formatTime(m.timestamp)}</span>
                    </div>
                    <div
                      className="text-xs text-ctp-overlay1 truncate mt-0.5 prose prose-xs prose-invert max-w-none [&>*]:inline [&>*]:m-0"
                      dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(m.body.slice(0, 80)) }}
                    />
                  </button>
                  <span className="absolute top-0.5 right-0.5 hidden group-hover/msg:block group-focus-within/msg:block">
                    <IconButton label="Delete message" onClick={(e) => { e.stopPropagation(); void handleDeleteMessage(m.topic, m.id); }}>
                      <TrashIcon />
                    </IconButton>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </GroupProjectPanelSidebar>

        <div
          className="flex-1 min-w-0 overflow-y-auto px-3 py-2"
          onWheel={handleWheelContainment}
          data-testid="group-project-message-detail-scroll"
        >
          {selectedMessage ? (
            <div>
              <div className="h-[30px] flex items-center gap-2 min-w-0">
                <span className="text-[13px] font-medium text-ctp-text truncate">{selectedMessage.sender}</span>
                <span className="text-xs text-ctp-overlay1 flex-shrink-0">{formatTime(selectedMessage.timestamp)}</span>
                {selectedTopic === ALL_TOPICS_KEY && (
                  <span className="text-xs text-ctp-overlay1 truncate">in {selectedMessage.topic}</span>
                )}
                <span className="ml-auto">
                  <IconButton label="Delete message" onClick={() => void handleDeleteMessage(selectedMessage.topic, selectedMessage.id)}>
                    <TrashIcon />
                  </IconButton>
                </span>
              </div>
              <div
                className="border-t border-surface-0 pt-2 mt-1 text-[13px] prose prose-sm prose-invert max-w-none break-words"
                dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(selectedMessage.body) }}
              />
            </div>
          ) : (
            <div className="text-xs text-ctp-overlay1">Select a message</div>
          )}
        </div>
      </div>

      <div className="h-[30px] flex items-center px-3 border-t border-surface-0 text-xs text-ctp-overlay1 flex-shrink-0">
        {members.length} {members.length === 1 ? 'agent' : 'agents'} connected
      </div>

      <BroadcastModal
        open={showTapModal}
        members={members}
        projectInstructions={project?.instructions || ''}
        onClose={() => setShowTapModal(false)}
        injectMessage={injectMessage}
      />
    </div>
  );
}

/** One topic: name (with a shield when protected) and its count, or how many are new. */
function TopicRow({ topic: t, selected, onSelect, onToggleProtection, onDelete }: {
  topic: TopicDigest;
  selected: boolean;
  onSelect: () => void;
  onToggleProtection: () => void;
  onDelete: () => void;
}) {
  return (
    <li className={`group/topic relative rounded-md hover:bg-surface-0 ${selected ? 'bg-surface-0' : ''}`}>
      <button
        onClick={onSelect}
        aria-current={selected || undefined}
        className={`w-full h-[30px] flex items-center gap-1.5 px-1.5 text-left ${selected ? 'text-ctp-text' : 'text-ctp-subtext1'}`}
      >
        {t.isProtected && <span className="text-ctp-overlay1 flex-shrink-0" aria-label="Protected"><ShieldIcon size={12} /></span>}
        <span className="text-[13px] flex-1 truncate">{t.topic}</span>
        {t.newMessageCount > 0 ? (
          <span className="text-xs font-medium text-ctp-text flex-shrink-0 group-hover/topic:hidden group-focus-within/topic:hidden" data-testid="group-project-topic-unread">
            {t.newMessageCount} new
          </span>
        ) : (
          <span className="text-xs text-ctp-overlay1 flex-shrink-0 group-hover/topic:hidden group-focus-within/topic:hidden">{t.messageCount}</span>
        )}
      </button>
      <span className="absolute inset-y-0 right-0.5 hidden group-hover/topic:flex group-focus-within/topic:flex items-center">
        <IconButton
          label="Protect topic"
          tooltip="Protect topic: retention never removes its messages"
          pressed={!!t.isProtected}
          onClick={(e) => { e.stopPropagation(); onToggleProtection(); }}
        >
          <ShieldIcon />
        </IconButton>
        <IconButton label="Delete topic" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          <TrashIcon />
        </IconButton>
      </span>
    </li>
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
    <div className="h-[30px] flex items-center gap-1 pl-3 pr-1.5 border-b border-surface-0 flex-shrink-0">
      {editing ? (
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSaveEdit}
          aria-label="Group project name"
          className={`${FIELD} h-6 text-[13px] max-w-[240px]`}
          autoFocus
        />
      ) : (
        <Tooltip content="Rename">
          <button
            onClick={handleStartEdit}
            className="h-6 px-1.5 -ml-1.5 rounded-md text-[13px] font-medium text-ctp-text hover:bg-surface-0 truncate min-w-0"
          >
            {displayName}
          </button>
        </Tooltip>
      )}
      <span className="flex-1" />
      <IconButton label="Retention settings" pressed={showRetentionSettings} onClick={onToggleRetention}><GearIcon /></IconButton>
      <IconButton label="Broadcast message" onClick={onShowTapModal}><MegaphoneIcon /></IconButton>
      <IconButton label="Ask agents to start polling" onClick={onNudgePolling}><NudgeIcon /></IconButton>
      <PollingSwitch on={pollingEnabled} onToggle={onTogglePolling} />
    </div>
  );
}

/* ---------- Broadcast dialog ---------- */

function BroadcastModal({
  open,
  members,
  projectInstructions,
  onClose,
  injectMessage,
}: {
  open: boolean;
  members: GroupProjectMember[];
  projectInstructions: string;
  onClose: () => void;
  injectMessage: (agentId: string, message: string) => Promise<void>;
}) {
  const [target, setTarget] = useState<string>('all');
  const [message, setMessage] = useState('');
  const [includeInstructions, setIncludeInstructions] = useState(false);
  const [sending, setSending] = useState(false);
  const targetId = useId();
  const messageId = useId();
  const instructionsLabelId = useId();
  const hasInstructions = !!projectInstructions.trim();

  // Start fresh each time it opens.
  useEffect(() => {
    if (!open) return;
    setTarget('all');
    setMessage('');
    setIncludeInstructions(false);
  }, [open]);

  const handleSend = useCallback(async () => {
    const msg = message.trim();
    if (!msg && !includeInstructions) return;
    if (sending) return;
    setSending(true);

    try {
      const parts: string[] = [];
      if (includeInstructions && hasInstructions) {
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
  }, [message, includeInstructions, hasInstructions, projectInstructions, sending, target, members, onClose, injectMessage]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Broadcast message"
      testId="group-project-broadcast"
      footer={(
        <>
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button kind="primary" onClick={() => void handleSend()} disabled={(!message.trim() && !includeInstructions) || sending}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <div>
          <FieldLabel htmlFor={targetId}>Send to</FieldLabel>
          <select id={targetId} value={target} onChange={(e) => setTarget(e.target.value)} className={`${FIELD} h-7`}>
            <option value="all">Every agent</option>
            {members.map((m) => (
              <option key={m.agentId} value={m.agentId}>{m.agentName || m.agentId}</option>
            ))}
          </select>
        </div>
        <div className="h-7 flex items-center justify-between gap-2">
          <span id={instructionsLabelId} className={`text-xs ${hasInstructions ? 'text-ctp-subtext1' : 'text-ctp-overlay1'}`}>
            Include project instructions
          </span>
          <Toggle
            checked={includeInstructions}
            onChange={() => setIncludeInstructions((v) => !v)}
            disabled={!hasInstructions}
            aria-labelledby={instructionsLabelId}
          />
        </div>
        <div>
          <FieldLabel htmlFor={messageId}>Message</FieldLabel>
          <textarea
            id={messageId}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What should they do?"
            rows={4}
            className={`${FIELD} py-1.5 resize-none`}
            autoFocus
          />
        </div>
      </div>
    </Modal>
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
    <div className="flex items-center gap-3 px-3 py-1.5 border-b border-surface-0 flex-wrap" data-testid="group-project-retention">
      <span className="text-xs text-ctp-overlay1">Keep</span>
      <label className="flex items-center gap-1.5 text-xs text-ctp-subtext1">
        <input
          type="number"
          min={1}
          value={maxPerTopic}
          onChange={(e) => { setMaxPerTopic(Math.max(1, parseInt(e.target.value) || 1)); setConfirmTrim(false); }}
          className={`${FIELD} h-7 w-20`}
        />
        per topic
      </label>
      <label className="flex items-center gap-1.5 text-xs text-ctp-subtext1">
        <input
          type="number"
          min={1}
          value={maxTotal}
          onChange={(e) => { setMaxTotal(Math.max(1, parseInt(e.target.value) || 1)); setConfirmTrim(false); }}
          className={`${FIELD} h-7 w-20`}
        />
        in total
      </label>
      {trimEstimate != null && trimEstimate > 0 && (
        <span className="text-xs text-ctp-error">
          {trimEstimate} {trimEstimate === 1 ? 'message' : 'messages'} will be removed
        </span>
      )}
      <span className="flex-1" />
      <Button kind={confirmTrim ? 'danger-solid' : 'primary'} onClick={() => void handleSave()} disabled={saving}>
        {saving ? (confirmTrim ? 'Trimming…' : 'Saving…') : confirmTrim ? 'Remove and save' : 'Save'}
      </Button>
    </div>
  );
}

/* ---------- Icons ---------- */

function MegaphoneIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11l18-5v12L3 13v-2z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
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
