import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { PluginContext, PluginAPI, PluginModule, AgentInfo, PluginAgentDetailedStatus } from '../../../../shared/plugin-types';
import { isRemoteAgentId } from '../../../stores/remoteProjectStore';

// ── Activate / Deactivate ──────────────────────────────────────────────

let navigatePrev: (() => void) | null = null;
let navigateNext: (() => void) | null = null;

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const prevDisp = api.commands.register('review-prev', () => navigatePrev?.());
  const nextDisp = api.commands.register('review-next', () => navigateNext?.());
  ctx.subscriptions.push(prevDisp, nextDisp);
}

export function deactivate(): void {
  navigatePrev = null;
  navigateNext = null;
}

// ── Helpers ────────────────────────────────────────────────────────────

export function filterAgents(agents: AgentInfo[], includeSleeping: boolean): AgentInfo[] {
  if (includeSleeping) return agents;
  return agents.filter((a) => a.status !== 'sleeping');
}

export function filterNeedsAttention(
  agents: AgentInfo[],
  detailedStatuses: Map<string, PluginAgentDetailedStatus | null>,
): AgentInfo[] {
  return agents.filter((a) => {
    if (a.status === 'error') return true;
    const d = detailedStatuses.get(a.id);
    return d?.state === 'needs_permission' || d?.state === 'tool_error';
  });
}

export function filterRemoteAgents(agents: AgentInfo[], includeRemote: boolean): AgentInfo[] {
  if (includeRemote) return agents;
  return agents.filter((a) => !isRemoteAgentId(a.id));
}

export function resolveIndex(current: number, length: number, delta: -1 | 1): number {
  if (length === 0) return 0;
  return (current + delta + length) % length;
}

// ── Arrow Button ───────────────────────────────────────────────────────

function ArrowButton({ direction, onClick }: { direction: 'left' | 'right'; onClick: () => void }) {
  const isLeft = direction === 'left';
  const path = isLeft ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6';
  return React.createElement('button', {
    onClick,
    'aria-label': isLeft ? 'Previous agent' : 'Next agent',
    className: [
      'absolute top-1/2 -translate-y-1/2 z-10',
      isLeft ? 'left-3' : 'right-3',
      'w-10 h-10 rounded-full',
      'bg-surface-0/80 hover:bg-surface-1 backdrop-blur-sm',
      'flex items-center justify-center',
      'text-ctp-text transition-colors cursor-pointer',
    ].join(' '),
  },
    React.createElement('svg', {
      width: 20, height: 20, viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', strokeWidth: 2,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    },
      React.createElement('path', { d: path }),
    ),
  );
}

// ── Jump List Button ──────────────────────────────────────────────────

function JumpListButton({
  agents,
  currentIndex,
  AgentAvatar,
  onJumpTo,
}: {
  agents: AgentInfo[];
  currentIndex: number;
  AgentAvatar: React.ComponentType<{ agentId: string; size?: 'sm' | 'md'; showStatusRing?: boolean }>;
  onJumpTo: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return React.createElement('div', { ref: containerRef, className: 'relative' },
    // Hamburger button
    React.createElement('button', {
      onClick: () => setOpen((v) => !v),
      'aria-label': 'Agent list',
      'data-testid': 'review-jump-list-button',
      className: [
        'p-1 rounded transition-colors cursor-pointer',
        open
          ? 'bg-surface-1 text-ctp-text'
          : 'text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-1',
      ].join(' '),
    },
      React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round',
      },
        React.createElement('line', { x1: 3, y1: 6, x2: 21, y2: 6 }),
        React.createElement('line', { x1: 3, y1: 12, x2: 21, y2: 12 }),
        React.createElement('line', { x1: 3, y1: 18, x2: 21, y2: 18 }),
      ),
    ),

    // Dropdown
    open && React.createElement('div', {
      className: [
        'absolute top-full right-0 mt-1 z-30',
        'min-w-[200px] max-h-[320px] overflow-y-auto',
        'rounded-lg bg-surface-0/95 backdrop-blur-sm shadow-lg border border-surface-2',
        'py-1',
      ].join(' '),
    },
      agents.length === 0
        ? React.createElement('div', {
            className: 'px-3 py-2 text-xs text-ctp-subtext0',
          }, 'No agents')
        : agents.map((agent, idx) =>
            React.createElement('button', {
              key: agent.id,
              onClick: () => { onJumpTo(idx); setOpen(false); },
              className: [
                'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors cursor-pointer',
                idx === currentIndex
                  ? 'bg-surface-1 text-ctp-text'
                  : 'text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text',
              ].join(' '),
            },
              React.createElement(AgentAvatar, { agentId: agent.id, size: 'sm', showStatusRing: true }),
              React.createElement('span', { className: 'truncate font-medium' }, agent.name),
              React.createElement('span', { className: 'ml-auto text-ctp-subtext0 shrink-0' },
                isRemoteAgentId(agent.id) ? 'remote' : agent.status,
              ),
            ),
          ),
    ),
  );
}

// ── Floating Top Bar ───────────────────────────────────────────────────

function FloatingBar({
  currentIndex,
  total,
  agentId,
  agentName,
  agentStatus,
  detailedState,
  AgentAvatar,
  isRunning,
  onSleep,
  includeSleeping,
  onToggleSleeping,
  needsAttentionOnly,
  onToggleNeedsAttention,
  includeRemote,
  onToggleIncludeRemote,
  agents,
  onJumpTo,
  onPrev,
  onNext,
}: {
  currentIndex: number;
  total: number;
  agentId: string | null;
  agentName: string;
  agentStatus: string;
  detailedState: string | null;
  AgentAvatar: React.ComponentType<{ agentId: string; size?: 'sm' | 'md'; showStatusRing?: boolean }>;
  isRunning: boolean;
  onSleep: () => void;
  includeSleeping: boolean;
  onToggleSleeping: () => void;
  needsAttentionOnly: boolean;
  onToggleNeedsAttention: () => void;
  includeRemote: boolean;
  onToggleIncludeRemote: () => void;
  agents: AgentInfo[];
  onJumpTo: (index: number) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const chevronLeft = React.createElement('path', { d: 'M15 18l-6-6 6-6' });
  const chevronRight = React.createElement('path', { d: 'M9 18l6-6-6-6' });

  const makeMiniArrow = (d: React.ReactElement, label: string, handler: () => void) =>
    React.createElement('button', {
      onClick: handler,
      'aria-label': label,
      className: 'p-1 rounded hover:bg-surface-1 text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer',
    },
      React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }, d),
    );

  const statusText = detailedState ?? agentStatus;

  return React.createElement('div', {
    className: [
      'absolute top-3 left-1/2 -translate-x-1/2 z-20',
      'flex items-center gap-2 px-3 py-1.5 rounded-lg',
      'bg-surface-0/90 backdrop-blur-sm shadow-lg',
      'text-xs text-ctp-text select-none',
    ].join(' '),
  },
    // Left arrow
    makeMiniArrow(chevronLeft, 'Previous agent', onPrev),

    // Agent info with avatar
    React.createElement('span', { className: 'flex items-center gap-1.5' },
      agentId
        ? React.createElement(AgentAvatar, { agentId, size: 'sm', showStatusRing: true })
        : null,
      React.createElement('span', { className: 'font-medium' }, agentName),
      React.createElement('span', { className: 'text-ctp-subtext0' },
        `(${statusText})`,
      ),
      React.createElement('span', { className: 'text-ctp-subtext0' },
        `${total > 0 ? currentIndex + 1 : 0} of ${total}`,
      ),
    ),

    // Sleep button (moon icon) — only visible when agent is running
    isRunning && React.createElement('button', {
      onClick: onSleep,
      title: 'Sleep agent',
      'aria-label': 'Sleep agent',
      'data-testid': 'review-sleep-button',
      className: 'p-1 rounded hover:bg-blue-500/20 text-ctp-subtext0 hover:text-blue-400 transition-colors cursor-pointer',
    },
      React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round',
      },
        React.createElement('path', { d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' }),
      ),
    ),

    // Right arrow
    makeMiniArrow(chevronRight, 'Next agent', onNext),

    // Separator
    React.createElement('div', { className: 'w-px h-4 bg-surface-2 mx-1' }),

    // Include sleeping checkbox
    React.createElement('label', {
      className: 'flex items-center gap-1.5 text-ctp-subtext0 hover:text-ctp-text cursor-pointer transition-colors',
    },
      React.createElement('input', {
        type: 'checkbox',
        checked: includeSleeping,
        onChange: onToggleSleeping,
        className: 'accent-ctp-accent cursor-pointer',
      }),
      'Include sleeping',
    ),

    // Separator
    React.createElement('div', { className: 'w-px h-4 bg-surface-2 mx-1' }),

    // Needs attention checkbox
    React.createElement('label', {
      className: 'flex items-center gap-1.5 text-ctp-subtext0 hover:text-ctp-text cursor-pointer transition-colors',
    },
      React.createElement('input', {
        type: 'checkbox',
        checked: needsAttentionOnly,
        onChange: onToggleNeedsAttention,
        className: 'accent-ctp-accent cursor-pointer',
      }),
      'Needs attention',
    ),

    // Separator
    React.createElement('div', { className: 'w-px h-4 bg-surface-2 mx-1' }),

    // Include remote checkbox
    React.createElement('label', {
      className: 'flex items-center gap-1.5 text-ctp-subtext0 hover:text-ctp-text cursor-pointer transition-colors',
    },
      React.createElement('input', {
        type: 'checkbox',
        checked: includeRemote,
        onChange: onToggleIncludeRemote,
        className: 'accent-ctp-accent cursor-pointer',
      }),
      'Include remote',
    ),

    // Separator
    React.createElement('div', { className: 'w-px h-4 bg-surface-2 mx-1' }),

    // Hamburger jump-list button
    React.createElement(JumpListButton, { agents, currentIndex, AgentAvatar, onJumpTo }),
  );
}

// ── Empty State ────────────────────────────────────────────────────────

function EmptyState({ includeSleeping }: { includeSleeping: boolean }) {
  return React.createElement('div', {
    className: 'flex flex-col items-center justify-center h-full w-full text-ctp-subtext0 gap-2',
  },
    React.createElement('svg', {
      width: 48, height: 48, viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
      strokeLinecap: 'round', strokeLinejoin: 'round',
      className: 'opacity-40',
    },
      React.createElement('rect', { x: 4, y: 6, width: 12, height: 14, rx: 2 }),
      React.createElement('rect', { x: 6, y: 4, width: 12, height: 14, rx: 2, transform: 'rotate(12 12 11)' }),
    ),
    React.createElement('span', { className: 'text-sm' },
      includeSleeping
        ? 'No agents running'
        : 'No active agents — enable "Include sleeping" to see more',
    ),
  );
}

// ── Slide Container ────────────────────────────────────────────────────

type SlideDirection = 'left' | 'right' | null;

function SlideContainer({
  agentId,
  slideDirection,
  onTransitionEnd,
  children,
}: {
  agentId: string;
  slideDirection: SlideDirection;
  onTransitionEnd: () => void;
  children?: React.ReactNode;
}) {
  // Phase 1: entering = new content slides in from the edge
  // We start off-screen, then transition to center
  const [phase, setPhase] = useState<'entering' | 'settled'>('settled');
  const prevAgentId = useRef(agentId);

  useEffect(() => {
    if (agentId !== prevAgentId.current && slideDirection) {
      setPhase('entering');
      prevAgentId.current = agentId;
      // Force a layout read so the browser applies the initial transform
      // before we transition to the settled position
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setPhase('settled');
        });
      });
    } else {
      prevAgentId.current = agentId;
    }
  }, [agentId, slideDirection]);

  const handleTransitionEnd = useCallback(() => {
    onTransitionEnd();
  }, [onTransitionEnd]);

  let transform = 'translateX(0)';
  let transition = 'transform 300ms ease-in-out';
  if (phase === 'entering' && slideDirection) {
    transform = slideDirection === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
    transition = 'none';
  }

  return React.createElement('div', {
    style: { transform, transition, width: '100%', height: '100%' },
    onTransitionEnd: handleTransitionEnd,
  }, children);
}

// ── Main Panel ─────────────────────────────────────────────────────────

export function MainPanel({ api }: { api: PluginAPI }) {
  const isAppMode = api.context.mode === 'app';

  // Agent reactivity
  const [agentTick, setAgentTick] = useState(0);
  useEffect(() => {
    const sub = api.agents.onAnyChange(() => setAgentTick((n) => n + 1));
    return () => sub.dispose();
  }, [api]);

  // Settings
  const settingValue = api.settings.get<boolean>('include-sleeping');
  const [includeSleeping, setIncludeSleeping] = useState(settingValue ?? true);
  const needsAttentionSettingValue = api.settings.get<boolean>('needs-attention-only');
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(needsAttentionSettingValue ?? false);
  const includeRemoteSettingValue = api.settings.get<boolean>('include-remote');
  const [includeRemote, setIncludeRemote] = useState(includeRemoteSettingValue ?? true);
  useEffect(() => {
    const sub = api.settings.onChange((key, value) => {
      if (key === 'include-sleeping') setIncludeSleeping(value as boolean);
      if (key === 'needs-attention-only') setNeedsAttentionOnly(value as boolean);
      if (key === 'include-remote') setIncludeRemote(value as boolean);
    });
    return () => sub.dispose();
  }, [api]);

  // Compute agent list
  const allAgents = useMemo(() => {
    const agents = api.agents.list();
    if (isAppMode) return agents;
    return agents.filter((a) => a.projectId === api.context.projectId);
  }, [api, isAppMode, agentTick]);

  // Build detailed status map for all agents
  const detailedStatuses = useMemo(() => {
    const map = new Map<string, PluginAgentDetailedStatus | null>();
    for (const a of allAgents) {
      map.set(a.id, api.agents.getDetailedStatus(a.id));
    }
    return map;
  }, [api, allAgents, agentTick]);

  const agents = useMemo(() => {
    let filtered = filterAgents(allAgents, includeSleeping);
    filtered = filterRemoteAgents(filtered, includeRemote);
    if (needsAttentionOnly) {
      filtered = filterNeedsAttention(filtered, detailedStatuses);
    }
    return filtered;
  }, [allAgents, includeSleeping, includeRemote, needsAttentionOnly, detailedStatuses]);

  // Navigation state
  const [currentIndex, setCurrentIndex] = useState(0);
  const [slideDirection, setSlideDirection] = useState<SlideDirection>(null);

  // Clamp index when agent list changes
  useEffect(() => {
    setCurrentIndex((prev) => {
      if (agents.length === 0) return 0;
      return Math.min(prev, agents.length - 1);
    });
  }, [agents.length]);

  const goTo = useCallback((delta: -1 | 1) => {
    if (agents.length <= 1) return;
    setSlideDirection(delta === 1 ? 'right' : 'left');
    setCurrentIndex((prev) => resolveIndex(prev, agents.length, delta));
  }, [agents.length]);

  const goPrev = useCallback(() => goTo(-1), [goTo]);
  const goNext = useCallback(() => goTo(1), [goTo]);

  // Wire up global commands
  useEffect(() => {
    navigatePrev = goPrev;
    navigateNext = goNext;
    return () => {
      navigatePrev = null;
      navigateNext = null;
    };
  }, [goPrev, goNext]);

  const clearSlide = useCallback(() => setSlideDirection(null), []);

  // Dynamic title
  const currentAgent = agents[currentIndex] ?? null;
  useEffect(() => {
    if (currentAgent) {
      api.window.setTitle(`Review — ${currentAgent.name}`);
    } else {
      api.window.resetTitle();
    }
  }, [api, currentAgent?.name]);

  const handleToggleSleeping = useCallback(() => {
    const next = !includeSleeping;
    setIncludeSleeping(next);
    api.settings.set('include-sleeping', next);
  }, [includeSleeping, api]);

  const handleToggleNeedsAttention = useCallback(() => {
    const next = !needsAttentionOnly;
    setNeedsAttentionOnly(next);
    api.settings.set('needs-attention-only', next);
  }, [needsAttentionOnly, api]);

  const handleToggleIncludeRemote = useCallback(() => {
    const next = !includeRemote;
    setIncludeRemote(next);
    api.settings.set('include-remote', next);
  }, [includeRemote, api]);

  const jumpTo = useCallback((index: number) => {
    if (index >= 0 && index < agents.length) {
      setSlideDirection(null);
      setCurrentIndex(index);
    }
  }, [agents.length]);

  const handleSleep = useCallback(() => {
    const agent = agents[currentIndex];
    if (agent) api.agents.kill(agent.id);
  }, [agents, currentIndex, api]);

  // Render
  if (agents.length === 0) {
    return React.createElement('div', { className: 'relative h-full w-full' },
      React.createElement(FloatingBar, {
        currentIndex: 0,
        total: 0,
        agentId: null,
        agentName: '—',
        agentStatus: '',
        detailedState: null,
        AgentAvatar: api.widgets.AgentAvatar,
        isRunning: false,
        onSleep: handleSleep,
        includeSleeping,
        onToggleSleeping: handleToggleSleeping,
        needsAttentionOnly,
        onToggleNeedsAttention: handleToggleNeedsAttention,
        includeRemote,
        onToggleIncludeRemote: handleToggleIncludeRemote,
        agents: [],
        onJumpTo: jumpTo,
        onPrev: goPrev,
        onNext: goNext,
      }),
      React.createElement(EmptyState, { includeSleeping }),
    );
  }

  const agent = agents[currentIndex];
  const AgentTerminal = api.widgets.AgentTerminal;
  const SleepingAgent = api.widgets.SleepingAgent;
  const currentDetailedStatus = detailedStatuses.get(agent.id) ?? null;
  const detailedStateLabel = currentDetailedStatus?.state === 'needs_permission'
    ? 'Needs permission'
    : currentDetailedStatus?.state === 'tool_error'
      ? 'Tool error'
      : null;

  const agentView = agent.status === 'sleeping'
    ? React.createElement(SleepingAgent, { agentId: agent.id })
    : React.createElement(AgentTerminal, { agentId: agent.id, focused: true });

  return React.createElement('div', { className: 'relative h-full w-full overflow-hidden' },
    // Floating top bar
    React.createElement(FloatingBar, {
      currentIndex,
      total: agents.length,
      agentId: agent.id,
      agentName: agent.name,
      agentStatus: agent.status,
      detailedState: detailedStateLabel,
      AgentAvatar: api.widgets.AgentAvatar,
      isRunning: agent.status === 'running',
      onSleep: handleSleep,
      includeSleeping,
      onToggleSleeping: handleToggleSleeping,
      needsAttentionOnly,
      onToggleNeedsAttention: handleToggleNeedsAttention,
      includeRemote,
      onToggleIncludeRemote: handleToggleIncludeRemote,
      agents,
      onJumpTo: jumpTo,
      onPrev: goPrev,
      onNext: goNext,
    }),

    // Side arrows
    agents.length > 1 && React.createElement(ArrowButton, { direction: 'left', onClick: goPrev }),
    agents.length > 1 && React.createElement(ArrowButton, { direction: 'right', onClick: goNext }),

    // Slide container with agent view
    React.createElement(SlideContainer, {
      agentId: agent.id,
      slideDirection,
      onTransitionEnd: clearSlide,
    },
      React.createElement('div', { className: 'h-full w-full' }, agentView),
    ),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
