/**
 * Shared module-level state for the KanBoss plugin.
 *
 * SidebarPanel and MainPanel are rendered in separate React trees,
 * so we use a lightweight pub/sub to coordinate the selected board
 * and dialog visibility.
 */

import type { Board } from './types';

export const kanBossState = {
  selectedBoardId: null as string | null,
  boards: [] as Board[],
  refreshCount: 0,

  // Dialog state
  editingCardId: null as string | null,   // null=closed, 'new'=creating, cardId=editing
  editingStateId: null as string | null,  // target state for new card
  editingSwimlaneId: null as string | null, // target swimlane for new card
  configuringBoard: false,

  listeners: new Set<() => void>(),

  selectBoard(id: string | null): void {
    this.selectedBoardId = id;
    this.editingCardId = null;
    this.configuringBoard = false;
    this.notify();
  },

  setBoards(boards: Board[]): void {
    this.boards = boards;
    this.notify();
  },

  openNewCard(stateId: string, swimlaneId: string): void {
    this.editingCardId = 'new';
    this.editingStateId = stateId;
    this.editingSwimlaneId = swimlaneId;
    this.notify();
  },

  openEditCard(cardId: string): void {
    this.editingCardId = cardId;
    this.editingStateId = null;
    this.editingSwimlaneId = null;
    this.notify();
  },

  closeCardDialog(): void {
    this.editingCardId = null;
    this.editingStateId = null;
    this.editingSwimlaneId = null;
    this.notify();
  },

  openBoardConfig(): void {
    this.configuringBoard = true;
    this.notify();
  },

  closeBoardConfig(): void {
    this.configuringBoard = false;
    this.notify();
  },

  triggerRefresh(): void {
    this.refreshCount++;
    this.notify();
  },

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  },

  notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  },

  reset(): void {
    this.selectedBoardId = null;
    this.boards = [];
    this.refreshCount = 0;
    this.editingCardId = null;
    this.editingStateId = null;
    this.editingSwimlaneId = null;
    this.configuringBoard = false;
    this.listeners.clear();
  },
};
