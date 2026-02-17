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

// Helper: get the right storage for card data based on gitHistory setting
function cardsStorage(api: PluginAPI, board: Board) {
  return board.config.gitHistory ? api.storage.project : api.storage.projectLocal;
}

export function BoardView({ api }: { api: PluginAPI }) {
  const boardsStorage = api.storage.projectLocal;

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
    const raw = await boardsStorage.read(BOARDS_KEY);
    const boards: Board[] = Array.isArray(raw) ? raw : [];
    const found = boards.find((b) => b.id === selectedBoardId) ?? null;
    setBoard(found);
    if (found) {
      setZoomLevel(found.config.zoomLevel);
      const cardsStor = cardsStorage(api, found);
      const cardsRaw = await cardsStor.read(cardsKey(found.id));
      setCards(Array.isArray(cardsRaw) ? cardsRaw : []);
    } else {
      setCards([]);
    }
  }, [selectedBoardId, boardsStorage, api]);

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoomLevel);
  zoomRef.current = zoomLevel;

  const adjustZoom = useCallback(async (delta: number) => {
    if (!board) return;
    const newZoom = Math.max(0.5, Math.min(2.0, Math.round((zoomLevel + delta) * 20) / 20));
    setZoomLevel(newZoom);

    // Persist zoom
    const raw = await boardsStorage.read(BOARDS_KEY);
    const boards: Board[] = Array.isArray(raw) ? raw : [];
    const idx = boards.findIndex((b) => b.id === board.id);
    if (idx !== -1) {
      boards[idx].config.zoomLevel = newZoom;
      await boardsStorage.write(BOARDS_KEY, boards);
    }
  }, [board, zoomLevel, boardsStorage]);

  // Pinch-to-zoom on trackpad (ctrlKey + wheel)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      const cur = zoomRef.current;
      const next = Math.max(0.5, Math.min(2.0, Math.round((cur + delta) * 100) / 100));
      if (next !== cur) adjustZoom(next - cur);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [adjustZoom]);

  // ── Move card ─────────────────────────────────────────────────────────
  const handleMoveCard = useCallback(async (cardId: string, targetStateId: string, targetSwimlaneId?: string) => {
    if (!board) return;

    const raw = await cardsStorage(api, board).read(cardsKey(board.id));
    const allCards: Card[] = Array.isArray(raw) ? raw : [];
    const idx = allCards.findIndex((c) => c.id === cardId);
    if (idx === -1) return;

    const card = allCards[idx];
    const stateChanged = card.stateId !== targetStateId;
    const laneChanged = targetSwimlaneId != null && card.swimlaneId !== targetSwimlaneId;

    if (!stateChanged && !laneChanged) return;

    const fromState = board.states.find((s) => s.id === card.stateId);
    const toState = board.states.find((s) => s.id === targetStateId);
    if (!fromState || !toState) return;

    const fromLane = laneChanged ? board.swimlanes.find((l) => l.id === card.swimlaneId) : null;
    const toLane = laneChanged && targetSwimlaneId ? board.swimlanes.find((l) => l.id === targetSwimlaneId) : null;

    card.stateId = targetStateId;
    if (targetSwimlaneId) card.swimlaneId = targetSwimlaneId;
    card.automationAttempts = 0;
    card.updatedAt = Date.now();

    let detail = '';
    if (stateChanged) detail = `Moved from "${fromState.name}" to "${toState.name}"`;
    if (laneChanged && fromLane && toLane) {
      detail += detail ? `, lane "${fromLane.name}" \u2192 "${toLane.name}"` : `Moved to lane "${toLane.name}"`;
    }

    card.history.push({
      action: 'moved',
      timestamp: Date.now(),
      detail,
    });

    allCards[idx] = card;
    await cardsStorage(api, board).write(cardsKey(board.id), allCards);
    setCards([...allCards]);
    kanBossState.triggerRefresh();

    // Trigger automation if target state is automatic (only on state change)
    if (stateChanged && toState.isAutomatic) {
      await triggerAutomation(api, card, board);
    }
  }, [board, api]);

  // ── Delete card ─────────────────────────────────────────────────────────
  const handleDeleteCard = useCallback(async (cardId: string) => {
    if (!board) return;
    const raw = await cardsStorage(api, board).read(cardsKey(board.id));
    const allCards: Card[] = Array.isArray(raw) ? raw : [];
    const filtered = allCards.filter((c) => c.id !== cardId);
    await cardsStorage(api, board).write(cardsKey(board.id), filtered);
    setCards(filtered);
    kanBossState.triggerRefresh();
  }, [board, api]);

  // ── Clear retries (reset automation attempts so it can retry) ──────────
  const handleClearRetries = useCallback(async (cardId: string) => {
    if (!board) return;
    const raw = await cardsStorage(api, board).read(cardsKey(board.id));
    const allCards: Card[] = Array.isArray(raw) ? raw : [];
    const idx = allCards.findIndex((c) => c.id === cardId);
    if (idx === -1) return;

    allCards[idx].automationAttempts = 0;
    allCards[idx].updatedAt = Date.now();
    allCards[idx].history.push({
      action: 'edited',
      timestamp: Date.now(),
      detail: 'Retries cleared — automation can retry',
    });

    await cardsStorage(api, board).write(cardsKey(board.id), allCards);
    setCards([...allCards]);
    kanBossState.triggerRefresh();

    // Re-trigger automation if current state is automatic
    const state = board.states.find((s) => s.id === allCards[idx].stateId);
    if (state?.isAutomatic) {
      await triggerAutomation(api, allCards[idx], board);
    }
  }, [board, api]);

  // ── Manual advance (move to next state, bypass automation) ─────────────
  const handleManualAdvance = useCallback(async (cardId: string) => {
    if (!board) return;
    const raw = await cardsStorage(api, board).read(cardsKey(board.id));
    const allCards: Card[] = Array.isArray(raw) ? raw : [];
    const idx = allCards.findIndex((c) => c.id === cardId);
    if (idx === -1) return;

    const card = allCards[idx];
    const sortedStates = [...board.states].sort((a, b) => a.order - b.order);
    const curIdx = sortedStates.findIndex((s) => s.id === card.stateId);
    if (curIdx === -1 || curIdx >= sortedStates.length - 1) return;

    const nextState = sortedStates[curIdx + 1];
    const fromState = sortedStates[curIdx];

    card.stateId = nextState.id;
    card.automationAttempts = 0;
    card.updatedAt = Date.now();
    card.history.push({
      action: 'moved',
      timestamp: Date.now(),
      detail: `Manually advanced from "${fromState.name}" to "${nextState.name}"`,
    });

    allCards[idx] = card;
    await cardsStorage(api, board).write(cardsKey(board.id), allCards);
    setCards([...allCards]);
    kanBossState.triggerRefresh();
  }, [board, api]);

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
        className: 'w-9 h-9 flex items-center justify-center text-xl text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
        onClick: () => kanBossState.openBoardConfig(),
        title: 'Board settings',
      }, '\u2699'),
    ),

    // Grid container (scrollable + zoomable)
    React.createElement('div', {
      ref: scrollRef,
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
          className: 'bg-ctp-surface0/30 rounded-xl overflow-hidden',
          style: { display: 'grid', gridTemplateColumns: gridCols, gap: '1px' },
        },
          // ── Header row ──────────────────────────────────────────────
          // Empty corner cell
          React.createElement('div', {
            className: 'bg-ctp-mantle p-2',
          }),
          // State headers
          ...sortedStates.map((state) =>
            React.createElement('div', {
              key: `header-${state.id}`,
              className: 'bg-ctp-mantle p-2 flex flex-col',
            },
              React.createElement('div', { className: 'flex items-center gap-1.5 flex-1' },
                React.createElement('span', { className: 'text-xs font-medium text-ctp-text' }, state.name),
                state.isAutomatic && React.createElement('span', {
                  className: 'text-[8px] px-1.5 py-px rounded-full bg-ctp-mauve/15 text-ctp-mauve',
                }, 'auto'),
              ),
            ),
          ),

          // ── Swimlane rows ───────────────────────────────────────────
          ...sortedLanes.flatMap((lane, laneIndex) => {
            const laneAgents = api.agents.list();
            const managerAgent = lane.managerAgentId
              ? laneAgents.find((a) => a.id === lane.managerAgentId)
              : null;

            return [
              // Swimlane label cell
              React.createElement('div', {
                key: `lane-${lane.id}`,
                className: `${laneIndex % 2 === 0 ? 'bg-ctp-mantle' : 'bg-ctp-mantle/70'} p-2 flex flex-col justify-center`,
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
                  className: `${laneIndex % 2 === 0 ? 'bg-ctp-base' : 'bg-ctp-mantle/50'} flex flex-col`,
                },
                  React.createElement(CardCell, {
                    api,
                    cards: cellCards,
                    stateId: state.id,
                    swimlaneId: lane.id,
                    isLastState: state.id === lastStateId,
                    allStates: sortedStates,
                    onMoveCard: handleMoveCard,
                    onDeleteCard: handleDeleteCard,
                    onClearRetries: handleClearRetries,
                    onManualAdvance: handleManualAdvance,
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
