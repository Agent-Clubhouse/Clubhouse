import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sessionsState } from './state';

describe('sessionsState', () => {
  beforeEach(() => {
    sessionsState.reset();
  });

  // ── Initial state ──────────────────────────────────────────────────

  it('selectedAgent starts null', () => {
    expect(sessionsState.selectedAgent).toBeNull();
  });

  it('selectedSessionId starts null', () => {
    expect(sessionsState.selectedSessionId).toBeNull();
  });

  it('expandedAgents starts empty', () => {
    expect(sessionsState.expandedAgents.size).toBe(0);
  });

  it('playback starts with defaults', () => {
    expect(sessionsState.playback).toEqual({
      playing: false,
      speed: 1,
      currentEventIndex: 0,
    });
  });

  // ── setSelectedAgent ───────────────────────────────────────────────

  it('setSelectedAgent updates value and notifies', () => {
    const listener = vi.fn();
    sessionsState.subscribe(listener);
    const agent = { agentId: 'a1', agentName: 'Alpha', kind: 'durable' as const };
    sessionsState.setSelectedAgent(agent);
    expect(sessionsState.selectedAgent).toBe(agent);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setSelectedAgent to null clears selection', () => {
    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedAgent(null);
    expect(sessionsState.selectedAgent).toBeNull();
  });

  // ── setSelectedSession ─────────────────────────────────────────────

  it('setSelectedSession updates value and notifies', () => {
    const listener = vi.fn();
    sessionsState.subscribe(listener);
    sessionsState.setSelectedSession('session-123');
    expect(sessionsState.selectedSessionId).toBe('session-123');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setSelectedSession resets playback', () => {
    sessionsState.setPlaybackIndex(5);
    sessionsState.setPlaybackPlaying(true);
    sessionsState.setSelectedSession('new-session');
    expect(sessionsState.playback.currentEventIndex).toBe(0);
    expect(sessionsState.playback.playing).toBe(false);
    expect(sessionsState.playback.speed).toBe(1);
  });

  // ── toggleExpandedAgent ────────────────────────────────────────────

  it('toggleExpandedAgent adds agent when not present', () => {
    sessionsState.toggleExpandedAgent('a1');
    expect(sessionsState.expandedAgents.has('a1')).toBe(true);
  });

  it('toggleExpandedAgent removes agent when already present', () => {
    sessionsState.toggleExpandedAgent('a1');
    sessionsState.toggleExpandedAgent('a1');
    expect(sessionsState.expandedAgents.has('a1')).toBe(false);
  });

  it('toggleExpandedAgent notifies listeners', () => {
    const listener = vi.fn();
    sessionsState.subscribe(listener);
    sessionsState.toggleExpandedAgent('a1');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('toggleExpandedAgent produces a new Set reference (required for useSyncExternalStore)', () => {
    const before = sessionsState.expandedAgents;
    sessionsState.toggleExpandedAgent('a1');
    const after = sessionsState.expandedAgents;
    expect(before).not.toBe(after);
  });

  // ── Playback ───────────────────────────────────────────────────────

  it('setPlaybackPlaying updates playing state', () => {
    sessionsState.setPlaybackPlaying(true);
    expect(sessionsState.playback.playing).toBe(true);
    sessionsState.setPlaybackPlaying(false);
    expect(sessionsState.playback.playing).toBe(false);
  });

  it('setPlaybackSpeed updates speed', () => {
    sessionsState.setPlaybackSpeed(3);
    expect(sessionsState.playback.speed).toBe(3);
    sessionsState.setPlaybackSpeed(5);
    expect(sessionsState.playback.speed).toBe(5);
  });

  it('setPlaybackIndex updates currentEventIndex', () => {
    sessionsState.setPlaybackIndex(42);
    expect(sessionsState.playback.currentEventIndex).toBe(42);
  });

  it('playback changes notify listeners', () => {
    const listener = vi.fn();
    sessionsState.subscribe(listener);
    sessionsState.setPlaybackPlaying(true);
    sessionsState.setPlaybackSpeed(5);
    sessionsState.setPlaybackIndex(10);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  // ── subscribe/unsubscribe ──────────────────────────────────────────

  it('subscribe returns unsubscribe function', () => {
    const listener = vi.fn();
    const unsub = sessionsState.subscribe(listener);
    sessionsState.setSelectedSession('s1');
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    sessionsState.setSelectedSession('s2');
    expect(listener).toHaveBeenCalledTimes(1); // not called again
  });

  it('multiple listeners all receive notifications', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    sessionsState.subscribe(l1);
    sessionsState.subscribe(l2);
    sessionsState.setSelectedSession('s1');
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it('double-unsubscribe is safe', () => {
    const listener = vi.fn();
    const unsub = sessionsState.subscribe(listener);
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  // ── reset ──────────────────────────────────────────────────────────

  it('reset clears all state', () => {
    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('s1');
    sessionsState.toggleExpandedAgent('a1');
    sessionsState.setPlaybackPlaying(true);

    sessionsState.reset();

    expect(sessionsState.selectedAgent).toBeNull();
    expect(sessionsState.selectedSessionId).toBeNull();
    expect(sessionsState.expandedAgents.size).toBe(0);
    expect(sessionsState.playback).toEqual({ playing: false, speed: 1, currentEventIndex: 0 });
  });

  it('reset clears listeners so further changes do not notify', () => {
    const listener = vi.fn();
    sessionsState.subscribe(listener);
    sessionsState.reset();
    sessionsState.setSelectedSession('s2');
    expect(listener).not.toHaveBeenCalled();
  });

  // ── Session list persistence (Bug 5 fix) ─────────────────────────

  it('sessionLists starts empty', () => {
    expect(sessionsState.sessionLists).toEqual({});
  });

  it('setSessionList stores sessions for an agent and notifies', () => {
    const listener = vi.fn();
    sessionsState.subscribe(listener);
    const sessions = [{ sessionId: 's1', startedAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T01:00:00Z' }];
    sessionsState.setSessionList('agent-1', sessions);
    expect(sessionsState.sessionLists['agent-1']).toEqual(sessions);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setSessionList produces a new object reference', () => {
    const before = sessionsState.sessionLists;
    sessionsState.setSessionList('agent-1', []);
    expect(sessionsState.sessionLists).not.toBe(before);
  });

  it('loadingAgents starts empty', () => {
    expect(sessionsState.loadingAgents.size).toBe(0);
  });

  it('setLoadingAgent adds/removes and notifies', () => {
    const listener = vi.fn();
    sessionsState.subscribe(listener);
    sessionsState.setLoadingAgent('a1', true);
    expect(sessionsState.loadingAgents.has('a1')).toBe(true);
    sessionsState.setLoadingAgent('a1', false);
    expect(sessionsState.loadingAgents.has('a1')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('fetchedAgents starts empty', () => {
    expect(sessionsState.fetchedAgents.size).toBe(0);
  });

  it('markFetched adds agent without notifying listeners', () => {
    const listener = vi.fn();
    sessionsState.subscribe(listener);
    sessionsState.markFetched('a1');
    expect(sessionsState.fetchedAgents.has('a1')).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('reset clears session lists, loading, and fetched state', () => {
    sessionsState.setSessionList('a1', [{ sessionId: 's1', startedAt: '', lastActiveAt: '' }]);
    sessionsState.setLoadingAgent('a2', true);
    sessionsState.markFetched('a1');

    sessionsState.reset();

    expect(sessionsState.sessionLists).toEqual({});
    expect(sessionsState.loadingAgents.size).toBe(0);
    expect(sessionsState.fetchedAgents.size).toBe(0);
  });

  it('sessionLists survive across subscribe/unsubscribe cycles (simulating unmount/remount)', () => {
    // Simulate first mount: load sessions
    const sessions = [{ sessionId: 's1', startedAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T01:00:00Z' }];
    sessionsState.setSessionList('agent-1', sessions);
    sessionsState.markFetched('agent-1');
    sessionsState.toggleExpandedAgent('agent-1');

    // Simulate unmount: unsubscribe listener
    const unsub = sessionsState.subscribe(vi.fn());
    unsub();

    // Simulate remount: session data should still be there
    expect(sessionsState.sessionLists['agent-1']).toEqual(sessions);
    expect(sessionsState.fetchedAgents.has('agent-1')).toBe(true);
    expect(sessionsState.expandedAgents.has('agent-1')).toBe(true);
  });
});
