import React, { useState, useCallback, useEffect } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { Card, Priority, HistoryEntry } from './types';
import { cardsKey, generateId, PRIORITY_CONFIG } from './types';
import { kanBossState } from './state';

const PRIORITIES: Priority[] = ['none', 'low', 'medium', 'high', 'critical'];

interface CardDialogProps {
  api: PluginAPI;
  boardId: string;
}

// ── History entry display ───────────────────────────────────────────────

function HistoryItem({ entry }: { entry: HistoryEntry }) {
  const time = new Date(entry.timestamp).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  return React.createElement('div', { className: 'flex items-start gap-2 py-1' },
    React.createElement('span', { className: 'text-[10px] text-ctp-subtext0 flex-shrink-0 w-24' }, time),
    React.createElement('span', { className: 'text-[10px] text-ctp-subtext1' }, entry.detail),
  );
}

// ── CardDialog ──────────────────────────────────────────────────────────

export function CardDialog({ api, boardId }: CardDialogProps) {
  const currentBoard = kanBossState.boards.find((b) => b.id === boardId);
  const storage = currentBoard?.config.gitHistory ? api.storage.project : api.storage.projectLocal;
  const isNew = kanBossState.editingCardId === 'new';
  const cardId = isNew ? null : kanBossState.editingCardId;

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('none');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(isNew);

  // Load existing card data
  useEffect(() => {
    if (isNew || !cardId) {
      setTitle('');
      setBody('');
      setPriority('none');
      setHistory([]);
      setLoaded(true);
      return;
    }
    (async () => {
      const raw = await storage.read(cardsKey(boardId));
      const cards: Card[] = Array.isArray(raw) ? raw : [];
      const card = cards.find((c) => c.id === cardId);
      if (card) {
        setTitle(card.title);
        setBody(card.body);
        setPriority(card.priority);
        setHistory(card.history);
      }
      setLoaded(true);
    })();
  }, [cardId, isNew, boardId, storage]);

  // ── Save ────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!title.trim()) return;

    const raw = await storage.read(cardsKey(boardId));
    const cards: Card[] = Array.isArray(raw) ? raw : [];
    const now = Date.now();

    if (isNew) {
      const newCard: Card = {
        id: generateId('card'),
        boardId,
        title: title.trim(),
        body,
        priority,
        stateId: kanBossState.editingStateId!,
        swimlaneId: kanBossState.editingSwimlaneId!,
        history: [{ action: 'created', timestamp: now, detail: `Created "${title.trim()}"` }],
        automationAttempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      cards.push(newCard);
    } else if (cardId) {
      const idx = cards.findIndex((c) => c.id === cardId);
      if (idx !== -1) {
        const card = cards[idx];
        const changes: string[] = [];
        if (card.title !== title.trim()) changes.push('title');
        if (card.body !== body) changes.push('body');
        if (card.priority !== priority) {
          changes.push('priority');
          card.history.push({
            action: 'priority-changed',
            timestamp: now,
            detail: `Priority changed from ${card.priority} to ${priority}`,
          });
        }
        if (changes.length > 0) {
          card.history.push({
            action: 'edited',
            timestamp: now,
            detail: `Edited: ${changes.join(', ')}`,
          });
        }
        card.title = title.trim();
        card.body = body;
        card.priority = priority;
        card.updatedAt = now;
        cards[idx] = card;
      }
    }

    await storage.write(cardsKey(boardId), cards);
    kanBossState.closeCardDialog();
    kanBossState.triggerRefresh();
  }, [title, body, priority, isNew, cardId, boardId, storage]);

  // ── Delete ──────────────────────────────────────────────────────────
  const handleDelete = useCallback(async () => {
    if (!cardId) return;
    const ok = await api.ui.showConfirm('Delete this card? This cannot be undone.');
    if (!ok) return;

    const raw = await storage.read(cardsKey(boardId));
    const cards: Card[] = Array.isArray(raw) ? raw : [];
    const next = cards.filter((c) => c.id !== cardId);
    await storage.write(cardsKey(boardId), next);
    kanBossState.closeCardDialog();
    kanBossState.triggerRefresh();
  }, [api, cardId, boardId, storage]);

  // ── Cancel ──────────────────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    kanBossState.closeCardDialog();
  }, []);

  if (!loaded) return null;

  // ── Render ──────────────────────────────────────────────────────────
  return React.createElement('div', {
    className: 'fixed inset-0 bg-black/50 flex items-center justify-center z-50',
    onClick: handleCancel,
  },
    React.createElement('div', {
      className: 'bg-ctp-base border border-ctp-surface0 rounded-lg shadow-xl w-full max-w-lg mx-4',
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
    },
      // Header
      React.createElement('div', {
        className: 'flex items-center justify-between px-4 py-3 border-b border-ctp-surface0',
      },
        React.createElement('span', { className: 'text-sm font-medium text-ctp-text' },
          isNew ? 'New Card' : 'Edit Card',
        ),
        React.createElement('button', {
          className: 'text-ctp-subtext0 hover:text-ctp-text text-lg',
          onClick: handleCancel,
        }, '\u00D7'),
      ),

      // Form
      React.createElement('div', { className: 'p-4 space-y-3' },
        // Title
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-xs text-ctp-subtext1 mb-1' }, 'Title'),
          React.createElement('input', {
            type: 'text',
            className: 'w-full px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-ctp-surface2 text-ctp-text placeholder:text-ctp-subtext0/40 focus:outline-none focus:border-ctp-accent/50 focus:ring-1 focus:ring-ctp-accent/30',
            value: title,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value),
            placeholder: 'Card title...',
            autoFocus: true,
          }),
        ),

        // Body
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-xs text-ctp-subtext1 mb-1' }, 'Description'),
          React.createElement('textarea', {
            className: 'w-full px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-ctp-surface2 text-ctp-text placeholder:text-ctp-subtext0/40 focus:outline-none focus:border-ctp-accent/50 focus:ring-1 focus:ring-ctp-accent/30 resize-y',
            rows: 4,
            value: body,
            onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setBody(e.target.value),
            placeholder: 'Description...',
          }),
        ),

        // Priority
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-xs text-ctp-subtext1 mb-1' }, 'Priority'),
          React.createElement('select', {
            className: 'w-full px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-ctp-surface2 text-ctp-text focus:outline-none focus:border-ctp-accent/50 focus:ring-1 focus:ring-ctp-accent/30',
            value: priority,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setPriority(e.target.value as Priority),
          },
            PRIORITIES.map((p) =>
              React.createElement('option', { key: p, value: p }, PRIORITY_CONFIG[p].label),
            ),
          ),
        ),
      ),

      // History (edit mode only)
      !isNew && history.length > 0 && React.createElement('div', {
        className: 'px-4 pb-3',
      },
        React.createElement('div', { className: 'text-xs font-medium text-ctp-subtext1 mb-1.5' }, 'History'),
        React.createElement('div', {
          className: 'max-h-32 overflow-y-auto border border-ctp-surface0 rounded-lg p-2 bg-ctp-mantle',
        },
          [...history].reverse().map((entry, i) =>
            React.createElement(HistoryItem, { key: i, entry }),
          ),
        ),
      ),

      // Footer
      React.createElement('div', {
        className: 'flex items-center justify-between px-4 py-3 border-t border-ctp-surface0',
      },
        // Delete (edit mode only)
        !isNew
          ? React.createElement('button', {
              className: 'px-3 py-1 text-xs text-ctp-red border border-ctp-red/30 rounded hover:bg-ctp-red/10 transition-colors',
              onClick: handleDelete,
            }, 'Delete')
          : React.createElement('div'),
        // Save / Cancel
        React.createElement('div', { className: 'flex items-center gap-2' },
          React.createElement('button', {
            className: 'px-3 py-1 text-xs text-ctp-subtext1 border border-ctp-surface2 rounded hover:bg-ctp-surface0 transition-colors',
            onClick: handleCancel,
          }, 'Cancel'),
          React.createElement('button', {
            className: 'px-3 py-1 text-xs bg-ctp-accent text-white rounded hover:opacity-90 transition-opacity',
            onClick: handleSave,
          }, 'Save'),
        ),
      ),
    ),
  );
}
