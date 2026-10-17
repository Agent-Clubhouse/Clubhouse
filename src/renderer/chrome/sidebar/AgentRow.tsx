import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { AgentAvatar } from '../../features/agents/AgentAvatar';
import { AgentContextMenu, OverflowIcon, useAgentRowActions, type ActionDef } from '../../features/agents/useAgentRowActions';
import { getChromeSurface, reportChromeFeature, reportChromeSurface, type ChromeSurface } from '../telemetry';
import { AgentHoverCard } from './AgentHoverCard';
import type { AgentDot } from './treeModel';

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

/** While a popup is open it is where the user is (spec §8); restore the previous surface after. */
function useSurfaceWhile(open: boolean, surface: ChromeSurface) {
  useEffect(() => {
    if (!open) return;
    const previous = getChromeSurface();
    reportChromeSurface(surface);
    return () => reportChromeSurface(previous);
  }, [open, surface]);
}

const DOT_CLASS: Record<AgentDot, string> = {
  working: 'bg-ctp-success',
  idle: 'bg-ctp-info',
  needs: 'bg-ctp-warning',
  error: 'bg-ctp-error',
  sleeping: 'border border-ctp-overlay0',
  starting: 'border border-ctp-info',
};

const DOT_LABEL: Record<AgentDot, string> = {
  working: 'Working',
  idle: 'Idle',
  needs: 'Needs you',
  error: 'Error',
  sleeping: 'Sleeping',
  starting: 'Starting',
};

export function StatusDot({ dot }: { dot: AgentDot }) {
  return (
    <span
      className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT_CLASS[dot]}`}
      role="img"
      aria-label={DOT_LABEL[dot]}
      title={DOT_LABEL[dot]}
    />
  );
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
}

export const AgentRow = React.memo(function AgentRow({ agent, dot, detailed, active, indent, projectPath, onSelect, onOpenTerminal }: AgentRowProps) {
  const note = dot === 'needs' ? 'needs you' : dot === 'error' ? 'error' : agent.kind === 'quick' ? 'quick' : '';
  const rowRef = useRef<HTMLDivElement>(null);
  const actions = useAgentRowActions(agent);

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

  return (
    <>
      <div
        ref={rowRef}
        data-testid={`agent-item-${agent.id}`}
        data-agent-id={agent.id}
        data-agent-name={agent.name}
        data-active={active}
        aria-current={active ? 'true' : undefined}
        aria-label={agent.name}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(agent)}
        onContextMenu={(e) => { e.preventDefault(); openMenuAt(e.clientX, e.clientY); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(agent); }
          else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            openMenuAt(r.left + 24, r.bottom);
          } else if (e.key === 'Escape' && card) { e.stopPropagation(); setCard(null); }
        }}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
        style={{ paddingLeft: indent }}
        className={`group/row w-full h-[30px] flex-shrink-0 pr-1 rounded-md flex items-center gap-2 text-[13px] text-left cursor-pointer transition-colors duration-100 focus-ring ${
          active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text'
        }`}
      >
        <StatusDot dot={dot} />
        <span className="relative flex-shrink-0">
          <AgentAvatar agent={agent} size="2xs" />
          {agent.freeAgentMode && (
            <span
              role="img"
              aria-label="Free Agent Mode: all permissions bypassed"
              className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-ctp-error ring-1 ring-ctp-mantle"
              title="Free Agent Mode: all permissions bypassed"
            />
          )}
        </span>
        <span className={`truncate ${dot === 'sleeping' ? '' : 'font-medium'}`}>{agent.name}</span>
        {note && (
          <span className={`ml-auto flex-shrink-0 text-xs group-hover/row:hidden ${dot === 'needs' ? 'text-ctp-warning' : dot === 'error' ? 'text-ctp-error' : 'text-ctp-overlay1'}`}>
            {note}
          </span>
        )}
        {actions.length > 0 && (
          <button
            type="button"
            tabIndex={-1}
            data-testid="action-overflow"
            title="More actions"
            aria-label={`More actions for ${agent.name}`}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              openMenuAt(r.right, r.bottom);
            }}
            className="ml-auto flex-shrink-0 w-6 h-6 rounded hidden group-hover/row:flex items-center justify-center text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text cursor-pointer"
          >
            <OverflowIcon />
          </button>
        )}
      </div>
      {menu && <AgentContextMenu actions={menuActions} position={menu} onClose={() => setMenu(null)} />}
      {card && !menu && (
        <AgentHoverCard
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
        />
      )}
    </>
  );
});
