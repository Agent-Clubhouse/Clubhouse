import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { Board } from './types';
import { BOARDS_KEY, cardsKey, generateId } from './types';
import { kanBossState } from './state';

// ── Default board factory ───────────────────────────────────────────────

function createDefaultBoard(name: string, gitHistory: boolean): Board {
  const now = Date.now();
  return {
    id: generateId('board'),
    name,
    states: [
      { id: generateId('state'), name: 'Todo',        order: 0, isAutomatic: false, automationPrompt: '' },
      { id: generateId('state'), name: 'In Progress', order: 1, isAutomatic: false, automationPrompt: '' },
      { id: generateId('state'), name: 'Done',        order: 2, isAutomatic: false, automationPrompt: '' },
    ],
    swimlanes: [
      { id: generateId('lane'), name: 'Default', order: 0, managerAgentId: null, evaluationAgentId: null },
    ],
    config: { maxRetries: 3, zoomLevel: 1.0, gitHistory },
    createdAt: now,
    updatedAt: now,
  };
}

// ── Create Board Dialog ─────────────────────────────────────────────────

function CreateBoardDialog({ onSave, onCancel }: {
  onSave: (name: string, gitHistory: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [gitHistory, setGitHistory] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Autofocus name input on mount
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed, gitHistory);
  }, [name, gitHistory, onSave]);

  return React.createElement('div', {
    className: 'fixed inset-0 bg-black/50 flex items-center justify-center z-50',
    onClick: onCancel,
  },
    React.createElement('div', {
      className: 'bg-ctp-base border border-ctp-surface0 rounded-xl shadow-2xl w-full max-w-sm mx-4',
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
    },
      // Header
      React.createElement('div', {
        className: 'px-5 pt-4 pb-2',
      },
        React.createElement('h2', {
          className: 'text-sm font-semibold text-ctp-text',
        }, 'Create Board'),
        React.createElement('p', {
          className: 'text-[11px] text-ctp-subtext0 mt-0.5',
        }, 'Set up a new Kanban board for your project.'),
      ),

      // Form
      React.createElement('div', { className: 'px-5 py-3 space-y-3' },
        // Name field
        React.createElement('div', null,
          React.createElement('label', {
            className: 'block text-[11px] font-medium text-ctp-subtext1 mb-1',
          }, 'Board Name'),
          React.createElement('input', {
            ref: inputRef,
            type: 'text',
            className: 'w-full px-3 py-2 text-xs rounded-lg bg-ctp-mantle border border-ctp-surface1 text-ctp-text placeholder:text-ctp-subtext0/50 focus:outline-none focus:border-ctp-accent/60 focus:ring-1 focus:ring-ctp-accent/20 transition-colors',
            placeholder: 'e.g. Sprint 14, Feature Work, Bug Triage...',
            value: name,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value),
            onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleSubmit(); },
          }),
        ),

        // Git history toggle
        React.createElement('div', {
          className: 'flex items-start gap-2.5 p-2.5 rounded-lg bg-ctp-mantle/60 border border-ctp-surface0/50',
        },
          React.createElement('input', {
            type: 'checkbox',
            id: 'git-history',
            checked: gitHistory,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setGitHistory(e.target.checked),
            className: 'mt-0.5 rounded',
          }),
          React.createElement('label', {
            htmlFor: 'git-history',
            className: 'cursor-pointer select-none',
          },
            React.createElement('div', {
              className: 'text-[11px] font-medium text-ctp-text',
            }, 'Enable git history'),
            React.createElement('div', {
              className: 'text-[10px] text-ctp-subtext0 mt-0.5 leading-relaxed',
            }, 'Store board data in a git-tracked location so it can be shared with your team.'),
          ),
        ),
      ),

      // Footer
      React.createElement('div', {
        className: 'flex items-center justify-end gap-2 px-5 py-3 border-t border-ctp-surface0/50',
      },
        React.createElement('button', {
          className: 'px-3 py-1.5 text-xs text-ctp-subtext1 rounded-lg border border-ctp-surface1 hover:bg-ctp-surface0/50 transition-colors',
          onClick: onCancel,
        }, 'Cancel'),
        React.createElement('button', {
          className: 'px-3 py-1.5 text-xs font-medium bg-ctp-accent text-ctp-base rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40',
          onClick: handleSubmit,
          disabled: !name.trim(),
        }, 'Create'),
      ),
    ),
  );
}

// ── BoardSidebar (SidebarPanel) ─────────────────────────────────────────

export function BoardSidebar({ api }: { api: PluginAPI }) {
  const boardsStorage = api.storage.projectLocal;
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cardCounts, setCardCounts] = useState<Map<string, number>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // ── Load boards ─────────────────────────────────────────────────────
  const loadBoards = useCallback(async () => {
    const raw = await boardsStorage.read(BOARDS_KEY);
    const list: Board[] = Array.isArray(raw) ? raw : [];
    setBoards(list);
    kanBossState.setBoards(list);

    // Load card counts (use correct storage per board)
    const counts = new Map<string, number>();
    for (const board of list) {
      const cardsStor = board.config.gitHistory ? api.storage.project : api.storage.projectLocal;
      const cardsRaw = await cardsStor.read(cardsKey(board.id));
      const cards = Array.isArray(cardsRaw) ? cardsRaw : [];
      counts.set(board.id, cards.length);
    }
    setCardCounts(counts);
    if (!loaded) setLoaded(true);
  }, [boardsStorage, api, loaded]);

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
  const handleCreate = useCallback(async (name: string, gitHistory: boolean) => {
    const board = createDefaultBoard(name, gitHistory);
    const next = [...boards, board];
    await boardsStorage.write(BOARDS_KEY, next);
    const cardsStor = gitHistory ? api.storage.project : api.storage.projectLocal;
    await cardsStor.write(cardsKey(board.id), []);
    setBoards(next);
    kanBossState.setBoards(next);
    kanBossState.selectBoard(board.id);
    setSelectedId(board.id);
    setCardCounts((prev) => new Map(prev).set(board.id, 0));
    setShowCreateDialog(false);
  }, [boards, boardsStorage, api]);

  // ── Delete board ────────────────────────────────────────────────────
  const handleDelete = useCallback(async (boardId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const board = boards.find((b) => b.id === boardId);
    if (!board) return;
    const ok = await api.ui.showConfirm(`Delete board "${board.name}" and all its cards? This cannot be undone.`);
    if (!ok) return;

    const next = boards.filter((b) => b.id !== boardId);
    await boardsStorage.write(BOARDS_KEY, next);
    const cardsStor = board.config.gitHistory ? api.storage.project : api.storage.projectLocal;
    await cardsStor.delete(cardsKey(boardId));
    setBoards(next);
    kanBossState.setBoards(next);

    if (selectedId === boardId) {
      const newSel = next.length > 0 ? next[0].id : null;
      kanBossState.selectBoard(newSel);
      setSelectedId(newSel);
    }
  }, [api, boards, boardsStorage, selectedId]);

  // ── Reorder boards (drag & drop) ────────────────────────────────────
  const handleReorder = useCallback(async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    const result = [...boards];
    const [moved] = result.splice(fromIdx, 1);
    result.splice(toIdx, 0, moved);
    setBoards(result);
    kanBossState.setBoards(result);
    await boardsStorage.write(BOARDS_KEY, result);
  }, [boards, boardsStorage]);

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
        onClick: () => setShowCreateDialog(true),
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
            boards.map((board, boardIdx) =>
              React.createElement('div', {
                key: board.id,
                className: `flex items-center gap-2 px-3 py-2.5 cursor-pointer transition-colors ${
                  board.id === selectedId ? 'bg-surface-1 text-ctp-text' : 'hover:bg-surface-0 text-ctp-subtext1'
                }`,
                draggable: true,
                onDragStart: (e: React.DragEvent) => e.dataTransfer.setData('kanboss/board-idx', String(boardIdx)),
                onDragOver: (e: React.DragEvent) => e.preventDefault(),
                onDrop: (e: React.DragEvent) => {
                  e.preventDefault();
                  const from = e.dataTransfer.getData('kanboss/board-idx');
                  if (from !== '') handleReorder(parseInt(from), boardIdx);
                },
                onClick: () => handleSelect(board.id),
              },
                // Drag handle
                React.createElement('span', {
                  className: 'text-ctp-subtext0/50 text-[10px] select-none cursor-grab active:cursor-grabbing flex-shrink-0',
                }, '\u2261'),
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

    // Create board dialog
    showCreateDialog && React.createElement(CreateBoardDialog, {
      onSave: handleCreate,
      onCancel: () => setShowCreateDialog(false),
    }),
  );
}
