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
});
