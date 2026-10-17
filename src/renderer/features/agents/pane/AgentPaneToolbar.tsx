/**
 * The agent pane's one 32px toolbar (#2018, "Design decided 2026-10-17"). It
 * replaces ChatHeader's 52px header and the terminal's 32px runtime bar, in
 * the main pane and in popouts: status dot and word, what the agent is doing,
 * a neutral orchestrator glyph, the model, Changes, the Chat / Terminal switch
 * and a menu. The agent's name is not repeated; the breadcrumb or the popout
 * title already says it.
 *
 * Below 640px wide (popouts parked beside the main window) Changes and the
 * switch become icons and the model moves into the glyph's tooltip.
 */

import { useRef, useState, type ReactNode } from 'react';
import type { Agent } from '../../../../shared/types';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { getOrchestratorLabel } from '../orchestrator-colors';
import { AgentContextMenu, type ActionDef } from '../useAgentRowActions';
import { useAgentStore } from '../../../stores/agentStore';
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
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            aria-label={compact ? label : undefined}
            title={compact ? label : undefined}
            disabled={disabled}
            onClick={() => { if (v !== value) onChange(v); }}
            className={`h-[22px] flex items-center justify-center rounded-[5px] text-xs ${compact ? 'w-[26px]' : 'px-[9px]'} ${
              value === v ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext0 hover:text-ctp-text'
            } disabled:opacity-50`}
          >
            {compact ? (v === 'chat' ? <ChatBubbleIcon /> : <TerminalGlyph />) : label}
          </button>
        );
      })}
    </span>
  );
}

const ORCH_GLYPH: Record<string, string> = { 'claude-code': 'C', 'codex-cli': 'X', 'copilot-cli': 'G' };

/** A neutral 14px tile with the provider's initial; its tooltip carries the session details. */
export function OrchestratorGlyph({ orchestrator, details }: { orchestrator: string; details?: string }) {
  const all = useOrchestratorStore((s) => s.allOrchestrators);
  const name = getOrchestratorLabel(orchestrator, all);
  const letter = ORCH_GLYPH[orchestrator] ?? (name.charAt(0).toUpperCase() || '?');
  const tip = details ? `${name}\n${details}` : name;
  return (
    <span
      role="img"
      aria-label={name}
      title={tip}
      data-testid="pane-orchestrator"
      className="flex-shrink-0 w-3.5 h-3.5 rounded grid place-items-center bg-surface-0 text-ctp-overlay1 text-[8.5px] font-semibold leading-none"
    >
      {letter}
    </span>
  );
}

const QUIET = 'h-7 rounded-md flex items-center gap-1.5 text-xs text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text';

export interface PaneToggle {
  open: boolean;
  onToggle: () => void;
}

export interface AgentPaneToolbarProps {
  agent: Agent;
  /** The provider, when the session reports one; defaults to the agent's orchestrator. */
  orchestrator?: string | null;
  dot: AgentDot;
  /** What the agent is doing, after the status word ("3m · editing AgentRow.tsx"). */
  activity?: string;
  model?: string | null;
  /** Extra lines for the orchestrator glyph's tooltip: driver, version, branch, context, limits. */
  details?: string[];
  changes?: PaneToggle;
  /** The subagent map, with its count; only when the driver reports subagents. */
  agentMap?: PaneToggle & { count: number; panelId: string; toggleId: string };
  runtime?: { value: RuntimeView; onChange: (v: RuntimeView) => void; disabled?: boolean; tip?: ReactNode };
  /** Slot for the agent details toggle (#2032), before the menu. */
  detailsToggle?: ReactNode;
  /** The agent's actions for the overflow menu; empty hides it. */
  actions?: ActionDef[];
}

export function AgentPaneToolbar({ agent, orchestrator, dot, activity, model, details, changes, agentMap, runtime, detailsToggle, actions = [] }: AgentPaneToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(ref);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const shownModel = model && model !== 'default' ? model : null;
  const glyphDetails = [...(narrow && shownModel ? [`Model ${shownModel}`] : []), ...(details ?? [])].join('\n') || undefined;
  const menuActions = actions.filter((a) => a.visible);

  return (
    <div
      ref={ref}
      className="h-8 flex-shrink-0 flex items-center gap-2 pl-3.5 pr-1.5 border-b border-surface-0 bg-ctp-base text-xs text-ctp-overlay1 min-w-0"
      data-testid="agent-pane-toolbar"
      data-narrow={narrow || undefined}
    >
      <StatusDot dot={dot} />
      <span className="text-ctp-text flex-shrink-0" data-testid="pane-status">{DOT_LABEL[dot]}</span>
      {activity && <span className="min-w-0 truncate" data-testid="pane-activity" title={activity}>{activity}</span>}
      <span className="ml-auto flex-shrink-0 flex items-center gap-1">
        <OrchestratorGlyph orchestrator={orchestrator ?? agent.orchestrator ?? 'claude-code'} details={glyphDetails} />
        {shownModel && !narrow && <span className="ml-1 text-ctp-overlay1" data-testid="pane-model">{shownModel}</span>}
        {(changes || agentMap || runtime) && <span className="w-px h-4 bg-surface-0 mx-1" aria-hidden="true" />}
        {changes && (
          <button
            type="button"
            onClick={changes.onToggle}
            aria-pressed={changes.open}
            aria-label={narrow ? 'Changes' : undefined}
            title={narrow ? 'Changes' : undefined}
            className={`${QUIET} ${narrow ? 'w-7 justify-center' : 'px-2'} ${changes.open ? 'bg-surface-0 text-ctp-text' : ''}`}
            data-testid="chat-changes-toggle"
          >
            <DiffIcon />
            {!narrow && 'Changes'}
          </button>
        )}
        {agentMap && (
          <button
            type="button"
            id={agentMap.toggleId}
            onClick={agentMap.onToggle}
            aria-pressed={agentMap.open}
            aria-controls={agentMap.panelId}
            aria-expanded={agentMap.open}
            className={`${QUIET} px-2 tabular-nums ${agentMap.open ? 'bg-surface-0 text-ctp-text' : ''}`}
            data-testid="chat-agent-map-toggle"
          >
            Agents{agentMap.count ? ` ${agentMap.count}` : ''}
          </button>
        )}
        {runtime && (
          <span className="relative">
            <RuntimeSwitch value={runtime.value} onChange={runtime.onChange} disabled={runtime.disabled} compact={narrow} />
            {runtime.tip}
          </span>
        )}
        {detailsToggle}
        {menuActions.length > 0 && (
          <button
            type="button"
            aria-label={`More actions for ${agent.name}`}
            title="More actions"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu(menu ? null : { x: r.right - 160, y: r.bottom + 4 });
            }}
            className={`${QUIET} w-7 justify-center`}
            data-testid="pane-menu-button"
          >
            <MoreIcon />
          </button>
        )}
      </span>
      {menu && <AgentContextMenu actions={menuActions} position={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * The toolbar for an agent in the terminal runtime, fed from hook status: the
 * same bar the chat runtime shows, so switching runtimes keeps it in place.
 */
export function TerminalPaneToolbar({ agent, runtime, actions }: Pick<AgentPaneToolbarProps, 'agent' | 'runtime' | 'actions'>) {
  const detailed = useAgentStore((s) => s.agentDetailedStatus[agent.id]);
  const dot = agentDot(agent, detailed);
  const activity = agent.status === 'running' ? detailed?.message : agent.status === 'error' ? agent.errorMessage : undefined;
  return (
    <AgentPaneToolbar
      agent={agent}
      dot={dot}
      activity={activity || undefined}
      model={agent.model}
      details={agent.branch ? [`Branch ${agent.branch}`] : undefined}
      runtime={runtime}
      actions={actions}
    />
  );
}
