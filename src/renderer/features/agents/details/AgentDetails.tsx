/**
 * Agent details (#2032, "Design decided 2026-10-17"): a 340px column of cards
 * beside the transcript or terminal, behind one toolbar button (⌥⌘D). It
 * replaces the old Agents and Changes side panels. There is no pane to pin or
 * resize; the chat column moves left so no card covers a message.
 *
 * Settings, Changes, Dispatcher, Orchestration (including Clubhouse helpers),
 * provider Subagents, Connections, Actions, Skills and MCP, Session (including
 * reported context) and nonempty Canvases (#3286). Runtime evidence stays
 * separate from configured content in Settings. Unsupported cards are omitted.
 * Local durable agents have orchestration controls unless they are helpers.
 * A direct Connections link also opens that card for a local quick agent.
 *
 * The Dispatcher is an experience, not an agent to inspect (#3184): it shows
 * Settings, Actions and Connections, none of the agent internals.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Project } from '../../../../shared/types';
import type { BranchChanges } from '../../../../shared/git-branch';
import type { ChatViewState } from '../../../stores/chatStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { isRemoteProjectId } from '../../../stores/remoteProjectStore';
import { dispatcherWiresAgentId, isDispatcherAgent, useDispatcherStore, useLocalProject } from '../../dispatcher/dispatcherStore';
import { OtherDispatchers } from '../../dispatcher/OtherDispatchers';
import { Tooltip } from '../../../components/Tooltip';
import { jumpToCanvas, useAgentCanvases } from './agent-canvases';
import { getOrchestratorLabel } from '../orchestrator-colors';
import { DRIVER_LABELS, limitLabel, limitName } from '../chat/ChatHeader';
import { SubagentList, subagentSummary } from '../chat/AgentMapPanel';
import { buildAgentMap, formatCost, formatDuration, formatTokens } from '../chat/view-model';
import { ChangesCard, type ChangesScope } from './ChangesCard';
import { AgentActionsCard, DispatcherActionsCard } from '../../actions/AgentActionsPage';
import { CardNote, CardRow, DetailsCard, UsageBar } from './DetailsCard';
import { SettingsCard } from './SettingsCard';
import { McpCard } from './McpCard';
import { ProviderSkillsCard } from './ProviderSkillsCard';
import { containingDetailsCard, useAgentDetailsStore, useDetailsCardState, type CardId } from './detailsStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import type { LastSessionInfo } from '../states/useLastSession';
import { describeSleep, formatAgo, formatShortDuration, formatUsd } from '../states/format';
import { ConnectionsCard, type Connection } from '../helpers/ConnectionsCard';
import { OrchestrationCardPair, useOrchestrationCards } from '../helpers/OrchestrationCards';
import { useEffectiveOrchestrator } from '../effective-orchestrator';
import { useDispatcherConnection } from '../../dispatcher/useDispatcherEnabled';
import { DispatcherCard } from './DispatcherCard';
import { openAgentSettingsOn } from '../agentSettingsPages';
import { Button } from '../../../components/Button';

export type { CardId } from './detailsStore';

/** A worktree inside the project, as a path relative to it; null when it lives elsewhere. */
export function relativeFolder(worktree: string | undefined, projectPath: string | undefined): string | null {
  if (!worktree || !projectPath) return null;
  const root = projectPath.replace(/[\\/]+$/, '');
  if (worktree.length <= root.length + 1 || !worktree.startsWith(root)) return null;
  const sep = worktree[root.length];
  return sep === '/' || sep === '\\' ? worktree.slice(root.length + 1) : null;
}

/** The agent's folder on this machine, for git; none for agents on another machine. */
export function agentCwd(agent: Agent, projectPath: string | undefined): string | undefined {
  if (isRemoteProjectId(agent.projectId)) return undefined;
  return agent.worktreePath || projectPath;
}

/**
 * The agent's project folder. A popout window has no project list of its own,
 * so it asks main for one when the store doesn't know the project.
 */
export function useProjectPath(projectId: string | undefined): string | undefined {
  // The Dispatcher's folder too (#2538): it's in no project.
  const known = useLocalProject(projectId)?.path;
  const [fetched, setFetched] = useState<{ id: string; path: string | undefined } | null>(null);
  useEffect(() => {
    if (known || !projectId || isRemoteProjectId(projectId) || !window.clubhouse.window?.isPopout?.()) return;
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.project.list()).then(
      (projects) => { if (alive) setFetched({ id: projectId, path: (projects as Project[]).find((p) => p.id === projectId)?.path }); },
      // telemetry-exempt: the cards that need the folder say so; the rest work without it.
      () => { /* no folder */ },
    );
    return () => { alive = false; };
  }, [known, projectId]);
  return known ?? (fetched?.id === projectId ? fetched.path : undefined);
}

/** Minimum gap between branch reads while an agent is busy (each tool event bumps the refresh key). */
export const BRANCH_REFRESH_MS = 2_000;

/**
 * The branch against main, re-read when `refreshKey` changes (turn end, hook
 * status). Reads are throttled to one per BRANCH_REFRESH_MS and never
 * overlap: a change during a read runs once more after it.
 */
export function useBranchChanges(cwd: string | undefined, refreshKey: unknown): BranchChanges | null {
  const [changes, setChanges] = useState<BranchChanges | null>(null);
  const lastRun = useRef(0);
  const inFlight = useRef(false);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  /** The current effect's scheduler, so a read that ends after a newer change still runs once more. */
  const scheduleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!cwd) { setChanges(null); return; }
    let alive = true;
    const run = () => {
      timer.current = null;
      if (inFlight.current) { pending.current = true; return; }
      inFlight.current = true;
      pending.current = false;
      lastRun.current = Date.now();
      const dir = cwd;
      Promise.resolve().then(() => window.clubhouse.git.branchChanges(dir, undefined)).then(
        (r) => { if (alive && cwdRef.current === dir) setChanges(r); },
        // telemetry-exempt: the card shows "not a git repository" and the rest of details keeps working.
        () => { if (alive && cwdRef.current === dir) setChanges({ available: false, files: [] }); },
      ).finally(() => {
        inFlight.current = false;
        if (pending.current) scheduleRef.current?.();
      });
    };
    const schedule = () => {
      if (timer.current) return;
      const wait = Math.max(0, BRANCH_REFRESH_MS - (Date.now() - lastRun.current));
      timer.current = setTimeout(run, wait);
    };
    scheduleRef.current = schedule;
    schedule();
    return () => {
      alive = false;
      if (scheduleRef.current === schedule) scheduleRef.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [cwd, refreshKey]);
  return changes;
}

function useNow(active: boolean, everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs]);
  return now;
}

function tokensOf(t: { total?: number; input?: number; output?: number } | undefined): number | undefined {
  if (!t) return undefined;
  return t.total ?? ((t.input ?? 0) + (t.output ?? 0) || undefined);
}

/** "stopped by you" as a value on its own: "Stopped by you". */
function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export interface AgentDetailsProps {
  agent: Agent;
  /** The chat session, when the agent runs in chat. */
  chat?: ChatViewState;
  /** Jump the conversation to a subagent ("Show in conversation"). */
  onShowInStream?: (subagentId: string) => void;
  /** The subagent the last jump couldn't find in the loaded conversation. */
  missedSubagentId?: string | null;
  /** Opens the full Changes review. */
  onReviewAll?: () => void;
  /** The branch against main, when the pane already reads it (useAgentReview). */
  branch?: BranchChanges | null;
  /**
   * The sleeping view's last session (#2281), loaded after the view is up:
   * null until the config is read, then filled in as the summary arrives.
   */
  lastSession?: LastSessionInfo | null;
}

export function AgentDetails({ agent, chat, onShowInStream, missedSubagentId, onReviewAll, branch: givenBranch, lastSession }: AgentDetailsProps) {
  const setOpen = useAgentDetailsStore((s) => s.setOpen);
  const focus = useAgentDetailsStore((s) => s.focus);
  const [scope, setScope] = useState<ChangesScope>('branch');
  const [selectedSub, setSelectedSub] = useState<string | null>(null);

  const projectPath = useProjectPath(agent.projectId);
  const cwd = agentCwd(agent, projectPath);
  const hook = useAgentStore((s) => s.agentDetailedStatus[agent.id]);
  const spawnedAt = useAgentStore((s) => s.agentSpawnedAt[agent.id]);
  const orchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const agentCli = useEffectiveOrchestrator(agent);
  const dispatcher = isDispatcherAgent(agent);
  const federationPeers = useDispatcherStore((s) => s.state?.federationPeers);

  // Chat refreshes when a turn starts or ends, or the agent commits, pushes
  // or rebases mid-turn; the terminal when its hook status moves on.
  const refreshKey = chat ? `${chat.turnId ?? 'idle'}:${chat.state ?? ''}:${chat.workspaceRevision ?? 0}` : `${hook?.state ?? ''}:${hook?.toolName ?? ''}:${agent.status}`;
  // The Dispatcher has no Changes card, so its folder isn't read.
  const ownBranch = useBranchChanges(givenBranch === undefined && !dispatcher ? cwd : undefined, refreshKey);
  const branch = givenBranch === undefined ? ownBranch : givenBranch;

  const { items, subagents, capabilities, state: runState } = chat ?? {};
  const map = useMemo(
    () => (chat ? buildAgentMap({ items: items ?? [], subagents: subagents ?? {}, capabilities: capabilities ?? null, state: runState ?? null }) : null),
    [chat, items, subagents, capabilities, runState],
  );
  const canvases = useAgentCanvases(agent);
  const showCanvases = !dispatcher && canvases.length > 0;
  const running = agent.status === 'running';
  // Asleep (#2281): live-only evidence goes, and Session becomes Last session.
  const asleep = agent.status === 'sleeping' || agent.status === 'error';

  // Orchestration (#2232): local durable agents only; a satellite keeps its own config.
  const orchestration = useOrchestrationCards(agent, projectPath);
  const { orchestrationPath, ownConfig, helperIds, orchestrating } = orchestration;
  const { openCards, setOpenCards, toggleCard } = useDetailsCardState(agent.id, orchestration.approvals.pending.length > 0);
  // The Dispatcher's card (#3049): while it's on, for the agents the Orchestration card is for. Helpers never connect.
  const { show: dispatcherOn } = useDispatcherConnection();
  const showDispatcherCard = dispatcherOn && orchestration.showOrchestrate;
  // The Dispatcher's wires are on the id that holds them, not the chat shown here (#3036).
  const wiresId = dispatcherWiresAgentId(agent);
  const wiresAgent = useMemo(() => (wiresId === agent.id ? agent : { ...agent, id: wiresId }), [agent, wiresId]);
  const hasWires = useMcpBindingStore((s) => s.bindings.some((b) => b.agentId === wiresId || (b.targetKind === 'agent' && b.targetId === wiresId)));
  // The Dispatcher has no orchestration of its own, but its wires to orchestrators show (#2538).
  const connectionsRequested = focus?.agentId === agent.id && focus.card === 'connections';
  const showConnections = (!!orchestrationPath && (orchestrating || hasWires)) || (dispatcher && hasWires)
    || (connectionsRequested && !isRemoteProjectId(agent.projectId));
  // A tool-made wire removed here is a user removal: the usual unbind, with no cause (#2230).
  const disconnectToolWire = useCallback(async (c: Connection) => {
    const unbind = useMcpBindingStore.getState().unbind;
    for (const pair of c.pairs) await unbind(pair.agentId, pair.targetId);
  }, []);
  const now = useNow(running && !!spawnedAt);

  const open = (id: CardId) => openCards.has(id);
  const providerId = chat?.provider ?? agentCli;
  const provider = getOrchestratorLabel(providerId, orchestrators);

  // Subagents: only when the agent reports them.
  const showSubagents = !dispatcher && !!map && map.mode !== 'none';

  // Context window: only once the agent has reported how full it is.
  const ctx = !asleep && !dispatcher && chat && chat.capabilities && chat.capabilities.usage !== 'none' ? chat.usage.context : null;
  const ctxPct = ctx && ctx.size > 0 ? Math.min(100, Math.round((ctx.used / ctx.size) * 100)) : null;

  // Session: live stats only; the settings are in the Settings card.
  const session = chat?.usage.session;
  const cost = session?.costUsd !== undefined ? formatCost(session.costUsd, session.costIsEstimate) : null;
  // Drivers without a session total report per turn: sum those.
  const tokens = tokensOf(session?.tokens ?? chat?.usage.turnTotal ?? undefined);
  const runningFor = running && spawnedAt ? formatDuration(now - spawnedAt) : null;
  const sessionSummary = [runningFor, cost].filter(Boolean).join(' · ');
  const ended = agent.lastSleep ? Date.parse(agent.lastSleep.at) : lastSession?.lastActiveAt ?? null;
  const lastSummary = [
    ended !== null && Number.isFinite(ended) ? formatAgo(ended) : null,
    lastSession && lastSession.durationMs > 0 ? formatShortDuration(lastSession.durationMs) : null,
    lastSession && lastSession.costUsd > 0 ? formatUsd(lastSession.costUsd) : null,
  ].filter(Boolean).join(' · ');
  const limits = chat?.capabilities?.limits ? chat.usage.limits : [];
  const showEvidence = !dispatcher && (!asleep || !!chat);
  const available = new Set<CardId>(['settings', 'actions']);
  if (!dispatcher) { available.add('changes'); available.add('session'); }
  if (showCanvases) available.add('canvases');
  if (showSubagents) available.add('subagents');
  if (showDispatcherCard) available.add('dispatcher');
  if (orchestration.showOrchestrate) available.add('orchestrate');
  if (showConnections) available.add('connections');
  if (showEvidence) available.add('skills-mcp');
  const requested = focus?.agentId === agent.id ? containingDetailsCard(focus.card) : null;
  const focusCard = requested && available.has(requested) ? requested : dispatcher ? 'actions' : 'session';

  // Resolve aliases and unavailable targets again as capabilities or memberships load.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || focus.agentId !== agent.id) return;
    const key = `${agent.id}:${focus.nonce}:${focusCard}`;
    if (handled.current === key) return;
    handled.current = key;
    if (focusCard === 'settings') useAgentDetailsStore.getState().setSettingsOpen(true);
    else setOpenCards((s) => new Set(s).add(focusCard));
    if (focus.subagentId) setSelectedSub(focus.subagentId);
  }, [focus, agent.id, focusCard, setOpenCards]);
  useEffect(() => {
    if (showCanvases) return;
    setOpenCards((s) => {
      if (!s.has('canvases')) return s;
      const next = new Set(s);
      next.delete('canvases');
      next.add(dispatcher ? 'actions' : 'session');
      return next;
    });
  }, [showCanvases, dispatcher, setOpenCards]);

  return (
    <aside
      className="w-[340px] flex-shrink-0 min-h-0 overflow-y-auto flex flex-col gap-2 pt-2.5 pb-3 pr-3.5 pl-1"
      data-testid="agent-details"
      data-agent-map-scroller
      aria-label={`${agent.name} details`}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
        e.preventDefault();
        setOpen(false);
        // Focus goes back to this pane's toolbar button.
        const pane = e.currentTarget.closest('[data-agent-pane]');
        requestAnimationFrame(() => pane?.querySelector<HTMLElement>('[data-testid="agent-details-toggle"]')?.focus());
      }}
    >
      <div className="flex-shrink-0 h-[26px] flex items-center gap-1.5 px-1 text-xs text-ctp-overlay1">
        <span className="font-semibold text-ctp-subtext1">Details</span>
        <span className="truncate">{agent.name}</span>
        <Tooltip content="Hide details" shortcutAction="toggle-agent-details">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Hide details"
            className="ml-auto w-6 h-6 rounded-md grid place-items-center text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text"
            data-testid="agent-details-close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </Tooltip>
      </div>

      {agent.kind === 'durable' && agent.status === 'error' && !agent.creationFailed && !dispatcher && !isRemoteProjectId(agent.projectId) && (
        <div className="px-1 text-xs text-ctp-subtext0">
          <p>Its CLI could not start.</p>
          <Button kind="ghost" onClick={() => openAgentSettingsOn(agent.id, 'runtime')}>Change CLI</Button>
        </div>
      )}
      <SettingsCard agent={agent} chat={chat} projectPath={projectPath} provider={provider} />
      {dispatcher && federationPeers && <div className="px-3 py-2"><OtherDispatchers peers={federationPeers} compact /></div>}

      {!dispatcher && <ChangesCard
        open={open('changes')}
        onToggle={() => toggleCard('changes')}
        cwd={cwd}
        branch={branch}
        // Checkpoints are this machine's: none for an agent on another desktop (#2390).
        chat={chat && !isRemoteProjectId(agent.projectId) ? { sessionId: chat.sessionId, refreshKey } : undefined}
        agentId={agent.id}
        scope={chat && !isRemoteProjectId(agent.projectId) ? scope : 'branch'}
        onScope={setScope}
        onReviewAll={onReviewAll}
      />}

      {showDispatcherCard && (
        <DispatcherCard agent={agent} orch={orchestration.orch} open={open('dispatcher')} onToggle={() => toggleCard('dispatcher')} />
      )}

      <OrchestrationCardPair agent={agent} model={orchestration} isOpen={open} onToggle={toggleCard} />

      {showSubagents && chat && map && (
        <DetailsCard id="subagents" title="Subagents" summary={subagentSummary(map)} open={open('subagents')} onToggle={() => toggleCard('subagents')}>
          <SubagentList
            agent={agent}
            state={chat}
            map={map}
            selected={selectedSub}
            onSelect={setSelectedSub}
            onShowInStream={(id) => onShowInStream?.(id)}
            missedSubagentId={missedSubagentId}
          />
        </DetailsCard>
      )}

      {showConnections && (
        <ConnectionsCard
          agent={wiresAgent}
          helperIds={helperIds}
          parentId={ownConfig?.parentAgentId}
          open={open('connections')}
          onToggle={() => toggleCard('connections')}
          onDisconnect={disconnectToolWire}
        />
      )}

      {dispatcher
        ? <DispatcherActionsCard open={open('actions')} onToggle={() => toggleCard('actions')} />
        : <AgentActionsCard key={agent.id} agentId={agent.id} agentName={agent.name} projectId={agent.projectId} open={open('actions')} onToggle={() => toggleCard('actions')} />}

      {showEvidence && <DetailsCard id="skills-mcp" title="Skills and MCP" summary={asleep ? 'last session evidence' : 'connections and session reports'} open={open('skills-mcp')} onToggle={() => toggleCard('skills-mcp')}>
        <CardNote>Configured skills and MCP servers are in Settings. These are connection status and provider-reported session evidence.</CardNote>
        {!asleep && <McpCard
          agent={agent}
          projectPath={projectPath}
          live={chat?.mcpServers ?? null}
          spawnedAt={spawnedAt}
          refreshKey={refreshKey}
          open={open('skills-mcp')}
          onToggle={() => toggleCard('skills-mcp')}
          embedded
        />}
        {chat && <ProviderSkillsCard agent={agent} chat={chat} open={open('skills-mcp')} onToggle={() => toggleCard('skills-mcp')} embedded />}
      </DetailsCard>}

      {asleep && !dispatcher && (
        <DetailsCard id="session" title="Last session" summary={lastSummary} open={open('session')} onToggle={() => toggleCard('session')}>
          <CardRow label="Runs on">{provider}</CardRow>
          {ended !== null && Number.isFinite(ended) && <CardRow label="Ended">{formatAgo(ended)}</CardRow>}
          {agent.lastSleep && <CardRow label="Why">{sentence(describeSleep(agent.lastSleep))}</CardRow>}
          {lastSession?.loading && lastSession.sessionId && <CardRow label="Usage"><span className="text-ctp-overlay1" data-testid="details-last-session-loading">Loading</span></CardRow>}
          {lastSession && lastSession.durationMs > 0 && <CardRow label="Duration">{formatShortDuration(lastSession.durationMs)}</CardRow>}
          {lastSession && lastSession.costUsd > 0 && <CardRow label="Cost">{formatUsd(lastSession.costUsd)}</CardRow>}
          {lastSession && !lastSession.sessionId && !agent.lastSleep && <CardNote>No earlier session recorded.</CardNote>}
          {cwd && <CardRow label="Folder"><span className="font-mono text-[11.5px] break-all">{relativeFolder(agent.worktreePath, projectPath) ?? cwd}</span></CardRow>}
          {(branch?.branch || agent.branch) && <CardRow label="Branch"><span className="font-mono text-[11.5px] break-all">{branch?.branch ?? agent.branch}</span></CardRow>}
        </DetailsCard>
      )}

      {!asleep && !dispatcher && <DetailsCard id="session" title="Session" summary={sessionSummary} open={open('session')} onToggle={() => toggleCard('session')}>
        <CardRow label="Runs on">
          {provider}
          {chat?.driver ? <span className="text-ctp-overlay1"> · {DRIVER_LABELS[chat.driver] ?? chat.driver}{chat.cliVersion ? ` ${chat.cliVersion}` : ''}</span> : !chat ? <span className="text-ctp-overlay1"> · CLI</span> : null}
        </CardRow>
        <CardRow label="Usage">
          {cost || tokens ? <>{cost}{cost && tokens ? <span className="text-ctp-overlay1"> · </span> : null}{tokens ? <span className={cost ? 'text-ctp-overlay1' : ''}>{formatTokens(tokens)} tokens</span> : null}</>
            : <span className="text-ctp-overlay1">{chat ? 'none yet' : 'not reported in the CLI view'}</span>}
        </CardRow>
        {ctx && ctxPct !== null && (
          <section aria-label="Context window" data-testid="details-session-context">
            <CardRow label="Context window" labelWidth="wide">
              <span>{ctxPct}% of {formatTokens(ctx.size)}{ctx.window === 'input' ? ' input' : ''}</span>
            </CardRow>
            <div className="pr-3.5 pl-[33px] pt-1 pb-1.5 flex flex-col gap-2 text-xs">
              <UsageBar pct={ctxPct} />
              <span className="text-ctp-text">{formatTokens(ctx.used)} of {formatTokens(ctx.size)} {ctx.window === 'input' ? 'input ' : ''}tokens</span>
              {ctx.window === 'input' && (
                <span className="text-ctp-overlay1">{provider} reports the room left for input after its output reserve, so its own total can be larger.</span>
              )}
              <span className="text-ctp-overlay1">{provider} compacts the conversation on its own near the limit.</span>
            </div>
          </section>
        )}
        {limits.length > 0 && (
          <CardRow label="Plan limits">
            <span className="flex flex-col gap-1">
              {limits.map((l) => (
                <span key={l.window} className="flex items-center gap-1.5">
                  <span className="text-ctp-overlay1">{limitName(l.window)}</span>
                  {l.utilization !== undefined && <UsageBar pct={Math.round(l.utilization * 100)} className="w-9 h-[5px]" />}
                  <span>{limitLabel(l)}</span>
                  {l.resetsAt && <span className="text-ctp-overlay1">resets {new Date(l.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>}
                </span>
              ))}
            </span>
          </CardRow>
        )}
        {runningFor && <CardRow label="Running">{runningFor}</CardRow>}
        {cwd && <CardRow label="Folder"><span className="font-mono text-[11.5px] break-all">{relativeFolder(agent.worktreePath, projectPath) ?? cwd}</span></CardRow>}
        {(branch?.branch || agent.branch) && <CardRow label="Branch"><span className="font-mono text-[11.5px] break-all">{branch?.branch ?? agent.branch}</span></CardRow>}
      </DetailsCard>}

      {showCanvases && <DetailsCard
        id="canvases"
        title="Canvases"
        summary={`on ${canvases.length} ${canvases.length === 1 ? 'board' : 'boards'}`}
        open={open('canvases')}
        onToggle={() => toggleCard('canvases')}
      >
        <ul className="flex flex-col">
          {canvases.map((c) => (
            <li key={`${c.scope}:${c.canvasId}`}>
              <button
                type="button"
                onClick={() => jumpToCanvas(agent, c)}
                className="w-[calc(100%-28px)] ml-[22px] h-[30px] flex items-center gap-2 pl-3 pr-2.5 rounded-md text-left hover:bg-surface-0"
                data-testid="details-canvas-row"
              >
                <span className="text-[12.5px] text-ctp-text truncate">{c.name}</span>
                <span className="text-xs text-ctp-overlay1 whitespace-nowrap">{c.scope === 'app' ? 'Home' : 'card'}</span>
                <span className="ml-auto text-xs text-ctp-accent">Jump</span>
              </button>
            </li>
          ))}
        </ul>
      </DetailsCard>}
    </aside>
  );
}
