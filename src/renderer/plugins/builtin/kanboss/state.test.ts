import { describe, it, expect, vi, beforeEach } from 'vitest';
import { kanBossState } from './state';

describe('kanBossState', () => {
  beforeEach(() => {
    kanBossState.reset();
  });

  it('initial state is null/empty', () => {
    expect(kanBossState.selectedBoardId).toBeNull();
    expect(kanBossState.boards).toEqual([]);
    expect(kanBossState.refreshCount).toBe(0);
    expect(kanBossState.editingCardId).toBeNull();
    expect(kanBossState.configuringBoard).toBe(false);
  });

  it('selectBoard sets selectedBoardId and closes dialogs', () => {
    kanBossState.editingCardId = 'card-1';
    kanBossState.configuringBoard = true;

    kanBossState.selectBoard('board-1');

    expect(kanBossState.selectedBoardId).toBe('board-1');
    expect(kanBossState.editingCardId).toBeNull();
    expect(kanBossState.configuringBoard).toBe(false);
  });

  it('selectBoard(null) clears selection', () => {
    kanBossState.selectBoard('board-1');
    kanBossState.selectBoard(null);
    expect(kanBossState.selectedBoardId).toBeNull();
  });

  it('openNewCard sets editing state for new card', () => {
    kanBossState.openNewCard('state-1', 'lane-1');

    expect(kanBossState.editingCardId).toBe('new');
    expect(kanBossState.editingStateId).toBe('state-1');
    expect(kanBossState.editingSwimlaneId).toBe('lane-1');
  });

  it('openEditCard sets editing state for existing card', () => {
    kanBossState.openEditCard('card-123');

    expect(kanBossState.editingCardId).toBe('card-123');
    expect(kanBossState.editingStateId).toBeNull();
    expect(kanBossState.editingSwimlaneId).toBeNull();
  });

  it('closeCardDialog clears all editing state', () => {
    kanBossState.openNewCard('state-1', 'lane-1');
    kanBossState.closeCardDialog();

    expect(kanBossState.editingCardId).toBeNull();
    expect(kanBossState.editingStateId).toBeNull();
    expect(kanBossState.editingSwimlaneId).toBeNull();
  });

  it('openBoardConfig / closeBoardConfig toggles flag', () => {
    kanBossState.openBoardConfig();
    expect(kanBossState.configuringBoard).toBe(true);

    kanBossState.closeBoardConfig();
    expect(kanBossState.configuringBoard).toBe(false);
  });

  it('triggerRefresh increments counter', () => {
    expect(kanBossState.refreshCount).toBe(0);
    kanBossState.triggerRefresh();
    expect(kanBossState.refreshCount).toBe(1);
    kanBossState.triggerRefresh();
    expect(kanBossState.refreshCount).toBe(2);
  });

  it('subscribe/notify calls listeners', () => {
    const listener = vi.fn();
    kanBossState.subscribe(listener);

    kanBossState.selectBoard('board-1');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribe returns unsubscribe function', () => {
    const listener = vi.fn();
    const unsub = kanBossState.subscribe(listener);

    kanBossState.triggerRefresh();
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    kanBossState.triggerRefresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reset clears everything including listeners', () => {
    const listener = vi.fn();
    kanBossState.subscribe(listener);
    kanBossState.selectBoard('board-1');
    kanBossState.openBoardConfig();

    kanBossState.reset();

    expect(kanBossState.selectedBoardId).toBeNull();
    expect(kanBossState.boards).toEqual([]);
    expect(kanBossState.refreshCount).toBe(0);
    expect(kanBossState.configuringBoard).toBe(false);
    expect(kanBossState.listeners.size).toBe(0);
  });

  it('setBoards updates boards array', () => {
    const boards = [
      { id: 'b1', name: 'Board 1', states: [], swimlanes: [], config: { maxRetries: 3, zoomLevel: 1, gitHistory: false }, createdAt: 0, updatedAt: 0 },
    ];
    kanBossState.setBoards(boards as any);
    expect(kanBossState.boards).toEqual(boards);
  });
});
