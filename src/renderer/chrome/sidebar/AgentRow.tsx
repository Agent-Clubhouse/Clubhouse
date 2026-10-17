import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { AgentAvatar } from '../../features/agents/AgentAvatar';
import { AgentContextMenu, OverflowIcon, useAgentRowActions, type ActionDef } from '../../features/agents/useAgentRowActions';
import { holdChromeSurface, reportChromeFeature, type ChromeSurface } from '../telemetry';
import { AgentHoverCard } from './AgentHoverCard';
import type { AgentDot } from './treeModel';
import { StatusDot } from '../../features/agents/agent-status';
import { Tooltip } from '../../components/Tooltip';

/**
 * One 30px agent row (docs/chrome-redesign-spec.md §2): status dot, 18px
 * avatar, name, then a short right-aligned note. The details the old row showed
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
}

export const AgentRow = React.memo(function AgentRow({ agent, dot, detailed, active, indent, projectPath, onSelect, onOpenTerminal, level = 2, parentKey, extraActions }: AgentRowProps) {
  const note = dot === 'needs' ? 'needs you' : dot === 'error' ? 'error' : agent.kind === 'quick' ? 'quick' : '';
  const rowRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rowActions = useAgentRowActions(agent);
  const actions = extraActions?.length ? [...rowActions, ...extraActions] : rowActions;

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
        className={`group/row relative w-full h-[30px] flex-shrink-0 rounded-md flex items-center cursor-pointer transition-colors duration-100 ${
          active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text'
        }`}
      >
        <div
          role="treeitem"
          aria-level={level}
          aria-selected={active}
          aria-label={agent.name}
          data-tree-key={`agent:${agent.id}`}
          data-tree-parent={parentKey}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(agent); }
            else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              openMenuAt(r.left + 24, r.bottom);
            } else if (e.key === 'Escape' && card) { e.stopPropagation(); setCard(null); }
          }}
          onFocus={scheduleOpen}
          onBlur={onBlurOut}
          style={{ paddingLeft: indent }}
          className="min-w-0 flex-1 h-full pr-1 rounded-md flex items-center gap-2 text-[13px] text-left focus-ring"
        >
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
          <span className={`truncate ${dot === 'sleeping' ? '' : 'font-medium'}`}>{agent.name}</span>
          {note && (
            <span className={`ml-auto flex-shrink-0 text-xs group-hover/row:hidden ${dot === 'needs' ? 'text-ctp-warning' : dot === 'error' ? 'text-ctp-error' : 'text-ctp-overlay1'}`}>
              {note}
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
