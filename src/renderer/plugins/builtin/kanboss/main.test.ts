import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activate, deactivate } from './main';
import { createMockAPI, createMockContext } from '../../testing';
import { kanBossState } from './state';

describe('KanBoss activate/deactivate', () => {
  beforeEach(() => {
    kanBossState.reset();
  });

  it('activate registers refresh and new-board commands', () => {
    const ctx = createMockContext();
    const api = createMockAPI();
    const registerSpy = vi.spyOn(api.commands, 'register');

    activate(ctx, api);

    expect(registerSpy).toHaveBeenCalledWith('refresh', expect.any(Function));
    expect(registerSpy).toHaveBeenCalledWith('new-board', expect.any(Function));
  });

  it('activate pushes subscriptions to context', () => {
    const ctx = createMockContext();
    const api = createMockAPI();

    activate(ctx, api);

    // Should have: refreshCmd, newBoardCmd, automationSub
    expect(ctx.subscriptions.length).toBeGreaterThanOrEqual(3);
  });

  it('activate sets up onStatusChange for automation engine', () => {
    const ctx = createMockContext();
    const api = createMockAPI();
    const statusSpy = vi.spyOn(api.agents, 'onStatusChange');

    activate(ctx, api);

    expect(statusSpy).toHaveBeenCalledWith(expect.any(Function));
  });

  it('deactivate resets kanBossState', () => {
    kanBossState.selectBoard('test-board');
    expect(kanBossState.selectedBoardId).toBe('test-board');

    deactivate();

    expect(kanBossState.selectedBoardId).toBeNull();
    expect(kanBossState.boards).toEqual([]);
  });

  it('deactivate does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
