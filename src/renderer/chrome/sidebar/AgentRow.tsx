import { useRefocusAfterMove } from './useRefocusAfterMove';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { AgentAvatar } from '../../features/agents/AgentAvatar';
import { OrchestratorGlyph } from '../../features/agents/OrchestratorGlyph';
import { formatAgo } from '../../features/agents/states/format';
import { useAgentStore } from '../../stores/agentStore';
import { AgentContextMenu, OverflowIcon, useAgentRowActions, type ActionDef } from '../../features/agents/useAgentRowActions';
import { holdChromeSurface, reportChromeFeature, type ChromeSurface } from '../telemetry';
import { AgentHoverCard } from './AgentHoverCard';
import type { AgentDot } from './treeModel';
import { StatusDot } from '../../features/agents/agent-status';
import { Tooltip } from '../../components/Tooltip';

/**
 * One 30px agent row (docs/chrome-redesign-spec.md §2): status dot, 18px
 * avatar, name, neutral provider glyph, relative time and a short note. The details the old row showed
 * as chips are in a hover card, and the right-click menu is the legacy row's
 * (useAgentRowActions), with its `ctx-<id>` test ids. Keeps the legacy
 * `agent-item-<id>` test id (§9).
 */

/** How long a hover or keyboard focus waits before the card opens, and leaving before it closes. */
export const HOVER_OPEN_MS = 600;
const HOVER_CLOSE_MS = 150;

/** Actions that show the agent in the pane before they run (settings render there). */
const REVEAL_FIRST = new Set(['settings']);

/** While a popup is open it is where the user is (spec §8). */
function useSurfaceWhile(open: boolean, surface: ChromeSurface) {
  useEffect(() => (open ? holdChromeSurface(surface) : undefined), [open, surface]);
}

interface AgentRowProps {
  agent: Agent;
  dot: AgentDot;
  detailed?: AgentDetailedStatus;
  active: boolean;
  indent: number;
  /** For the worktree path in the hover card. */
  projectPath?: string;
  onSelect: (agent: Agent) => void;
  onOpenTerminal?: (agent: Agent) => void;
  /** Tree depth (§4.8): 2 under a project, 3 inside the sleeping fold. */
  level?: number;
  /** The tree key of the row's parent, for Left-arrow navigation. */
  parentKey?: string;
  /** New-shell-only actions appended to the menu, such as Move up / Move down. */
  extraActions?: ActionDef[];
  /** The sidebar filter's query, marked in the name. */
  highlight?: string;
  /** Drag-to-reorder handlers; absent when the row can't be reordered. */
  drag?: AgentDragHandlers;
  /** Shows the drop line above or below the row while a drag is over it. */
  dropEdge?: 'top' | 'bottom';
  /**
   * Helpers under this agent (#2231); the row gets a caret when there are any.
   * Folded, it is every helper below, at any depth, for the roll-up.
   */
  helperCount?: number;
  /** Whether the helpers are shown under the row. */
  helpersExpanded?: boolean;
  /** Helpers that need you or stopped with an error, for the folded roll-up. */
  helperNeeds?: number;
  /** Helpers working, for the folded roll-up. */
  helperWorking?: number;
  onToggleHelpers?: (agentId: string) => void;
}

const Caret = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** How far left of the status dot the caret starts; it lines up with the project chevron. */
export const CARET_OFFSET = 18;

/**
 * What a row with folded helpers shows in place of its time (#2231): the
 * helper count, with a small dot when any of them needs you (or errored) or
 * is working. The words for the dot are for screen readers.
 */
function HelperRollup({ id, count, needs, working }: { id: string; count: number; needs: number; working: number }) {
  const tone = needs > 0 ? 'bg-ctp-warning' : working > 0 ? 'bg-ctp-success' : null;
  return (
    <span id={id} data-testid="helper-rollup" className="flex items-center gap-1 text-ctp-overlay1 whitespace-nowrap">
      {tone && <span data-testid="helper-rollup-dot" className={`w-1.5 h-1.5 rounded-full ${tone}`} aria-hidden="true" />}
      {count} helper{count === 1 ? '' : 's'}
      {needs > 0 && <span className="sr-only">, {needs} {needs === 1 ? 'needs' : 'need'} you</span>}
      {working > 0 && <span className="sr-only">, {working} working</span>}
    </span>
  );
}

/** Drag handlers for a reorderable agent row, keyed by agent id so one set serves every row. */
export interface AgentDragHandlers {
  onDragStart: (e: React.DragEvent, agentId: string) => void;
  onDragOver: (e: React.DragEvent, agentId: string) => void;
  onDrop: (e: React.DragEvent, agentId: string) => void;
  onDragEnd: () => void;
  /** Clears the drop line when the drag leaves the row. */
  onDragLeave?: (e: React.DragEvent, agentId: string) => void;
}

/** `text` with the first case-insensitive match of `query` marked, as the sidebar filter shows it. */
export function MarkedText({ text, query }: { text: string; query?: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (!query || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent text-ctp-text font-bold underline underline-offset-2">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/** Update the relative label even when no new agent event arrives. */
function ActivityTime({ at, label }: { at: number; label: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [at]);
  const ago = formatAgo(at, now);
  return <time dateTime={new Date(at).toISOString()} aria-label={`${label}: ${ago}`} className="text-ctp-overlay1 tabular-nums whitespace-nowrap">{ago}</time>;
}

export const AgentRow = React.memo(function AgentRow({
  agent, dot, detailed, active, indent, projectPath, onSelect, onOpenTerminal, level = 2, parentKey, extraActions, highlight, drag, dropEdge,
  helperCount = 0, helpersExpanded = true, helperNeeds = 0, helperWorking = 0, onToggleHelpers,
}: AgentRowProps) {
  // A durable agent being created (#2226) can take up to a minute while its worktree is made.
  const couldntStart = !!agent.creationFailed && agent.status === 'error';
  const note = couldntStart ? "couldn't start"
    : dot === 'needs' ? 'needs you'
      : dot === 'error' ? 'error'
        : agent.status === 'creating' ? 'starting'
          : agent.kind === 'quick' ? 'quick' : '';
  const hasHelpers = helperCount > 0;
  const folded = hasHelpers && !helpersExpanded;
  // The row's name is the agent's; the note and a folded roll-up describe it,
  // since the name hides the text inside the row from screen readers.
  const noteId = useId();
  const rollupId = useId();
  const describedBy = [note && noteId, folded && rollupId].filter(Boolean).join(' ') || undefined;
  const spawnedAt = useAgentStore((s) => s.agentSpawnedAt[agent.id]);
  const sleeping = agent.status === 'sleeping';
  const activityAt = sleeping ? Date.parse(agent.lastSleep?.at ?? '') : detailed?.timestamp ?? spawnedAt;
  // A folded parent shows its helpers' roll-up in place of its own time.
  const hasActivityTime = !folded && activityAt !== undefined && Number.isFinite(activityAt);
  const timeLabel = sleeping ? 'Sleeping since' : detailed ? 'Last activity' : 'Started';
  const rowRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rowActions = useAgentRowActions(agent);
  const actions = extraActions?.length ? [...rowActions, ...extraActions] : rowActions;
  const canMove = !!extraActions?.some((a) => a.id === 'move-up' || a.id === 'move-down');
  const armRefocus = useRefocusAfterMove();

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [card, setCard] = useState<DOMRect | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSurfaceWhile(menu !== null, 'row_menu');
  useSurfaceWhile(card !== null, 'hover_card');

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  const scheduleOpen = useCallback(() => {
    clearTimers();
    openTimer.current = setTimeout(() => {
      if (rowRef.current) setCard(rowRef.current.getBoundingClientRect());
    }, HOVER_OPEN_MS);
  }, []);
  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => setCard(null), HOVER_CLOSE_MS);
  }, []);
  const keepOpen = useCallback(() => clearTimers(), []);
  /** Focus leaving the row or the card closes it, unless it moved between the two. */
  const onBlurOut = useCallback((e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && (rowRef.current?.contains(next) || cardRef.current?.contains(next))) return;
    scheduleClose();
  }, [scheduleClose]);

  const openMenuAt = (x: number, y: number) => {
    clearTimers();
    setCard(null);
    setMenu({ x, y });
    reportChromeFeature('row_menu_open');
  };

  const run = (action: ActionDef, from: 'menu' | 'card') => {
    if (REVEAL_FIRST.has(action.id)) onSelect(agent);
    action.handler();
    if (from === 'card') {
      setCard(null);
      reportChromeFeature('hover_card_action');
    }
  };
  const menuActions = actions.map((a) => ({ ...a, handler: () => run(a, 'menu') }));

  // The wrapper keeps the legacy test ids and takes clicks; the treeitem inside
  // is the focusable, announced row (ProjectTree owns its tabindex), and the overflow button sits beside it
  // rather than inside it, so no interactive element is nested in another.
  return (
    <>
      <div
        ref={rowRef}
        data-testid={`agent-item-${agent.id}`}
        data-agent-id={agent.id}
        data-agent-name={agent.name}
        data-active={active}
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelect(agent)}
        onContextMenu={(e) => { e.preventDefault(); openMenuAt(e.clientX, e.clientY); }}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        draggable={drag ? true : undefined}
        onDragStart={drag ? (e) => { clearTimers(); setCard(null); drag.onDragStart(e, agent.id); } : undefined}
        onDragOver={drag ? (e) => drag.onDragOver(e, agent.id) : undefined}
        onDrop={drag ? (e) => drag.onDrop(e, agent.id) : undefined}
        onDragEnd={drag?.onDragEnd}
        onDragLeave={drag?.onDragLeave ? (e) => {
          // Moving onto a child of the row isn't leaving it.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) drag.onDragLeave!(e, agent.id);
        } : undefined}
        className={`group/row relative w-full h-[30px] flex-shrink-0 rounded-md flex items-center cursor-pointer transition-colors duration-100 ${
          active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text'
        }`}
      >
        {dropEdge && (
          <div
            data-testid="agent-drop-indicator"
            className={`absolute left-2 right-2 h-0.5 rounded-full bg-ctp-accent pointer-events-none ${dropEdge === 'top' ? '-top-px' : '-bottom-px'}`}
          />
        )}
        <div
          role="treeitem"
          aria-level={level}
          aria-selected={active}
          aria-expanded={hasHelpers ? helpersExpanded : undefined}
          aria-label={agent.name}
          aria-describedby={describedBy}
          data-tree-key={`agent:${agent.id}`}
          aria-keyshortcuts={canMove ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
          data-tree-parent={parentKey}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(agent); }
            else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              // Alt+Up / Alt+Down: Move up / Move down, the keyboard equivalent of dragging.
              e.preventDefault();
              e.stopPropagation();
              const move = extraActions?.find((a) => a.id === (e.key === 'ArrowUp' ? 'move-up' : 'move-down'));
              if (move) { armRefocus(e.currentTarget); move.handler(); }
            } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              openMenuAt(r.left + 24, r.bottom);
            } else if (e.key === 'Escape' && card) { e.stopPropagation(); setCard(null); }
          }}
          onFocus={scheduleOpen}
          onBlur={onBlurOut}
          style={{ paddingLeft: indent }}
          className="relative min-w-0 flex-1 h-full pr-1 rounded-md flex items-center gap-2 text-[13px] text-left focus-ring"
        >
          {hasHelpers && (
            <button
              type="button"
              tabIndex={-1}
              data-tree-toggle
              data-testid={`helpers-toggle-${agent.id}`}
              aria-label={helpersExpanded ? `Hide helpers of ${agent.name}` : `Show helpers of ${agent.name}`}
              // Keep focus on the row: the caret is part of it, not a stop of its own.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget.closest<HTMLElement>('[role="treeitem"]')?.focus();
                onToggleHelpers?.(agent.id);
              }}
              style={{ left: indent - CARET_OFFSET }}
              className="absolute top-0 h-full w-4 flex items-center justify-center text-ctp-overlay1 hover:text-ctp-text cursor-pointer"
            >
              <Caret open={helpersExpanded} />
            </button>
          )}
          <StatusDot dot={dot} />
          <span className="relative flex-shrink-0">
            <AgentAvatar agent={agent} size="2xs" />
            {agent.freeAgentMode && (
              <span
                role="img"
                aria-label="Free Agent Mode: all permissions bypassed"
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-ctp-error ring-1 ring-ctp-mantle"
              />
            )}
          </span>
          <span className={`truncate ${dot === 'sleeping' ? '' : 'font-medium'}`}><MarkedText text={agent.name} query={highlight} /></span>
          <OrchestratorGlyph orchestrator={agent.orchestrator || 'claude-code'} focusable={false} showTooltip={false} variant="row" />
          {(note || hasActivityTime || folded) && (
            <span className="ml-auto flex-shrink-0 flex items-center gap-2 text-xs group-hover/row:hidden">
              {note && <span id={noteId} data-testid="agent-row-note" className={dot === 'needs' ? 'text-ctp-warning' : dot === 'error' ? 'text-ctp-error' : 'text-ctp-overlay1'}>{note}</span>}
              {folded && <HelperRollup id={rollupId} count={helperCount} needs={helperNeeds} working={helperWorking} />}
              {hasActivityTime && <ActivityTime at={activityAt} label={timeLabel} />}
            </span>
          )}
        </div>
        {actions.length > 0 && (
          <Tooltip content="More actions">
          <button
            type="button"
            tabIndex={-1}
            data-testid="action-overflow"
            aria-label={`More actions for ${agent.name}`}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              openMenuAt(r.right, r.bottom);
            }}
            className="mr-1 flex-shrink-0 w-6 h-6 rounded hidden group-hover/row:flex items-center justify-center text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text cursor-pointer"
          >
            <OverflowIcon />
          </button>
          </Tooltip>
        )}
      </div>
      {menu && <AgentContextMenu actions={menuActions} position={menu} onClose={() => setMenu(null)} />}
      {card && !menu && (
        <AgentHoverCard
          ref={cardRef}
          agent={agent}
          dot={dot}
          detailed={detailed}
          projectPath={projectPath}
          anchor={card}
          actions={actions}
          onOpenTerminal={onOpenTerminal ? () => { setCard(null); onOpenTerminal(agent); reportChromeFeature('hover_card_action'); } : undefined}
          onAction={(action) => run(action, 'card')}
          onMouseEnter={keepOpen}
          onMouseLeave={scheduleClose}
          onFocus={keepOpen}
          onBlur={onBlurOut}
        />
      )}
    </>
  );
});
