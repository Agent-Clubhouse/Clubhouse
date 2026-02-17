import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { Board } from './types';
import { BOARDS_KEY, cardsKey, generateId, ACCENT_COLORS } from './types';
import { kanBossState } from './state';

// ── Default board factory ───────────────────────────────────────────────

function createDefaultBoard(name: string): Board {
  const now = Date.now();
  return {
    id: generateId('board'),
    name,
    states: [
      { id: generateId('state'), name: 'Todo',        order: 0, isAutomatic: false, automationPrompt: '', accentColor: ACCENT_COLORS[0] },
      { id: generateId('state'), name: 'In Progress', order: 1, isAutomatic: false, automationPrompt: '', accentColor: ACCENT_COLORS[1] },
      { id: generateId('state'), name: 'Done',        order: 2, isAutomatic: false, automationPrompt: '', accentColor: ACCENT_COLORS[2] },
    ],
    swimlanes: [
      { id: generateId('lane'), name: 'Default', order: 0, managerAgentId: null },
    ],
    config: { maxRetries: 3, zoomLevel: 1.0 },
    createdAt: now,
    updatedAt: now,
  };
}

// ── BoardSidebar (SidebarPanel) ─────────────────────────────────────────

export function BoardSidebar({ api }: { api: PluginAPI }) {
  const storage = api.storage.projectLocal;
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cardCounts, setCardCounts] = useState<Map<string, number>>(new Map());
  const [loaded, setLoaded] = useState(false);

  // ── Load boards ─────────────────────────────────────────────────────
  const loadBoards = useCallback(async () => {
    const raw = await storage.read(BOARDS_KEY);
    const list: Board[] = Array.isArray(raw) ? raw : [];
    setBoards(list);
    kanBossState.setBoards(list);

    // Load card counts
    const counts = new Map<string, number>();
    for (const board of list) {
      const cardsRaw = await storage.read(cardsKey(board.id));
      const cards = Array.isArray(cardsRaw) ? cardsRaw : [];
      counts.set(board.id, cards.length);
    }
    setCardCounts(counts);
    if (!loaded) setLoaded(true);
  }, [storage, loaded]);

  useEffect(() => {
    loadBoards();
  }, [loadBoards]);

  // ── Subscribe to state changes (refresh signals) ────────────────────
  useEffect(() => {
    const unsub = kanBossState.subscribe(() => {
      setSelectedId(kanBossState.selectedBoardId);
    });
    return unsub;
  }, []);

  // Reload when refreshCount changes
  const refreshRef = useRef(kanBossState.refreshCount);
  useEffect(() => {
    const unsub = kanBossState.subscribe(() => {
      if (kanBossState.refreshCount !== refreshRef.current) {
        refreshRef.current = kanBossState.refreshCount;
        loadBoards();
      }
    });
    return unsub;
  }, [loadBoards]);

  // ── Create board ────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    const name = await api.ui.showInput('Board name', 'New Board');
    if (!name) return;

    const board = createDefaultBoard(name);
    const next = [...boards, board];
    await storage.write(BOARDS_KEY, next);
    await storage.write(cardsKey(board.id), []);
    setBoards(next);
    kanBossState.setBoards(next);
    kanBossState.selectBoard(board.id);
    setSelectedId(board.id);
    setCardCounts((prev) => new Map(prev).set(board.id, 0));
  }, [api, boards, storage]);

  // ── Delete board ────────────────────────────────────────────────────
  const handleDelete = useCallback(async (boardId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const board = boards.find((b) => b.id === boardId);
    if (!board) return;
    const ok = await api.ui.showConfirm(`Delete board "${board.name}" and all its cards? This cannot be undone.`);
    if (!ok) return;

    const next = boards.filter((b) => b.id !== boardId);
    await storage.write(BOARDS_KEY, next);
    await storage.delete(cardsKey(boardId));
    setBoards(next);
    kanBossState.setBoards(next);

    if (selectedId === boardId) {
      const newSel = next.length > 0 ? next[0].id : null;
      kanBossState.selectBoard(newSel);
      setSelectedId(newSel);
    }
  }, [api, boards, storage, selectedId]);

  // ── Select board ────────────────────────────────────────────────────
  const handleSelect = useCallback((boardId: string) => {
    kanBossState.selectBoard(boardId);
    setSelectedId(boardId);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────

  if (!loaded) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs',
    }, 'Loading...');
  }

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-mantle' },
    // Header
    React.createElement('div', {
      className: 'flex items-center justify-between px-3 py-2 border-b border-ctp-surface0',
    },
      React.createElement('span', { className: 'text-xs font-medium text-ctp-text' }, 'Boards'),
      React.createElement('button', {
        className: 'px-2 py-0.5 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
        onClick: handleCreate,
        title: 'Create new board',
      }, '+ New'),
    ),

    // Board list
    React.createElement('div', { className: 'flex-1 overflow-y-auto' },
      boards.length === 0
        ? React.createElement('div', {
            className: 'px-3 py-4 text-xs text-ctp-subtext0 text-center',
          }, 'No boards yet')
        : React.createElement('div', { className: 'py-0.5' },
            boards.map((board) =>
              React.createElement('div', {
                key: board.id,
                className: `flex items-center gap-2 px-3 py-2.5 cursor-pointer transition-colors ${
                  board.id === selectedId ? 'bg-surface-1 text-ctp-text' : 'hover:bg-surface-0 text-ctp-subtext1'
                }`,
                onClick: () => handleSelect(board.id),
              },
                // Board name
                React.createElement('div', { className: 'flex-1 min-w-0' },
                  React.createElement('div', { className: 'text-xs truncate' }, board.name),
                ),
                // Card count badge
                React.createElement('span', {
                  className: 'text-[10px] px-1.5 py-px rounded bg-ctp-surface0 text-ctp-subtext0 flex-shrink-0',
                }, String(cardCounts.get(board.id) ?? 0)),
                // Delete button
                React.createElement('button', {
                  className: 'text-ctp-subtext0 hover:text-ctp-red text-xs opacity-0 group-hover:opacity-100 transition-all flex-shrink-0',
                  onClick: (e: React.MouseEvent) => handleDelete(board.id, e),
                  title: 'Delete board',
                  style: { opacity: board.id === selectedId ? 0.5 : 0 },
                  onMouseEnter: (e: React.MouseEvent) => { (e.target as HTMLElement).style.opacity = '1'; },
                  onMouseLeave: (e: React.MouseEvent) => { (e.target as HTMLElement).style.opacity = board.id === selectedId ? '0.5' : '0'; },
                }, '\u00D7'),
              ),
            ),
          ),
    ),
  );
}
