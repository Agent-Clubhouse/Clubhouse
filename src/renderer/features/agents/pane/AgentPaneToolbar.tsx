/**
 * The agent pane's one 32px toolbar (#2018, "Design decided 2026-10-17"). It
 * replaces ChatHeader's 52px header and the terminal's 32px runtime bar, in
 * the main pane and in popouts: status dot and word, what the agent is doing,
 * a neutral orchestrator glyph, the model, the context meter, Changes, the
 * Chat / Terminal switch and the agent's menu. The agent's name is not
 * repeated where the breadcrumb or the popout title already says it.
 *
 * Below 640px wide (popouts parked beside the main window) Changes and the
 * switch become icons and the model moves into the glyph's tooltip.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Agent } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { Tooltip } from '../../../components/Tooltip';
import { holdChromeSurface, reportChromeFeature } from '../../../chrome/telemetry';
import { getOrchestratorLabel } from '../orchestrator-colors';
import { AgentContextMenu, useAgentRowActions } from '../useAgentRowActions';
import { agentDot, DOT_LABEL, StatusDot, type AgentDot } from '../agent-status';
import { useNarrow } from './useNarrow';

export type RuntimeView = 'chat' | 'terminal';

function Svg({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-shrink-0">
      {children}
    </svg>
  );
}
export const DiffIcon = () => <Svg><path d="M12 3v8M8 7h8M8 17h8M5 3h14v18H5z" /></Svg>;
export const ChatBubbleIcon = () => <Svg size={13}><path d="M4 5h16v11H10l-5 4v-4H4z" /></Svg>;
export const TerminalGlyph = () => <Svg size={13}><path d="M4 17l6-5-6-5M12 19h8" /></Svg>;
export const MoreIcon = () => <Svg><path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={3} /></Svg>;

/** The Chat / Terminal switch: labels when wide, two icon segments when narrow. */
export function RuntimeSwitch({ value, onChange, disabled, compact }: { value: RuntimeView; onChange: (v: RuntimeView) => void; disabled?: boolean; compact?: boolean }) {
  return (
    <span className="inline-flex gap-0.5 p-0.5 rounded-[7px] bg-ctp-crust" role="radiogroup" aria-label="Chat or terminal" data-testid="runtime-switch">
      {(['chat', 'terminal'] as const).map((v) => {
        const label = v === 'chat' ? 'Chat' : 'Terminal';
        return (
          <Tooltip key={v} content={label} disabled={!compact}>
            <button
              type="button"
              role="radio"
              aria-checked={value === v}
              aria-label={compact ? label : undefined}
              disabled={disabled}
              onClick={() => { if (v !== value) onChange(v); }}
              className={`h-[22px] flex items-center justify-center rounded-[5px] text-xs ${compact ? 'w-[26px]' : 'px-[9px]'} ${
                value === v ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext0 hover:text-ctp-text'
              } disabled:opacity-50`}
            >
              {compact ? (v === 'chat' ? <ChatBubbleIcon /> : <TerminalGlyph />) : label}
            </button>
          </Tooltip>
        );
      })}
    </span>
  );
}

const ORCH_GLYPH: Record<string, string> = { 'claude-code': 'C', 'codex-cli': 'X', 'copilot-cli': 'G' };

/** Tooltip body: an optional title line, then detail lines. */
function TipLines({ title, lines }: { title?: string; lines: string[] }) {
  return (
    <span className="flex flex-col gap-0.5">
      {title && <span className="font-medium text-ctp-text">{title}</span>}
      {lines.map((l) => <span key={l}>{l}</span>)}
    </span>
  );
}

/** A neutral 14px tile with the provider's initial; its tooltip carries the session details. */
export function OrchestratorGlyph({ orchestrator, details = [] }: { orchestrator: string; details?: string[] }) {
  const all = useOrchestratorStore((s) => s.allOrchestrators);
  const name = getOrchestratorLabel(orchestrator, all);
  const letter = ORCH_GLYPH[orchestrator] ?? (name.charAt(0).toUpperCase() || '?');
  return (
    <Tooltip content={<TipLines title={name} lines={details} />}>
      <span
        role="img"
        tabIndex={0}
        aria-label={[name, ...details].join(', ')}
        data-testid="pane-orchestrator"
        className="flex-shrink-0 w-3.5 h-3.5 rounded grid place-items-center bg-surface-0 text-ctp-overlay1 text-[8.5px] font-semibold leading-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-ctp-accent"
      >
        {letter}
      </span>
    </Tooltip>
  );
}

/** How full the context window is, plus any plan limits, for the toolbar's meter. */
export interface PaneUsage {
  /** Context fill, 0-100, or null when the driver reports only limits. */
  contextPct: number | null;
  /** Context at 90% or more, or a plan limit reached or near it. */
  hot: boolean;
  /** Tooltip lines: context tokens, then each limit with its reset time. */
  lines: string[];
}

/** A 14px ring and the context %, focusable, red when the context or a limit runs out. */
export function UsageMeter({ usage, compact }: { usage: PaneUsage; compact?: boolean }) {
  const pct = usage.contextPct;
  const r = 5;
  const c = 2 * Math.PI * r;
  const label = pct !== null ? `Context ${pct}%` : 'Usage limits';
  return (
    <Tooltip content={<TipLines lines={usage.lines} />}>
      <span
        role="img"
        tabIndex={0}
        aria-label={[label, ...usage.lines.filter((l) => !l.startsWith('Context '))].join(', ')}
        data-testid="pane-usage"
        data-hot={usage.hot || undefined}
        className={`flex-shrink-0 flex items-center gap-1 px-1 h-7 rounded-md tabular-nums focus-visible:outline focus-visible:outline-1 focus-visible:outline-ctp-accent ${usage.hot ? 'text-ctp-error' : 'text-ctp-overlay1'}`}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" className="-rotate-90 flex-shrink-0" aria-hidden="true">
          <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" className="stroke-surface-0" />
          {pct !== null && (
            <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" strokeDasharray={`${(pct / 100) * c} ${c}`} className={usage.hot ? 'stroke-ctp-error' : 'stroke-ctp-info'} />
          )}
        </svg>
        {!compact && pct !== null && <span>{pct}%</span>}
      </span>
    </Tooltip>
  );
}

const QUIET = 'h-7 rounded-md flex items-center gap-1.5 text-xs text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text';

/** The ⋯ menu: the sidebar row's actions for this agent. Mounted only where the menu is offered. */
function PaneMenu({ agent }: { agent: Agent }) {
  const actions = useAgentRowActions(agent).filter((a) => a.visible);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => (menu ? holdChromeSurface('row_menu') : undefined), [menu]);
  if (actions.length === 0) return null;
  return (
    <>
      <Tooltip content="More actions">
        <button
          type="button"
          aria-label={`More actions for ${agent.name}`}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={(e) => {
            if (menu) { setMenu(null); return; }
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right - 160, y: r.bottom + 4 });
            reportChromeFeature('row_menu_open');
          }}
          className={`${QUIET} w-7 justify-center`}
          data-testid="pane-menu-button"
        >
          <MoreIcon />
        </button>
      </Tooltip>
      {menu && <AgentContextMenu actions={actions} position={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

export interface AgentPaneToolbarProps {
  agent: Agent;
  /** The provider, when the session reports one; defaults to the agent's orchestrator. */
  orchestrator?: string | null;
  dot: AgentDot;
  /** What the agent is doing, after the status word ("3:12 · Edit AgentRow.tsx"). */
  activity?: string;
  model?: string | null;
  /** Extra lines for the orchestrator glyph's tooltip: driver, version, branch. */
  details?: string[];
  /** Context fill and plan limits; omitted hides the meter. */
  usage?: PaneUsage | null;
  runtime?: { value: RuntimeView; onChange: (v: RuntimeView) => void; disabled?: boolean; tip?: ReactNode };
  /** The Agent details toggle (#2032), before the runtime switch. */
  detailsToggle?: ReactNode;
  /** Offer the agent's ⋯ menu (the main pane; popouts have their actions in the title bar). */
  showMenu?: boolean;
  /**
   * Name the agent at the start of the bar. Off in the new layout, where the
   * breadcrumb or popout title names it; on in the classic shell, which has neither.
   */
  showName?: boolean;
}

export function AgentPaneToolbar({ agent, orchestrator, dot, activity, model, details, usage, runtime, detailsToggle, showMenu, showName }: AgentPaneToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(ref);
  const shownModel = model && model !== 'default' ? model : null;
  const glyphDetails = [...(narrow && shownModel ? [`Model ${shownModel}`] : []), ...(details ?? [])];

  return (
    <div
      ref={ref}
      className="h-8 flex-shrink-0 flex items-center gap-2 pl-3.5 pr-1.5 border-b border-surface-0 bg-ctp-base text-xs text-ctp-overlay1 min-w-0"
      data-testid="agent-pane-toolbar"
      data-narrow={narrow || undefined}
    >
      {showName && <span className="text-[13px] font-medium text-ctp-text truncate min-w-0 max-w-[40%]" data-testid="pane-agent-name">{agent.name}</span>}
      <StatusDot dot={dot} />
      <span className="text-ctp-text flex-shrink-0" data-testid="pane-status">{DOT_LABEL[dot]}</span>
      {activity && <span className="min-w-0 truncate" data-testid="pane-activity">{activity}</span>}
      <span className="ml-auto flex-shrink-0 flex items-center gap-1">
        <OrchestratorGlyph orchestrator={orchestrator ?? agent.orchestrator ?? 'claude-code'} details={glyphDetails} />
        {shownModel && !narrow && <span className="ml-1 text-ctp-overlay1" data-testid="pane-model">{shownModel}</span>}
        {usage && <UsageMeter usage={usage} compact={narrow} />}
        {(runtime || detailsToggle) && <span className="w-px h-4 bg-surface-0 mx-1" aria-hidden="true" />}
        {detailsToggle}
        {runtime && (
          <span className="relative">
            <RuntimeSwitch value={runtime.value} onChange={runtime.onChange} disabled={runtime.disabled} compact={narrow} />
            {runtime.tip}
          </span>
        )}
        {showMenu && <PaneMenu agent={agent} />}
      </span>
    </div>
  );
}

/**
 * The toolbar for an agent in the terminal runtime, fed from hook status: the
 * same bar the chat runtime shows, so switching runtimes keeps it in place.
 */
export function TerminalPaneToolbar({ agent, runtime, detailsToggle, showMenu, showName }: Pick<AgentPaneToolbarProps, 'agent' | 'runtime' | 'detailsToggle' | 'showMenu' | 'showName'>) {
  const detailed = useAgentStore((s) => s.agentDetailedStatus[agent.id]);
  const dot = agentDot(agent, detailed);
  // "Idle" after a stop only repeats the Done the status word already says.
  const activity = agent.status === 'running' ? (dot === 'idle' && detailed?.message === 'Idle' ? undefined : detailed?.message)
    : agent.status === 'error' ? agent.errorMessage : undefined;
  return (
    <AgentPaneToolbar
      agent={agent}
      dot={dot}
      activity={activity || undefined}
      model={agent.model}
      details={agent.branch ? [`Branch ${agent.branch}`] : undefined}
      runtime={runtime}
      detailsToggle={detailsToggle}
      showMenu={showMenu}
      showName={showName}
    />
  );
}
