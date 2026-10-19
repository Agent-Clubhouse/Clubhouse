/**
 * Agent details (#2032, "Design decided 2026-10-17"): a 340px column of cards
 * beside the transcript or terminal, behind one toolbar button (⌥⌘D). It
 * replaces the old Agents and Changes side panels. There is no pane to pin or
 * resize; the chat column moves left so no card covers a message.
 *
 * The cards, each collapsed to a one-line answer until clicked: Changes,
 * Subagents, Canvases, Orchestrate, Helpers, Connections, Context window, MCP
 * servers and Session. Cards the runtime can't fill are left out (#2094):
 * Subagents when the agent doesn't report them (the terminal, or a driver
 * without subagents) and Context window until the agent reports how full it
 * is. The orchestration cards (#2232) are for local durable agents:
 * Orchestrate for any that isn't itself a helper, Helpers once it
 * orchestrates or has helpers, Connections once it orchestrates or has wires.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Project } from '../../../../shared/types';
import type { BranchChanges } from '../../../../shared/git-branch';
import type { ChatViewState } from '../../../stores/chatStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { isRemoteProjectId } from '../../../stores/remoteProjectStore';
import { Tooltip } from '../../../components/Tooltip';
import { jumpToCanvas, useAgentCanvases } from './agent-canvases';
import { getOrchestratorLabel } from '../orchestrator-colors';
import { DRIVER_LABELS, limitLabel, limitName } from '../chat/ChatHeader';
import { SubagentList, subagentSummary } from '../chat/AgentMapPanel';
import { buildAgentMap, formatCost, formatDuration, formatTokens, LEVEL_LABELS } from '../chat/view-model';
import { ChangesCard, type ChangesScope } from './ChangesCard';
import { CardNote, CardRow, DetailsCard, UsageBar } from './DetailsCard';
import { AutoSleepRow } from './AutoSleepRow';
import { McpCard } from './McpCard';
import { useAgentDetailsStore } from './detailsStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { ConnectionsCard, type Connection } from '../helpers/ConnectionsCard';
import { OrchestrationCardPair, useOrchestrationCards } from '../helpers/OrchestrationCards';

export type CardId = 'changes' | 'subagents' | 'canvases' | 'orchestrate' | 'helpers' | 'connections' | 'context' | 'mcp' | 'session';

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
  const known = useProjectStore((s) => s.projects.find((p) => p.id === projectId)?.path);
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
}

export function AgentDetails({ agent, chat, onShowInStream, missedSubagentId, onReviewAll, branch: givenBranch }: AgentDetailsProps) {
  const setOpen = useAgentDetailsStore((s) => s.setOpen);
  const focus = useAgentDetailsStore((s) => s.focus);
  const [openCards, setOpenCards] = useState<Set<CardId>>(() => new Set());
  const [scope, setScope] = useState<ChangesScope>('branch');
  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const toggleCard = useCallback((id: CardId) => setOpenCards((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

  // "Open in details" from elsewhere opens that card.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || focus.agentId !== agent.id || handled.current === focus.nonce) return;
    handled.current = focus.nonce;
    setOpenCards((s) => new Set(s).add(focus.card));
    if (focus.subagentId) setSelectedSub(focus.subagentId);
  }, [focus, agent.id]);

  const projectPath = useProjectPath(agent.projectId);
  const cwd = agentCwd(agent, projectPath);
  const hook = useAgentStore((s) => s.agentDetailedStatus[agent.id]);
  const spawnedAt = useAgentStore((s) => s.agentSpawnedAt[agent.id]);
  const orchestrators = useOrchestratorStore((s) => s.allOrchestrators);

  // Chat refreshes when a turn starts or ends, or the agent commits, pushes
  // or rebases mid-turn; the terminal when its hook status moves on.
  const refreshKey = chat ? `${chat.turnId ?? 'idle'}:${chat.state ?? ''}:${chat.workspaceRevision ?? 0}` : `${hook?.state ?? ''}:${hook?.toolName ?? ''}:${agent.status}`;
  const ownBranch = useBranchChanges(givenBranch === undefined ? cwd : undefined, refreshKey);
  const branch = givenBranch === undefined ? ownBranch : givenBranch;

  const { items, subagents, capabilities, state: runState } = chat ?? {};
  const map = useMemo(
    () => (chat ? buildAgentMap({ items: items ?? [], subagents: subagents ?? {}, capabilities: capabilities ?? null, state: runState ?? null }) : null),
    [chat, items, subagents, capabilities, runState],
  );
  const canvases = useAgentCanvases(agent);
  const running = agent.status === 'running';

  // Orchestration (#2232): local durable agents only; a satellite keeps its own config.
  const orchestration = useOrchestrationCards(agent, projectPath);
  const { orchestrationPath, ownConfig, helperIds, orchestrating } = orchestration;
  const hasWires = useMcpBindingStore((s) => s.bindings.some((b) => b.agentId === agent.id || (b.targetKind === 'agent' && b.targetId === agent.id)));
  const showConnections = !!orchestrationPath && (orchestrating || hasWires);
  // A tool-made wire removed here is a user removal: the usual unbind, with no cause (#2230).
  const disconnectToolWire = useCallback(async (c: Connection) => {
    const unbind = useMcpBindingStore.getState().unbind;
    for (const pair of c.pairs) await unbind(pair.agentId, pair.targetId);
  }, []);
  const now = useNow(running && !!spawnedAt);

  const open = (id: CardId) => openCards.has(id);
  const providerId = chat?.provider ?? agent.orchestrator ?? 'claude-code';
  const provider = getOrchestratorLabel(providerId, orchestrators);

  // Subagents: only when the agent reports them.
  const showSubagents = !!map && map.mode !== 'none';

  // Context window: only once the agent has reported how full it is.
  const ctx = chat && chat.capabilities && chat.capabilities.usage !== 'none' ? chat.usage.context : null;
  const ctxPct = ctx && ctx.size > 0 ? Math.min(100, Math.round((ctx.used / ctx.size) * 100)) : null;

  // Session
  const model = chat?.model ?? agent.model;
  const shownModel = model && model !== 'default' ? model : null;
  const session = chat?.usage.session;
  const cost = session?.costUsd !== undefined ? formatCost(session.costUsd, session.costIsEstimate) : null;
  // Drivers without a session total (ACP) report per turn: sum those.
  const tokens = tokensOf(session?.tokens ?? chat?.usage.turnTotal ?? undefined);
  const runningFor = running && spawnedAt ? formatDuration(now - spawnedAt) : null;
  const sessionSummary = [shownModel, runningFor, cost].filter(Boolean).join(' · ');
  const limits = chat?.capabilities?.limits ? chat.usage.limits : [];

  return (
    <aside
      className="w-[340px] flex-shrink-0 min-h-0 overflow-y-auto flex flex-col gap-2 pt-2.5 pb-3 pr-3.5 pl-1"
      data-testid="agent-details"
      data-agent-map-scroller
      aria-label={`${agent.name} details`}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
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

      <ChangesCard
        open={open('changes')}
        onToggle={() => toggleCard('changes')}
        cwd={cwd}
        branch={branch}
        chat={chat ? { sessionId: chat.sessionId, refreshKey } : undefined}
        agentId={agent.id}
        scope={chat ? scope : 'branch'}
        onScope={setScope}
        onReviewAll={onReviewAll}
      />

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

      <DetailsCard
        id="canvases"
        title="Canvases"
        summary={canvases.length === 0 ? 'not on a canvas' : `on ${canvases.length} ${canvases.length === 1 ? 'board' : 'boards'}`}
        open={open('canvases')}
        onToggle={() => toggleCard('canvases')}
      >
        {canvases.length === 0 ? (
          <CardNote>No canvas has a card for this agent.</CardNote>
        ) : (
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
        )}
      </DetailsCard>

      <OrchestrationCardPair agent={agent} model={orchestration} isOpen={open} onToggle={toggleCard} />

      {showConnections && (
        <ConnectionsCard
          agent={agent}
          helperIds={helperIds}
          parentId={ownConfig?.parentAgentId}
          open={open('connections')}
          onToggle={() => toggleCard('connections')}
          onDisconnect={disconnectToolWire}
        />
      )}

      {ctx && ctxPct !== null && (
        <DetailsCard
          id="context"
          title="Context window"
          summary={`${ctxPct}% of ${formatTokens(ctx.size)}${ctx.window === 'input' ? ' input' : ''}`}
          right={<UsageBar pct={ctxPct} className="w-14 h-[5px]" />}
          open={open('context')}
          onToggle={() => toggleCard('context')}
        >
          <div className="pr-3.5 pl-[33px] pt-1 pb-1.5 flex flex-col gap-2 text-xs">
            <UsageBar pct={ctxPct} />
            <span className="text-ctp-text">{formatTokens(ctx.used)} of {formatTokens(ctx.size)} {ctx.window === 'input' ? 'input ' : ''}tokens</span>
            {ctx.window === 'input' && (
              <span className="text-ctp-overlay1">{provider} reports the room left for input after its output reserve, so its own total can be larger.</span>
            )}
            <span className="text-ctp-overlay1">{provider} compacts the conversation on its own near the limit.</span>
          </div>
        </DetailsCard>
      )}

      <McpCard
        agent={agent}
        live={chat?.mcpServers ?? null}
        spawnedAt={spawnedAt}
        refreshKey={refreshKey}
        open={open('mcp')}
        onToggle={() => toggleCard('mcp')}
      />

      <DetailsCard id="session" title="Session" summary={sessionSummary} open={open('session')} onToggle={() => toggleCard('session')}>
        <CardRow label="Runs on">
          {provider}
          {chat?.driver ? <span className="text-ctp-overlay1"> · {DRIVER_LABELS[chat.driver] ?? chat.driver}{chat.cliVersion ? ` ${chat.cliVersion}` : ''}</span> : !chat ? <span className="text-ctp-overlay1"> · terminal</span> : null}
        </CardRow>
        {/* Only chat agents idle-sleep; agents on another machine keep their config there. */}
        {chat && agent.kind === 'durable' && projectPath && !isRemoteProjectId(agent.projectId) && <AutoSleepRow agent={agent} projectPath={projectPath} />}
        {shownModel && <CardRow label="Model">{shownModel}{chat?.effort ? <span className="text-ctp-overlay1"> · {chat.effort} effort</span> : null}</CardRow>}
        {chat?.level && <CardRow label="Level">{chat.levelNames?.[chat.level] ?? LEVEL_LABELS[chat.level]}</CardRow>}
        <CardRow label="Usage">
          {cost || tokens ? <>{cost}{cost && tokens ? <span className="text-ctp-overlay1"> · </span> : null}{tokens ? <span className={cost ? 'text-ctp-overlay1' : ''}>{formatTokens(tokens)} tokens</span> : null}</>
            : <span className="text-ctp-overlay1">{chat ? 'none yet' : 'not reported in the terminal'}</span>}
        </CardRow>
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
      </DetailsCard>
    </aside>
  );
}
