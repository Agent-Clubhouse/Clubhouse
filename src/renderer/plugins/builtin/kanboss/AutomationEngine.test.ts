import { describe, it, expect, vi, beforeEach } from 'vitest';
import { triggerAutomation, initAutomationEngine, shutdownAutomationEngine } from './AutomationEngine';
import { createMockAPI } from '../../testing';
import type { Card, Board, AutomationRun } from './types';
import { kanBossState } from './state';

function makeBoard(overrides?: Partial<Board>): Board {
  return {
    id: 'board-1',
    name: 'Test Board',
    states: [
      { id: 'state-todo', name: 'Todo', order: 0, isAutomatic: false, automationPrompt: '' },
      { id: 'state-auto', name: 'In Progress', order: 1, isAutomatic: true, automationPrompt: 'Complete the task' },
      { id: 'state-done', name: 'Done', order: 2, isAutomatic: false, automationPrompt: '' },
    ],
    swimlanes: [
      { id: 'lane-1', name: 'Default', order: 0, managerAgentId: 'agent-durable-1', evaluationAgentId: null },
    ],
    config: { maxRetries: 3, zoomLevel: 1.0, gitHistory: false },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeCard(overrides?: Partial<Card>): Card {
  return {
    id: 'card-1',
    boardId: 'board-1',
    title: 'Test Card',
    body: 'Test description',
    priority: 'medium',
    stateId: 'state-auto',
    swimlaneId: 'lane-1',
    history: [],
    automationAttempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createStorageAPI(initialData: Record<string, unknown> = {}) {
  const storage: Record<string, unknown> = { ...initialData };
  return {
    read: vi.fn(async (key: string) => storage[key]),
    write: vi.fn(async (key: string, value: unknown) => { storage[key] = value; }),
    delete: vi.fn(async (key: string) => { delete storage[key]; }),
    list: vi.fn(async () => Object.keys(storage)),
  };
}

describe('AutomationEngine', () => {
  beforeEach(() => {
    kanBossState.reset();
    shutdownAutomationEngine();
  });

  describe('triggerAutomation', () => {
    it('spawns quick agent for card in automatic state with managed swimlane', async () => {
      const board = makeBoard();
      const card = makeCard();
      const storageLocal = createStorageAPI({
        'cards:board-1': [card],
        'automation-runs': [],
      });

      const api = createMockAPI({
        storage: { ...createMockAPI().storage, projectLocal: storageLocal },
        agents: {
          ...createMockAPI().agents,
          runQuick: vi.fn(async () => 'exec-agent-1'),
        },
      });

      await triggerAutomation(api, card, board);

      expect(api.agents.runQuick).toHaveBeenCalledWith(expect.stringContaining('Complete the task'));
    });

    it('does not spawn agent when state is not automatic', async () => {
      const board = makeBoard();
      const card = makeCard({ stateId: 'state-todo' });
      const runQuick = vi.fn(async () => 'agent-1');
      const api = createMockAPI({
        agents: { ...createMockAPI().agents, runQuick },
      });

      await triggerAutomation(api, card, board);

      expect(runQuick).not.toHaveBeenCalled();
    });

    it('does not spawn agent when swimlane has no manager', async () => {
      const board = makeBoard({
        swimlanes: [{ id: 'lane-1', name: 'Default', order: 0, managerAgentId: null, evaluationAgentId: null }],
      });
      const card = makeCard();
      const runQuick = vi.fn(async () => 'agent-1');
      const api = createMockAPI({
        agents: { ...createMockAPI().agents, runQuick },
      });

      await triggerAutomation(api, card, board);

      expect(runQuick).not.toHaveBeenCalled();
    });

    it('does not spawn agent when max retries exceeded', async () => {
      const board = makeBoard();
      const card = makeCard({ automationAttempts: 3 });
      const runQuick = vi.fn(async () => 'agent-1');
      const api = createMockAPI({
        agents: { ...createMockAPI().agents, runQuick },
      });

      await triggerAutomation(api, card, board);

      expect(runQuick).not.toHaveBeenCalled();
    });

    it('records automation run in storage', async () => {
      const board = makeBoard();
      const card = makeCard();
      const storageLocal = createStorageAPI({
        'cards:board-1': [card],
        'automation-runs': [],
      });

      const api = createMockAPI({
        storage: { ...createMockAPI().storage, projectLocal: storageLocal },
        agents: {
          ...createMockAPI().agents,
          runQuick: vi.fn(async () => 'exec-agent-1'),
        },
      });

      await triggerAutomation(api, card, board);

      expect(storageLocal.write).toHaveBeenCalledWith(
        'automation-runs',
        expect.arrayContaining([
          expect.objectContaining({
            cardId: 'card-1',
            executionAgentId: 'exec-agent-1',
            phase: 'executing',
          }),
        ]),
      );
    });

    it('increments automationAttempts on card', async () => {
      const card = makeCard({ automationAttempts: 0 });
      const storageLocal = createStorageAPI({
        'cards:board-1': [card],
        'automation-runs': [],
      });

      const api = createMockAPI({
        storage: { ...createMockAPI().storage, projectLocal: storageLocal },
        agents: {
          ...createMockAPI().agents,
          runQuick: vi.fn(async () => 'exec-agent-1'),
        },
      });

      await triggerAutomation(api, card, makeBoard());

      // Card should have been updated in storage with attempt incremented
      const writeCalls = storageLocal.write.mock.calls;
      const cardsWrite = writeCalls.find(([key]: [string]) => key === 'cards:board-1');
      expect(cardsWrite).toBeDefined();
      const savedCards = cardsWrite![1] as Card[];
      expect(savedCards[0].automationAttempts).toBe(1);
    });

    it('adds automation-started history entry', async () => {
      const card = makeCard({ history: [] });
      const storageLocal = createStorageAPI({
        'cards:board-1': [card],
        'automation-runs': [],
      });

      const api = createMockAPI({
        storage: { ...createMockAPI().storage, projectLocal: storageLocal },
        agents: {
          ...createMockAPI().agents,
          runQuick: vi.fn(async () => 'exec-agent-1'),
        },
      });

      await triggerAutomation(api, card, makeBoard());

      const writeCalls = storageLocal.write.mock.calls;
      const cardsWrite = writeCalls.find(([key]: [string]) => key === 'cards:board-1');
      const savedCards = cardsWrite![1] as Card[];
      expect(savedCards[0].history.some((h) => h.action === 'automation-started')).toBe(true);
    });
  });

  describe('initAutomationEngine / shutdownAutomationEngine', () => {
    it('initAutomationEngine subscribes to onStatusChange', () => {
      const api = createMockAPI();
      const spy = vi.spyOn(api.agents, 'onStatusChange');

      const sub = initAutomationEngine(api);

      expect(spy).toHaveBeenCalledWith(expect.any(Function));
      expect(sub).toHaveProperty('dispose');

      shutdownAutomationEngine();
    });

    it('shutdownAutomationEngine does not throw', () => {
      expect(() => shutdownAutomationEngine()).not.toThrow();
    });
  });
});
