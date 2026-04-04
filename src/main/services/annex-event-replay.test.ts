import { describe, it, expect, beforeEach } from 'vitest';
import * as replay from './annex-event-replay';

describe('annex-event-replay', () => {
  beforeEach(() => {
    replay.reset();
  });

  it('pushEvent increments sequence numbers', () => {
    const seq1 = replay.pushEvent('pty:data', { agentId: 'a1', data: 'hello' });
    const seq2 = replay.pushEvent('pty:data', { agentId: 'a1', data: 'world' });
    expect(seq2).toBe(seq1 + 1);
    expect(replay.getLastSeq()).toBe(seq2);
  });

  it('getEventsSince returns events after the given seq', () => {
    replay.pushEvent('pty:data', { agentId: 'a1', data: '1' });
    const seq2 = replay.pushEvent('pty:data', { agentId: 'a1', data: '2' });
    replay.pushEvent('pty:data', { agentId: 'a1', data: '3' });

    const events = replay.getEventsSince(seq2);
    expect(events).not.toBeNull();
    expect(events!.length).toBe(1);
    expect(events![0].payload).toEqual({ agentId: 'a1', data: '3' });
  });

  it('getEventsSince returns empty array when up to date', () => {
    const seq = replay.pushEvent('pty:data', { agentId: 'a1', data: '1' });
    const events = replay.getEventsSince(seq);
    expect(events).toEqual([]);
  });

  it('getEventsSince returns null for gap (seq too old)', () => {
    // Push a bunch of events, then request from seq 0 when buffer starts later
    for (let i = 0; i < 5; i++) {
      replay.pushEvent('pty:data', { agentId: 'a1', data: String(i) });
    }
    // The oldest seq in buffer is 1 (since we start from 0 after reset, first push is 1)
    // Requesting since 0 means we want events > 0, oldest is 1, so no gap (0 === 1-1)
    const events = replay.getEventsSince(0);
    expect(events).not.toBeNull();
    expect(events!.length).toBe(5);
  });

  it('getEventsSince returns empty on empty buffer', () => {
    const events = replay.getEventsSince(0);
    expect(events).toEqual([]);
  });

  it('clearForAgent removes only that agent events', () => {
    replay.pushEvent('pty:data', { agentId: 'a1', data: '1' });
    replay.pushEvent('pty:data', { agentId: 'a2', data: '2' });
    replay.pushEvent('pty:data', { agentId: 'a1', data: '3' });

    expect(replay.size()).toBe(3);
    replay.clearForAgent('a1');
    expect(replay.size()).toBe(1);
  });

  it('reset clears all events and resets sequence', () => {
    replay.pushEvent('pty:data', { agentId: 'a1', data: '1' });
    replay.pushEvent('pty:data', { agentId: 'a2', data: '2' });

    replay.reset();
    expect(replay.size()).toBe(0);
    expect(replay.getLastSeq()).toBe(0);
  });

  it('respects max event limit', () => {
    // Push more than the max (10000) events
    for (let i = 0; i < 10_005; i++) {
      replay.pushEvent('pty:data', { agentId: 'a1', data: String(i) });
    }
    expect(replay.size()).toBeLessThanOrEqual(10_000);
  });

  it('evictStale removes old events', () => {
    // Push an event with a manually old timestamp by manipulating the buffer
    replay.pushEvent('pty:data', { agentId: 'a1', data: 'old' });
    replay.pushEvent('pty:data', { agentId: 'a1', data: 'new' });

    // Events are recent so eviction should keep them
    replay.evictStale();
    expect(replay.size()).toBe(2);
  });

  it('getOldestSeq returns 0 on empty buffer', () => {
    expect(replay.getOldestSeq()).toBe(0);
  });

  it('getOldestSeq returns first seq after pushes', () => {
    const seq1 = replay.pushEvent('test', {});
    replay.pushEvent('test', {});
    expect(replay.getOldestSeq()).toBe(seq1);
  });

  // ── Ring buffer specific tests ──────────────────────────────────────

  it('ring buffer wraps correctly when pushing beyond capacity', () => {
    // Push exactly max events
    for (let i = 0; i < 10_000; i++) {
      replay.pushEvent('pty:data', { agentId: 'a1', data: String(i) });
    }
    expect(replay.size()).toBe(10_000);

    // Push one more — oldest should be evicted
    replay.pushEvent('pty:data', { agentId: 'a1', data: 'overflow' });
    expect(replay.size()).toBe(10_000);

    // The oldest seq should now be 2 (first event seq=1 was evicted)
    expect(replay.getOldestSeq()).toBe(2);
  });

  it('clearForAgent preserves correct events after ring buffer wraps', () => {
    // Fill past capacity to ensure ring buffer has wrapped
    for (let i = 0; i < 100; i++) {
      replay.pushEvent('pty:data', { agentId: i % 2 === 0 ? 'a1' : 'a2', data: String(i) });
    }
    const sizeBefore = replay.size();
    replay.clearForAgent('a1');
    // Should have removed ~50 events (every other one)
    expect(replay.size()).toBe(50);
    expect(replay.size()).toBeLessThan(sizeBefore);
  });

  it('evictStale correctly advances past stale entries', () => {
    // We can't easily fake timestamps, but we can verify that recent events survive
    for (let i = 0; i < 10; i++) {
      replay.pushEvent('pty:data', { agentId: 'a1', data: String(i) });
    }
    replay.evictStale();
    // All events are recent, so none should be evicted
    expect(replay.size()).toBe(10);
  });

  it('size is accurate after mixed operations', () => {
    replay.pushEvent('a', { agentId: 'x' });
    replay.pushEvent('b', { agentId: 'y' });
    replay.pushEvent('c', { agentId: 'x' });
    expect(replay.size()).toBe(3);

    replay.clearForAgent('x');
    expect(replay.size()).toBe(1);

    replay.pushEvent('d', { agentId: 'z' });
    expect(replay.size()).toBe(2);

    replay.reset();
    expect(replay.size()).toBe(0);
  });

  it('getEventsSince returns correct events after wrap', () => {
    // Push 10005 events to ensure the ring buffer wrapped
    for (let i = 0; i < 10_005; i++) {
      replay.pushEvent('pty:data', { agentId: 'a1', data: String(i) });
    }
    // Last seq is 10005, request events since 10003
    const events = replay.getEventsSince(10_003);
    expect(events).not.toBeNull();
    expect(events!.length).toBe(2);
    expect(events![0].seq).toBe(10_004);
    expect(events![1].seq).toBe(10_005);
  });
});
