/**
 * Agent details (#2032, "Design decided 2026-10-17"): a 340px column of cards
 * beside the transcript or terminal, behind one toolbar button (⌥⌘D). It
 * replaces the old Agents and Changes side panels. There is no pane to pin or
 * resize; the chat column moves left so no card covers a message.
 *
 * Six cards, each collapsed to a one-line answer until clicked: Changes,
 * Subagents, Canvases, Context window, MCP servers and Session. Cards a
 * runtime can't fill (the terminal reports no subagents or context) say so.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { BranchChanges } from '../../../../shared/git-branch';
import type { ChatViewState } from '../../../stores/chatStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useUIStore } from '../../../stores/uiStore';
import { isRemoteProjectId } from '../../../stores/remoteProjectStore';
import { Tooltip } from '../../../components/Tooltip';
import { getProjectCanvasStore, useAppCanvasStore } from '../../../plugins/builtin/canvas/main';
import type { CanvasInstance } from '../../../plugins/builtin/canvas/canvas-types';
import { getOrchestratorLabel } from '../orchestrator-colors';
import { DRIVER_LABELS, limitLabel } from '../chat/ChatHeader';
import { SubagentList, subagentSummary } from '../chat/AgentMapPanel';
import { buildAgentMap, formatCost, formatDuration, formatTokens, LEVEL_LABELS } from '../chat/view-model';
import { ChangesCard, type ChangesScope } from './ChangesCard';
import { CardNote, CardRow, DetailsCard, UsageBar } from './DetailsCard';
import { useAgentDetailsStore } from './detailsStore';

export type CardId = 'changes' | 'subagents' | 'canvases' | 'context' | 'mcp' | 'session';

/** The agent's folder on this machine, for git; none for agents on another machine. */
export function agentCwd(agent: Agent, projectPath: string | undefined): string | undefined {
  if (isRemoteProjectId(agent.projectId)) return undefined;
  return agent.worktreePath || projectPath;
}

/** The branch against main, refreshed when `refreshKey` changes (turn end, hook status). */
export function useBranchChanges(cwd: string | undefined, refreshKey: unknown): BranchChanges | null {
  const [changes, setChanges] = useState<BranchChanges | null>(null);
  useEffect(() => {
    if (!cwd) { setChanges(null); return; }
    let cancelled = false;
    window.clubhouse.git.branchChanges(cwd, undefined).then(
      (r) => { if (!cancelled) setChanges(r); },
      // telemetry-exempt: the card shows "not a git repository" and the rest of details keeps working.
      () => { if (!cancelled) setChanges({ available: false, files: [], ahead: 0, uncommitted: 0 }); },
    );
    return () => { cancelled = true; };
  }, [cwd, refreshKey]);
  return changes;
}

const CANVAS_TAB = 'plugin:canvas';

interface CanvasHit {
  scope: 'project' | 'app';
  canvasId: string;
  name: string;
  viewId: string;
}

function hitsIn(canvases: CanvasInstance[], agentId: string, scope: CanvasHit['scope']): CanvasHit[] {
  const out: CanvasHit[] = [];
  for (const c of canvases) {
    const view = c.views.find((v) => v.type === 'agent' && 'agentId' in v && v.agentId === agentId);
    if (view) out.push({ scope, canvasId: c.id, name: c.name, viewId: view.id });
  }
  return out;
}

/** The canvases that hold a card for this agent, in its project and on Home. */
function useAgentCanvases(agent: Agent): CanvasHit[] {
  const projectStore = useMemo(() => getProjectCanvasStore(agent.projectId ?? null), [agent.projectId]);
  const projectCanvases = projectStore((s) => s.canvases);
  const appCanvases = useAppCanvasStore((s) => s.canvases);
  return useMemo(
    () => [...hitsIn(projectCanvases, agent.id, 'project'), ...hitsIn(appCanvases, agent.id, 'app')],
    [projectCanvases, appCanvases, agent.id],
  );
}

function jumpToCanvas(agent: Agent, hit: CanvasHit): void {
  const ui = useUIStore.getState();
  if (hit.scope === 'project' && agent.projectId) {
    useProjectStore.getState().setActiveProject(agent.projectId);
    ui.setExplorerTab(CANVAS_TAB, agent.projectId);
    const store = getProjectCanvasStore(agent.projectId).getState();
    store.setActiveCanvas(hit.canvasId);
    store.focusView(hit.viewId);
    store.selectView(hit.viewId);
  } else {
    useProjectStore.getState().setActiveProject(null);
    ui.setExplorerTab(CANVAS_TAB);
    const store = useAppCanvasStore.getState();
    store.setActiveCanvas(hit.canvasId);
    store.focusView(hit.viewId);
    store.selectView(hit.viewId);
  }
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
}

export function AgentDetails({ agent, chat, onShowInStream, missedSubagentId, onReviewAll }: AgentDetailsProps) {
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

  const projectPath = useProjectStore((s) => s.projects.find((p) => p.id === agent.projectId)?.path);
  const cwd = agentCwd(agent, projectPath);
  const hook = useAgentStore((s) => s.agentDetailedStatus[agent.id]);
  const spawnedAt = useAgentStore((s) => s.agentSpawnedAt[agent.id]);
  const orchestrators = useOrchestratorStore((s) => s.allOrchestrators);

  // Chat refreshes when a turn starts or ends; the terminal when its hook status moves on.
  const refreshKey = chat ? `${chat.turnId ?? 'idle'}:${chat.state ?? ''}` : `${hook?.state ?? ''}:${hook?.toolName ?? ''}:${agent.status}`;
  const branch = useBranchChanges(cwd, refreshKey);

  const { items, subagents, capabilities, state: runState } = chat ?? {};
  const map = useMemo(
    () => (chat ? buildAgentMap({ items: items ?? [], subagents: subagents ?? {}, capabilities: capabilities ?? null, state: runState ?? null }) : null),
    [chat, items, subagents, capabilities, runState],
  );
  const canvases = useAgentCanvases(agent);
  const running = agent.status === 'running';
  const now = useNow(running && !!spawnedAt);

  const open = (id: CardId) => openCards.has(id);
  const providerId = chat?.provider ?? agent.orchestrator ?? 'claude-code';
  const provider = getOrchestratorLabel(providerId, orchestrators);

  // Subagents
  const subsSummary = !chat ? 'not reported in the terminal'
    : !map || map.mode === 'none' ? 'not reported by this agent' : subagentSummary(map);

  // Context window
  const ctx = chat && chat.capabilities && chat.capabilities.usage !== 'none' ? chat.usage.context : null;
  const ctxPct = ctx && ctx.size > 0 ? Math.min(100, Math.round((ctx.used / ctx.size) * 100)) : null;

  // MCP servers
  const mcp = agent.mcpIds ?? [];

  // Session
  const model = chat?.model ?? agent.model;
  const shownModel = model && model !== 'default' ? model : null;
  const session = chat?.usage.session;
  const cost = session?.costUsd !== undefined ? formatCost(session.costUsd, session.costIsEstimate) : null;
  const tokens = tokensOf(session?.tokens);
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
        // Focus goes back to the toolbar button that shows details.
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="agent-details-toggle"]')?.focus());
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

      <DetailsCard id="subagents" title="Subagents" summary={subsSummary} open={open('subagents')} onToggle={() => toggleCard('subagents')}>
        {!chat ? (
          <CardNote>The terminal doesn&apos;t report subagents. Switch to Chat to follow them here.</CardNote>
        ) : !map || map.mode === 'none' ? (
          <CardNote>This agent doesn&apos;t report its subagents.</CardNote>
        ) : (
          <SubagentList
            agent={agent}
            state={chat}
            map={map}
            selected={selectedSub}
            onSelect={setSelectedSub}
            onShowInStream={(id) => onShowInStream?.(id)}
            missedSubagentId={missedSubagentId}
          />
        )}
      </DetailsCard>

      <DetailsCard
        id="canvases"
        title="Canvases"
        summary={canvases.length === 0 ? 'not on a canvas' : `on ${canvases.length} ${canvases.length === 1 ? 'board' : 'boards'}`}
        open={open('canvases')}
        onToggle={() => toggleCard('canvases')}
      >
        {canvases.length === 0 ? (
          <CardNote>No canvas has a card for this agent. Canvases you haven&apos;t opened this session aren&apos;t searched.</CardNote>
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

      <DetailsCard
        id="context"
        title="Context window"
        summary={ctx && ctxPct !== null ? `${ctxPct}% of ${formatTokens(ctx.size)}` : 'not reported'}
        right={ctxPct !== null ? <UsageBar pct={ctxPct} className="w-14 h-[5px]" /> : undefined}
        open={open('context')}
        onToggle={() => toggleCard('context')}
      >
        {ctx && ctxPct !== null ? (
          <div className="pr-3.5 pl-[33px] pt-1 pb-1.5 flex flex-col gap-2 text-xs">
            <UsageBar pct={ctxPct} />
            <span className="text-ctp-text">{formatTokens(ctx.used)} of {formatTokens(ctx.size)} tokens</span>
            <span className="text-ctp-overlay1">{provider} compacts the conversation on its own near the limit.</span>
          </div>
        ) : !chat ? (
          <CardNote>The terminal doesn&apos;t report how full the context is. Switch to Chat to see it here.</CardNote>
        ) : (
          <CardNote>{provider} doesn&apos;t report how full its context is yet.</CardNote>
        )}
      </DetailsCard>

      <DetailsCard
        id="mcp"
        title="MCP servers"
        summary={mcp.length ? `${mcp.length} configured` : 'none configured'}
        open={open('mcp')}
        onToggle={() => toggleCard('mcp')}
      >
        {mcp.length > 0 && (
          <ul className="flex flex-col">
            {mcp.map((id) => (
              <li key={id} className="h-7 flex items-center gap-2 pl-[33px] pr-3.5 text-[12.5px] text-ctp-text">
                <span className="w-2 h-2 rounded-full border border-ctp-overlay0 flex-shrink-0" aria-hidden="true" />
                <span className="truncate font-medium">{id}</span>
                <span className="text-xs text-ctp-overlay1">Configured</span>
              </li>
            ))}
          </ul>
        )}
        <CardNote>{mcp.length ? 'Live connection status isn’t reported yet.' : 'This agent has no MCP servers set in Clubhouse.'}</CardNote>
      </DetailsCard>

      <DetailsCard id="session" title="Session" summary={sessionSummary} open={open('session')} onToggle={() => toggleCard('session')}>
        <CardRow label="Runs on">
          {provider}
          {chat?.driver ? <span className="text-ctp-overlay1"> · {DRIVER_LABELS[chat.driver] ?? chat.driver}{chat.cliVersion ? ` ${chat.cliVersion}` : ''}</span> : !chat ? <span className="text-ctp-overlay1"> · terminal</span> : null}
        </CardRow>
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
                  <span className="text-ctp-overlay1">{l.window}</span>
                  {l.utilization !== undefined && <UsageBar pct={Math.round(l.utilization * 100)} className="w-9 h-[5px]" />}
                  <span>{limitLabel(l)}</span>
                  {l.resetsAt && <span className="text-ctp-overlay1">resets {new Date(l.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>}
                </span>
              ))}
            </span>
          </CardRow>
        )}
        {runningFor && <CardRow label="Running">{runningFor}</CardRow>}
        {cwd && <CardRow label="Folder"><span className="font-mono text-[11.5px] break-all">{agent.worktreePath && projectPath && agent.worktreePath.startsWith(projectPath) ? agent.worktreePath.slice(projectPath.length + 1) : cwd}</span></CardRow>}
        {(branch?.branch || agent.branch) && <CardRow label="Branch"><span className="font-mono text-[11.5px] break-all">{branch?.branch ?? agent.branch}</span></CardRow>}
      </DetailsCard>
    </aside>
  );
}
