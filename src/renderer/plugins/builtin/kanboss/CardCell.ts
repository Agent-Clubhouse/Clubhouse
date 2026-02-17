import React, { useState, useCallback, useRef } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { Card, BoardState } from './types';
import { PRIORITY_CONFIG } from './types';
import { kanBossState } from './state';

const MAX_VISIBLE = 5;

// Priority sort order: critical first, none last
const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

// Check if a card is currently stuck (most recent stuck/moved wins)
function isCardStuck(card: Card): boolean {
  for (let i = card.history.length - 1; i >= 0; i--) {
    if (card.history[i].action === 'automation-stuck') return true;
    if (card.history[i].action === 'moved') return false;
  }
  return false;
}

interface CardCellProps {
  api: PluginAPI;
  cards: Card[];
  stateId: string;
  swimlaneId: string;
  isLastState: boolean;
  allStates: BoardState[];
  onMoveCard: (cardId: string, targetStateId: string, targetSwimlaneId?: string) => void;
  onDeleteCard: (cardId: string) => void;
  onClearRetries: (cardId: string) => void;
  onManualAdvance: (cardId: string) => void;
}

// ── Move dropdown ───────────────────────────────────────────────────────

function MoveButton({ card, allStates, onMove }: { card: Card; allStates: BoardState[]; onMove: (cardId: string, targetStateId: string) => void }) {
  const [open, setOpen] = useState(false);
  const otherStates = allStates.filter((s) => s.id !== card.stateId);

  return React.createElement('div', { className: 'relative', style: { zIndex: open ? 50 : 1 } },
    React.createElement('button', {
      className: 'text-[10px] text-ctp-subtext0 hover:text-ctp-text px-1 rounded-lg hover:bg-ctp-surface0 transition-colors',
      onClick: (e: React.MouseEvent) => { e.stopPropagation(); setOpen(!open); },
      title: 'Move card',
    }, '\u2192'),
    open && React.createElement('div', {
      className: 'absolute right-0 top-5 bg-ctp-mantle border border-ctp-surface0 rounded-xl shadow-lg py-1 min-w-[120px]',
    },
      otherStates.map((state) =>
        React.createElement('button', {
          key: state.id,
          className: 'block w-full text-left px-2.5 py-1 text-[11px] text-ctp-text hover:bg-ctp-surface0/70 transition-colors',
          onClick: (e: React.MouseEvent) => { e.stopPropagation(); onMove(card.id, state.id); setOpen(false); },
        }, state.name),
      ),
    ),
  );
}

// ── Card tile ───────────────────────────────────────────────────────────

function CardTile({ card, allStates, onMoveCard, onDeleteCard, onClearRetries, onManualAdvance }: {
  card: Card;
  allStates: BoardState[];
  onMoveCard: (cardId: string, targetStateId: string) => void;
  onDeleteCard: (cardId: string) => void;
  onClearRetries: (cardId: string) => void;
  onManualAdvance: (cardId: string) => void;
}) {
  const stuck = isCardStuck(card);
  const hasRetries = !stuck && card.automationAttempts > 0;
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const config = PRIORITY_CONFIG[card.priority];

  return React.createElement('div', {
    className: `relative bg-ctp-mantle border rounded-xl px-2.5 py-2 cursor-grab active:cursor-grabbing hover:border-ctp-surface2 transition-colors ${
      stuck ? 'border-ctp-red animate-stuck-pulse' : 'border-ctp-surface0/70'
    }`,
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('application/x-kanboss-card', card.id);
      e.dataTransfer.effectAllowed = 'move';
    },
    onClick: () => kanBossState.openEditCard(card.id),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setContextMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    },
  },
    // Priority tag
    !config.hidden && React.createElement('div', { className: 'mb-1.5' },
      React.createElement('span', {
        className: 'text-[10px] px-2 py-0.5 rounded-full font-medium',
        style: { backgroundColor: `${config.color}20`, color: config.color },
      }, config.label),
    ),

    // Title + move button
    React.createElement('div', { className: 'flex items-start gap-1' },
      React.createElement('span', {
        className: 'flex-1 min-w-0 text-[11px] text-ctp-text font-medium leading-snug',
      }, card.title),
      React.createElement(MoveButton, { card, allStates, onMove: onMoveCard }),
    ),

    // Body preview (2 lines)
    card.body && React.createElement('div', {
      className: 'text-[10px] text-ctp-subtext0 mt-1 leading-relaxed',
      style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as never, overflow: 'hidden' },
    }, card.body),

    // Stuck actions — clear retries + advance
    stuck && React.createElement('div', {
      className: 'flex items-center gap-1.5 mt-1.5 pt-1.5 border-t border-ctp-surface0/50',
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
    },
      React.createElement('button', {
        className: 'text-[9px] px-2 py-0.5 rounded-full bg-ctp-surface0 text-ctp-subtext1 hover:text-ctp-text hover:bg-ctp-surface1 transition-colors',
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); onClearRetries(card.id); },
        title: 'Reset retry counter so automation can try again',
      }, 'Clear Retries'),
      React.createElement('button', {
        className: 'text-[9px] px-2 py-0.5 rounded-full bg-ctp-green/15 text-ctp-green hover:bg-ctp-green/25 transition-colors',
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); onManualAdvance(card.id); },
        title: 'Manually advance to next state',
      }, 'Advance \u2192'),
    ),

    // Stuck badge — top-right corner
    stuck && React.createElement('div', {
      className: 'absolute -top-1.5 -right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[8px] font-bold text-white',
      style: { backgroundColor: '#ef4444' },
      title: 'Stuck \u2014 automation failed after max retries',
    }, '\u0021 Stuck'),

    // Attempt badge — top-right corner (when not stuck but has attempts)
    hasRetries && card.automationAttempts === 1 && React.createElement('div', {
      className: 'absolute -top-1.5 -right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[8px] font-bold',
      style: { backgroundColor: '#22c55e', color: '#fff' },
      title: 'First automation attempt in progress',
    }, 'First Attempt'),

    hasRetries && card.automationAttempts > 1 && React.createElement('div', {
      className: 'absolute -top-1.5 -right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[8px] font-bold',
      style: { backgroundColor: '#eab308', color: '#fff' },
      title: `Automation retry ${card.automationAttempts - 1}`,
    }, `Retry: ${card.automationAttempts - 1}`),

    // Context menu
    contextMenu && [
      // Invisible backdrop (absolute, large enough to cover everything)
      React.createElement('div', {
        key: 'ctx-backdrop',
        style: { position: 'absolute' as const, top: -9999, left: -9999, right: -9999, bottom: -9999, zIndex: 40 },
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); setContextMenu(null); },
        onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setContextMenu(null); },
      }),
      React.createElement('div', {
        key: 'ctx-menu',
        className: 'absolute bg-ctp-mantle border border-ctp-surface0 rounded-xl shadow-lg py-1 z-50 min-w-[130px]',
        style: { left: contextMenu.x, top: contextMenu.y },
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
      },
        React.createElement('button', {
          className: 'block w-full text-left px-3 py-1.5 text-[11px] text-ctp-text hover:bg-ctp-surface0/70 transition-colors',
          onClick: (e: React.MouseEvent) => { e.stopPropagation(); kanBossState.openEditCard(card.id); setContextMenu(null); },
        }, 'Edit'),
        React.createElement('button', {
          className: 'block w-full text-left px-3 py-1.5 text-[11px] text-ctp-red hover:bg-ctp-surface0/70 transition-colors',
          onClick: (e: React.MouseEvent) => { e.stopPropagation(); onDeleteCard(card.id); setContextMenu(null); },
        }, 'Delete'),
      ),
    ],
  );
}

// ── CardCell ────────────────────────────────────────────────────────────

export function CardCell({ cards, stateId, swimlaneId, isLastState, allStates, onMoveCard, onDeleteCard, onClearRetries, onManualAdvance }: CardCellProps) {
  const [expanded, setExpanded] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);

  // Sort cards by priority (critical first, none last)
  const sorted = [...cards].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4));

  const handleAdd = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    kanBossState.openNewCard(stateId, swimlaneId);
  }, [stateId, swimlaneId]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragOver(false);
    const cardId = e.dataTransfer.getData('application/x-kanboss-card');
    if (cardId) onMoveCard(cardId, stateId, swimlaneId);
  }, [onMoveCard, stateId, swimlaneId]);

  const dropProps = {
    onDragOver: handleDragOver,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  };

  // Last state: collapse to "N done" badge by default
  if (isLastState && sorted.length > 0 && !expanded) {
    return React.createElement('div', {
      className: `flex-1 p-2 min-h-[60px] flex items-center justify-center transition-colors ${isDragOver ? 'bg-ctp-blue/10 ring-1 ring-inset ring-ctp-blue/30 rounded-xl' : ''}`,
      ...dropProps,
    },
      React.createElement('button', {
        className: 'px-3 py-1 text-[11px] rounded-full bg-ctp-green/15 text-ctp-green hover:bg-ctp-green/25 transition-colors',
        onClick: () => setExpanded(true),
      }, `${sorted.length} done`),
    );
  }

  // Determine visible cards (low priority overflows first)
  const visibleCards = expanded || sorted.length <= MAX_VISIBLE ? sorted : sorted.slice(0, MAX_VISIBLE);
  const hiddenCount = sorted.length - visibleCards.length;

  return React.createElement('div', {
    className: `flex-1 p-2 space-y-1.5 min-h-[60px] transition-colors ${isDragOver ? 'bg-ctp-blue/10 ring-1 ring-inset ring-ctp-blue/30 rounded-xl' : ''}`,
    ...dropProps,
  },
    // Cards
    visibleCards.map((card) =>
      React.createElement(CardTile, {
        key: card.id,
        card,
        allStates,
        onMoveCard,
        onDeleteCard,
        onClearRetries,
        onManualAdvance,
      }),
    ),

    // "+N more" pill
    hiddenCount > 0 && React.createElement('button', {
      className: 'w-full text-center text-[10px] text-ctp-subtext0 hover:text-ctp-text py-0.5 rounded-lg hover:bg-ctp-surface0/70 transition-colors',
      onClick: () => setExpanded(true),
    }, `+${hiddenCount} more`),

    // Collapse button for expanded last-state
    isLastState && expanded && React.createElement('button', {
      className: 'w-full text-center text-[10px] text-ctp-subtext0 hover:text-ctp-text py-0.5 rounded-lg hover:bg-ctp-surface0/70 transition-colors',
      onClick: () => setExpanded(false),
    }, 'Collapse'),

    // + Add button
    React.createElement('button', {
      className: 'w-full text-center text-[10px] text-ctp-subtext0 hover:text-ctp-text py-0.5 rounded-lg hover:bg-ctp-surface0/70 transition-colors mt-0.5',
      onClick: handleAdd,
    }, '+ Add'),
  );
}
