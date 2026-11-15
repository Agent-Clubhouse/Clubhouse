import React, { useState, useCallback, useEffect, useRef, useId } from 'react';
import type { CanvasWidgetComponentProps, AnnexAPI } from '../../../../shared/plugin-types';
import type { TopicDigest } from '../../../../shared/group-project-types';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
import { useBulletinReadStore } from '../../../stores/bulletinReadStore';
import { useRemoteProject } from '../../../hooks/useRemoteProject';
import { useAgentStore } from '../../../stores/agentStore';
import { pollingNudgeMsg } from '../../../../shared/polling-messages';
import { useGroupProjectContext, type GroupProjectContextValue, type GroupProjectMember } from './useGroupProjectContext';
import { useUIStore } from '../../../stores/uiStore';
import { Button } from '../../../components/Button';
import { Tooltip } from '../../../components/Tooltip';
import { AgentAvatar } from '../../../features/agents/AgentAvatar';
import { DOT_LABEL, StatusDot, agentDot } from '../../../features/agents/agent-status';
import { useAgentStatus } from '../../../features/agents/agent-status-store';
import { GroupProjectBoard } from '../../../features/group-projects/board/GroupProjectBoard';
import { GroupProjectDefaultsPanel } from '../../../features/group-projects/board/GroupProjectDefaultsPanel';
import {
  BroadcastModal, IconButton, MegaphoneIcon, NudgeIcon, OpenIcon, PausedPolling, PollingSwitch, POLL_INTERVAL_MS,
  ProjectScopeLine, StarIcon,
} from '../../../features/group-projects/board/GroupProjectBoardParts';
import { currentViewSource, openGroupWorkspaceFrom } from '../../../features/group-projects/groupWorkspaceSource';

const EXPANDED_WIDTH_THRESHOLD = 500;

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

  const groupProjectId = metadata.groupProjectId as string | undefined;

  if (!groupProjectId && !isRemote) {
    if (!isAppMode && !projectId) {
      return <div role="alert" className="p-4 text-xs text-ctp-error">No current project is available. Open a registered project before creating a group project.</div>;
    }
    return <CreationForm projectId={projectId} onUpdateMetadata={onUpdateMetadata} />;
  }

  if (!groupProjectId) {
    return <div className="flex items-center justify-center h-full text-xs text-ctp-overlay1 p-4">No group project selected</div>;
  }

  return (
    <ProjectView
      groupProjectId={groupProjectId}
      projectId={projectId}
      onUpdateMetadata={onUpdateMetadata}
      referenceUnresolved={metadata.__groupProjectReferenceUnresolved === true}
      isRemote={isRemote}
      satelliteId={satelliteId}
      annex={api.annex}
    />
  );
}

/* ---------- Creation Form ---------- */



function CreationForm({
  projectId,
  onUpdateMetadata,
  referenceUnresolved = false,
}: {
  projectId?: string;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
  referenceUnresolved?: boolean;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useGroupProjectStore((s) => s.create);
  const loadProjects = useGroupProjectStore((s) => s.loadProjects);
  const loaded = useGroupProjectStore((s) => s.loaded);
  const projects = useGroupProjectStore((s) => s.projects);
  const loadError = useGroupProjectStore((s) => s.loadError);
  const [selectedId, setSelectedId] = useState('');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'app' | 'project'>('all');
  const selectId = useId();
  const scopeId = useId();
  const visibleProjects = projects.filter((project) => scopeFilter === 'all' || project.scope?.level === scopeFilter);

  useEffect(() => {
    if (!loaded) loadProjects();
  }, [loaded, loadProjects]);

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const project = await create(trimmed, projectId === undefined ? undefined : { projectId });
      onUpdateMetadata({ groupProjectId: project.id, name: project.name, ...(referenceUnresolved && { __groupProjectReferenceUnresolved: false }) });
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
  }, [name, creating, create, projectId, onUpdateMetadata, referenceUnresolved]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleCreate();
    },
    [handleCreate],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-4">
      <label htmlFor={selectId} className="text-[13px] font-medium text-ctp-text">Existing group project</label>
      {loadError ? (
        <div role="alert" className="text-xs text-ctp-error">Could not load group projects. <Button kind="ghost" onClick={() => void loadProjects()}>Retry</Button></div>
      ) : (
        <>
          <label htmlFor={scopeId} className="text-xs text-ctp-subtext1">Scope</label>
          <select id={scopeId} value={scopeFilter} onChange={(e) => { setScopeFilter(e.target.value as 'all' | 'app' | 'project'); setSelectedId(''); }} className="w-full h-7 px-2 text-xs bg-ctp-base border border-surface-1 rounded-md text-ctp-text">
            <option value="all">All scopes</option>
            <option value="app">App</option>
            <option value="project">Project</option>
          </select>
          <select id={selectId} value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="w-full h-7 px-2 text-xs bg-ctp-base border border-surface-1 rounded-md text-ctp-text">
            <option value="">{loaded ? 'Select a group project' : 'Loading group projects...'}</option>
            {visibleProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <Button disabled={!projects.some((project) => project.id === selectedId)} onClick={() => {
            const project = projects.find((item) => item.id === selectedId);
            if (project) onUpdateMetadata({ groupProjectId: project.id, name: project.name, ...(referenceUnresolved && { __groupProjectReferenceUnresolved: false }) });
          }} className="self-start">Add existing</Button>
        </>
      )}
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
  projectId,
  onUpdateMetadata,
  referenceUnresolved,
  isRemote,
  satelliteId,
  annex,
}: {
  groupProjectId: string;
  projectId?: string;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
  referenceUnresolved: boolean;
  isRemote: boolean;
  satelliteId: string | null;
  annex: AnnexAPI;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const ctx = useGroupProjectContext(groupProjectId, isRemote, satelliteId, annex);

  useEffect(() => {
    if (!ctx.loaded) void ctx.loadProjects();
  }, [ctx.loaded, ctx.loadProjects]);

  useEffect(() => {
    if (ctx.project && referenceUnresolved) onUpdateMetadata({ __groupProjectReferenceUnresolved: false });
  }, [ctx.project, referenceUnresolved, onUpdateMetadata]);

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
      {ctx.loaded && !ctx.project && !isRemote ? (
        <div className="h-full flex flex-col">
          <div role="status" className="px-4 pt-4 text-xs text-ctp-subtext1">This group project isn't on this machine. Choose one or create one.</div>
          <CreationForm projectId={projectId} onUpdateMetadata={onUpdateMetadata} referenceUnresolved />
        </div>
      ) : isExpanded ? (
        <ExpandedProjectView groupProjectId={groupProjectId} onUpdateMetadata={onUpdateMetadata} ctx={ctx} />
      ) : (
        <ProjectCard groupProjectId={groupProjectId} onUpdateMetadata={onUpdateMetadata} ctx={ctx} />
      )}
    </div>
  );
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
  const { project, members, loaded, loadProjects, setPolling, fetchDigest, injectMessage, getRoles, setRole } = ctx;

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

  // Leads hold the lead grant on this group project (#3360), set here or on the permissions page.
  const [leads, setLeads] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    getRoles(groupProjectId)
      .then((view) => { if (!cancelled) setLeads(view.holders.filter((h) => h.lead !== 'off').map((h) => h.agentId)); })
      .catch(() => { /* telemetry-exempt: no leads shown; the permissions page has them */ });
    return () => { cancelled = true; };
  }, [groupProjectId, getRoles]);
  // On a satellite's card the lead grant is set on the machine that holds the group project.
  const handleToggleLead = useCallback(async (agentId: string) => {
    const view = await setRole(groupProjectId, agentId, 'lead', leads.includes(agentId) ? 'off' : 'allow');
    setLeads(view.holders.filter((h) => h.lead !== 'off').map((h) => h.agentId));
  }, [groupProjectId, leads, setRole]);

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
        <OpenGroupProjectButton groupProjectId={groupProjectId} ctx={ctx} />
      </div>

      <div className="px-3 text-xs text-ctp-overlay1 flex-shrink-0" data-testid="group-project-activity">{activity}</div>
      <ProjectScopeLine ctx={ctx} />

      {description && (
        <Tooltip content={description} onlyWhenTruncated>
          <div className="px-3 pt-1 text-xs text-ctp-subtext0 truncate flex-shrink-0">{description}</div>
        </Tooltip>
      )}

      {!ctx.isRemote && <PausedPolling groupProjectId={groupProjectId} />}

      {/* Members: the star gives an agent the lead grant on this group project (#3360). */}
      {members.length > 0 && (
        <ul className="mt-1.5 px-1.5 flex-1 min-h-0 overflow-y-auto" aria-label="Members">
          {members.map((m) => (
            <MemberRow
              key={m.agentId}
              member={m}
              lead={leads.includes(m.agentId)}
              onToggleLead={() => void handleToggleLead(m.agentId)}
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
        tooltip="Project lead: can broadcast, tap, wake and manage members' context"
        pressed={lead}
        onClick={(e) => { e.stopPropagation(); onToggleLead(); }}
      >
        <StarIcon filled={lead} />
      </IconButton>
    </li>
  );
}


/* ---------- Expanded view: the shared board, with the card's own settings band ---------- */

function ExpandedProjectView({
  groupProjectId,
  onUpdateMetadata,
  ctx,
}: {
  groupProjectId: string;
  onUpdateMetadata: (updates: Record<string, unknown>) => void;
  ctx: GroupProjectContextValue;
}) {
  return (
    <GroupProjectBoard
      groupProjectId={groupProjectId}
      ctx={ctx}
      variant="card"
      onUpdateMetadata={onUpdateMetadata}
      headerActions={<OpenGroupProjectButton groupProjectId={groupProjectId} ctx={ctx} />}
      settingsBand={<GroupProjectDefaultsPanel groupProjectId={groupProjectId} ctx={ctx} includeText />}
    />
  );
}

/**
 * Opens the group project's workspace, Board first. It reaches this computer's group projects only:
 * a card showing another computer's group project has no workspace here, and a popout window has
 * no main-window route to hand off to.
 */
function OpenGroupProjectButton({ groupProjectId, ctx }: { groupProjectId: string; ctx: GroupProjectContextValue }) {
  if (ctx.isRemote || window.clubhouse.window?.isPopout?.()) return null;
  return (
    <IconButton
      label="Open group project"
      tooltip="Open this group project's workspace"
      onClick={() => openGroupWorkspaceFrom({ groupId: groupProjectId }, currentViewSource('Canvas'))}
    >
      <OpenIcon />
    </IconButton>
  );
}
