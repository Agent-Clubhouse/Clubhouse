import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { Board, Card, BoardState } from './types';
import { BOARDS_KEY, cardsKey } from './types';
import { kanBossState } from './state';
import { CardCell } from './CardCell';
import { CardDialog } from './CardDialog';
import { BoardConfigDialog } from './BoardConfigDialog';
import { triggerAutomation } from './AutomationEngine';

// ── BoardView (MainPanel) ───────────────────────────────────────────────

export function BoardView({ api }: { api: PluginAPI }) {
  const storage = api.storage.projectLocal;

  const [board, setBoard] = useState<Board | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [showCardDialog, setShowCardDialog] = useState(false);
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1.0);

  // ── Subscribe to state ────────────────────────────────────────────────
  useEffect(() => {
    const unsub = kanBossState.subscribe(() => {
      setSelectedBoardId(kanBossState.selectedBoardId);
      setShowCardDialog(kanBossState.editingCardId !== null);
      setShowConfigDialog(kanBossState.configuringBoard);
    });
    // Pick up initial state
    setSelectedBoardId(kanBossState.selectedBoardId);
    return unsub;
  }, []);

  // ── Load board + cards ────────────────────────────────────────────────
  const loadBoard = useCallback(async () => {
    if (!selectedBoardId) {
      setBoard(null);
      setCards([]);
      return;
    }
    const raw = await storage.read(BOARDS_KEY);
    const boards: Board[] = Array.isArray(raw) ? raw : [];
    const found = boards.find((b) => b.id === selectedBoardId) ?? null;
    setBoard(found);
    if (found) {
      setZoomLevel(found.config.zoomLevel);
      const cardsRaw = await storage.read(cardsKey(found.id));
      setCards(Array.isArray(cardsRaw) ? cardsRaw : []);
    } else {
      setCards([]);
    }
  }, [selectedBoardId, storage]);

  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

  // Reload when refreshCount changes
  const refreshRef = useRef(kanBossState.refreshCount);
  useEffect(() => {
    const unsub = kanBossState.subscribe(() => {
      if (kanBossState.refreshCount !== refreshRef.current) {
        refreshRef.current = kanBossState.refreshCount;
        loadBoard();
      }
    });
    return unsub;
  }, [loadBoard]);

  // ── Zoom controls ─────────────────────────────────────────────────────
  const adjustZoom = useCallback(async (delta: number) => {
    if (!board) return;
    const newZoom = Math.max(0.5, Math.min(2.0, Math.round((zoomLevel + delta) * 10) / 10));
    setZoomLevel(newZoom);

    // Persist zoom
    const raw = await storage.read(BOARDS_KEY);
    const boards: Board[] = Array.isArray(raw) ? raw : [];
    const idx = boards.findIndex((b) => b.id === board.id);
    if (idx !== -1) {
      boards[idx].config.zoomLevel = newZoom;
      await storage.write(BOARDS_KEY, boards);
    }
  }, [board, zoomLevel, storage]);

  // ── Move card ─────────────────────────────────────────────────────────
  const handleMoveCard = useCallback(async (cardId: string, targetStateId: string) => {
    if (!board) return;

    const raw = await storage.read(cardsKey(board.id));
    const allCards: Card[] = Array.isArray(raw) ? raw : [];
    const idx = allCards.findIndex((c) => c.id === cardId);
    if (idx === -1) return;

    const card = allCards[idx];
    const fromState = board.states.find((s) => s.id === card.stateId);
    const toState = board.states.find((s) => s.id === targetStateId);
    if (!fromState || !toState) return;

    card.stateId = targetStateId;
    card.automationAttempts = 0;
    card.updatedAt = Date.now();
    card.history.push({
      action: 'moved',
      timestamp: Date.now(),
      detail: `Moved from "${fromState.name}" to "${toState.name}"`,
    });

    allCards[idx] = card;
    await storage.write(cardsKey(board.id), allCards);
    setCards([...allCards]);
    kanBossState.triggerRefresh();

    // Trigger automation if target state is automatic
    if (toState.isAutomatic) {
      await triggerAutomation(api, card, board);
    }
  }, [board, storage, api]);

  // ── No board selected ─────────────────────────────────────────────────
  if (!board) {
    return React.createElement('div', {
      className: 'flex-1 flex items-center justify-center text-ctp-subtext0 text-xs h-full',
    }, 'Select a board to get started');
  }

  // ── Sort states and swimlanes ─────────────────────────────────────────
  const sortedStates = [...board.states].sort((a, b) => a.order - b.order);
  const sortedLanes = [...board.swimlanes].sort((a, b) => a.order - b.order);
  const lastStateId = sortedStates.length > 0 ? sortedStates[sortedStates.length - 1].id : null;

  // ── Grid ──────────────────────────────────────────────────────────────
  const gridCols = `140px repeat(${sortedStates.length}, minmax(220px, 1fr))`;

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-base' },
    // Toolbar
    React.createElement('div', {
      className: 'flex items-center gap-3 px-4 py-2 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0',
    },
      React.createElement('span', { className: 'text-sm font-medium text-ctp-text' }, board.name),
      React.createElement('div', { className: 'flex-1' }),
      // Zoom controls
      React.createElement('div', { className: 'flex items-center gap-1' },
        React.createElement('button', {
          className: 'px-1.5 py-0.5 text-xs text-ctp-subtext0 hover:text-ctp-text bg-ctp-surface0 rounded transition-colors',
          onClick: () => adjustZoom(-0.1),
          disabled: zoomLevel <= 0.5,
        }, '-'),
        React.createElement('span', {
          className: 'text-[10px] text-ctp-subtext0 w-10 text-center',
        }, `${Math.round(zoomLevel * 100)}%`),
        React.createElement('button', {
          className: 'px-1.5 py-0.5 text-xs text-ctp-subtext0 hover:text-ctp-text bg-ctp-surface0 rounded transition-colors',
          onClick: () => adjustZoom(0.1),
          disabled: zoomLevel >= 2.0,
        }, '+'),
      ),
      // Config button
      React.createElement('button', {
        className: 'px-2 py-0.5 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
        onClick: () => kanBossState.openBoardConfig(),
        title: 'Board settings',
      }, '\u2699'),
    ),

    // Grid container (scrollable + zoomable)
    React.createElement('div', {
      className: 'flex-1 overflow-auto',
    },
      React.createElement('div', {
        style: {
          transform: `scale(${zoomLevel})`,
          transformOrigin: 'top left',
          minWidth: `${140 + sortedStates.length * 220}px`,
        },
      },
        React.createElement('div', {
          style: { display: 'grid', gridTemplateColumns: gridCols },
        },
          // ── Header row ──────────────────────────────────────────────
          // Empty corner cell
          React.createElement('div', {
            className: 'bg-ctp-mantle border-b border-r border-ctp-surface0 p-2',
          }),
          // State headers
          ...sortedStates.map((state) =>
            React.createElement('div', {
              key: `header-${state.id}`,
              className: 'bg-ctp-mantle border-b-2 border-r border-ctp-surface0 p-2',
              style: { borderBottomColor: state.accentColor },
            },
              React.createElement('div', { className: 'flex items-center gap-1.5' },
                React.createElement('span', { className: 'text-xs font-medium text-ctp-text' }, state.name),
                state.isAutomatic && React.createElement('span', {
                  className: 'text-[8px] px-1 py-px rounded bg-ctp-mauve/15 text-ctp-mauve',
                }, 'auto'),
              ),
            ),
          ),

          // ── Swimlane rows ───────────────────────────────────────────
          ...sortedLanes.flatMap((lane) => {
            const laneAgents = api.agents.list();
            const managerAgent = lane.managerAgentId
              ? laneAgents.find((a) => a.id === lane.managerAgentId)
              : null;

            return [
              // Swimlane label cell
              React.createElement('div', {
                key: `lane-${lane.id}`,
                className: 'bg-ctp-mantle border-r border-b border-ctp-surface0 p-2 flex flex-col justify-center',
              },
                React.createElement('span', { className: 'text-xs font-medium text-ctp-text' }, lane.name),
                managerAgent && React.createElement('div', { className: 'flex items-center gap-1 mt-1' },
                  managerAgent.emoji && React.createElement('span', { className: 'text-[10px]' }, managerAgent.emoji),
                  React.createElement('span', { className: 'text-[9px] text-ctp-subtext0 truncate' }, managerAgent.name),
                ),
              ),
              // Card cells for this swimlane
              ...sortedStates.map((state) => {
                const cellCards = cards.filter(
                  (c) => c.stateId === state.id && c.swimlaneId === lane.id,
                );
                return React.createElement('div', {
                  key: `cell-${lane.id}-${state.id}`,
                  className: 'border-b border-r border-ctp-surface0',
                },
                  React.createElement(CardCell, {
                    api,
                    cards: cellCards,
                    stateId: state.id,
                    swimlaneId: lane.id,
                    isLastState: state.id === lastStateId,
                    allStates: sortedStates,
                    onMoveCard: handleMoveCard,
                  }),
                );
              }),
            ];
          }),
        ),
      ),
    ),

    // Dialogs
    showCardDialog && React.createElement(CardDialog, { api, boardId: board.id }),
    showConfigDialog && React.createElement(BoardConfigDialog, { api, board }),
  );
}
