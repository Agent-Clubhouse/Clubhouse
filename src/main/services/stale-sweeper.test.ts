import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StaleSweeper } from './stale-sweeper';

describe('StaleSweeper', () => {
  let sessions: Map<string, { alive: boolean }>;
  let isStale: ReturnType<typeof vi.fn>;
  let onStale: ReturnType<typeof vi.fn>;
  let sweeper: StaleSweeper<{ alive: boolean }>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessions = new Map();
    isStale = vi.fn((_id, s) => !s.alive);
    onStale = vi.fn();
    sweeper = new StaleSweeper(sessions, { isStale, onStale });
  });

  afterEach(() => {
    sweeper.stop();
    vi.useRealTimers();
  });

  it('start and stop are idempotent', () => {
    sweeper.start();
    sweeper.start(); // no-op
    sweeper.stop();
    sweeper.stop(); // no-op
  });

  it('calls onStale for sessions where isStale returns true', () => {
    sessions.set('a', { alive: false });
    sessions.set('b', { alive: true });

    sweeper.start();
    vi.advanceTimersByTime(30_000);

    expect(isStale).toHaveBeenCalledWith('a', { alive: false });
    expect(isStale).toHaveBeenCalledWith('b', { alive: true });
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledWith('a', { alive: false });
  });

  it('does not call onStale when all sessions are alive', () => {
    sessions.set('a', { alive: true });
    sessions.set('b', { alive: true });

    sweeper.start();
    vi.advanceTimersByTime(30_000);

    expect(onStale).not.toHaveBeenCalled();
  });

  it('does not sweep after stop is called', () => {
    sessions.set('a', { alive: false });

    sweeper.start();
    sweeper.stop();
    vi.advanceTimersByTime(60_000);

    expect(onStale).not.toHaveBeenCalled();
  });

  it('sweeps repeatedly at the configured interval', () => {
    sessions.set('a', { alive: false });

    sweeper.start();
    vi.advanceTimersByTime(30_000);
    expect(onStale).toHaveBeenCalledTimes(1);

    // Session removed by callback in real usage; re-add to verify next tick
    sessions.set('c', { alive: false });
    vi.advanceTimersByTime(30_000);
    expect(onStale).toHaveBeenCalledTimes(3); // 'a' + 'c' on second tick
  });

  it('supports a custom interval', () => {
    const fast = new StaleSweeper(sessions, { isStale, onStale }, 5_000);
    sessions.set('a', { alive: false });

    fast.start();
    vi.advanceTimersByTime(5_000);
    expect(onStale).toHaveBeenCalledTimes(1);

    fast.stop();
  });

  it('handles an empty sessions map gracefully', () => {
    sweeper.start();
    vi.advanceTimersByTime(30_000);

    expect(isStale).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });
});
