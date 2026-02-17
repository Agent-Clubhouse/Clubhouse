import React, { useState, useCallback } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { Card, BoardState, Priority } from './types';
import { PRIORITY_CONFIG } from './types';
import { kanBossState } from './state';

const MAX_VISIBLE = 5;

interface CardCellProps {
  api: PluginAPI;
  cards: Card[];
  stateId: string;
  swimlaneId: string;
  isLastState: boolean;
  allStates: BoardState[];
  onMoveCard: (cardId: string, targetStateId: string) => void;
}

// ── Priority badge ──────────────────────────────────────────────────────

function PriorityBadge({ priority }: { priority: Priority }) {
  const config = PRIORITY_CONFIG[priority];
  if (config.hidden) return null;
  return React.createElement('span', {
    className: `text-[9px] px-1 py-px rounded ${config.className}`,
  }, config.label);
}

// ── Move dropdown ───────────────────────────────────────────────────────

function MoveButton({ card, allStates, onMove }: { card: Card; allStates: BoardState[]; onMove: (cardId: string, targetStateId: string) => void }) {
  const [open, setOpen] = useState(false);
  const otherStates = allStates.filter((s) => s.id !== card.stateId);

  return React.createElement('div', { className: 'relative', style: { zIndex: open ? 50 : 1 } },
    React.createElement('button', {
      className: 'text-[10px] text-ctp-subtext0 hover:text-ctp-text px-1 rounded hover:bg-ctp-surface0 transition-colors',
      onClick: (e: React.MouseEvent) => { e.stopPropagation(); setOpen(!open); },
      title: 'Move card',
    }, '\u2192'),
    open && React.createElement('div', {
      className: 'absolute right-0 top-5 bg-ctp-mantle border border-ctp-surface0 rounded shadow-lg py-1 min-w-[120px]',
    },
      otherStates.map((state) =>
        React.createElement('button', {
          key: state.id,
          className: 'block w-full text-left px-2.5 py-1 text-[11px] text-ctp-text hover:bg-ctp-surface0 transition-colors',
          onClick: (e: React.MouseEvent) => { e.stopPropagation(); onMove(card.id, state.id); setOpen(false); },
        }, state.name),
      ),
    ),
  );
}

// ── Card tile ───────────────────────────────────────────────────────────

function CardTile({ card, allStates, onMoveCard }: { card: Card; allStates: BoardState[]; onMoveCard: (cardId: string, targetStateId: string) => void }) {
  const isStuck = card.history.some((h) => h.action === 'automation-stuck');

  return React.createElement('div', {
    className: `bg-ctp-mantle border rounded-lg px-2 py-1.5 cursor-pointer hover:border-ctp-surface2 transition-colors ${
      isStuck ? 'border-ctp-red ring-1 ring-ctp-red/30' : 'border-ctp-surface0'
    }`,
    onClick: () => kanBossState.openEditCard(card.id),
  },
    React.createElement('div', { className: 'flex items-start gap-1' },
      React.createElement('div', { className: 'flex-1 min-w-0' },
        React.createElement('div', { className: 'text-[11px] text-ctp-text truncate' }, card.title),
        React.createElement('div', { className: 'flex items-center gap-1 mt-0.5' },
          React.createElement(PriorityBadge, { priority: card.priority }),
          isStuck && React.createElement('span', {
            className: 'text-[8px] px-1 py-px rounded bg-ctp-red/15 text-ctp-red',
          }, 'stuck'),
        ),
      ),
      React.createElement(MoveButton, { card, allStates, onMove: onMoveCard }),
    ),
  );
}

// ── CardCell ────────────────────────────────────────────────────────────

export function CardCell({ cards, stateId, swimlaneId, isLastState, allStates, onMoveCard }: CardCellProps) {
  const [expanded, setExpanded] = useState(false);

  const handleAdd = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    kanBossState.openNewCard(stateId, swimlaneId);
  }, [stateId, swimlaneId]);

  // Last state: collapse to "N done" badge by default
  if (isLastState && cards.length > 0 && !expanded) {
    return React.createElement('div', {
      className: 'p-1.5 min-h-[60px] flex items-center justify-center',
    },
      React.createElement('button', {
        className: 'px-3 py-1 text-[11px] rounded-full bg-ctp-green/15 text-ctp-green hover:bg-ctp-green/25 transition-colors',
        onClick: () => setExpanded(true),
      }, `${cards.length} done`),
    );
  }

  // Determine visible cards
  const visibleCards = expanded || cards.length <= MAX_VISIBLE ? cards : cards.slice(0, MAX_VISIBLE);
  const hiddenCount = cards.length - visibleCards.length;

  return React.createElement('div', { className: 'p-1.5 space-y-1 min-h-[60px]' },
    // Cards
    visibleCards.map((card) =>
      React.createElement(CardTile, {
        key: card.id,
        card,
        allStates,
        onMoveCard,
      }),
    ),

    // "+N more" pill
    hiddenCount > 0 && React.createElement('button', {
      className: 'w-full text-center text-[10px] text-ctp-subtext0 hover:text-ctp-text py-0.5 rounded hover:bg-ctp-surface0 transition-colors',
      onClick: () => setExpanded(true),
    }, `+${hiddenCount} more`),

    // Collapse button for expanded last-state
    isLastState && expanded && React.createElement('button', {
      className: 'w-full text-center text-[10px] text-ctp-subtext0 hover:text-ctp-text py-0.5 rounded hover:bg-ctp-surface0 transition-colors',
      onClick: () => setExpanded(false),
    }, 'Collapse'),

    // + Add button
    React.createElement('button', {
      className: 'w-full text-center text-[10px] text-ctp-subtext0 hover:text-ctp-text py-0.5 rounded hover:bg-ctp-surface0 transition-colors mt-0.5',
      onClick: handleAdd,
    }, '+ Add'),
  );
}
