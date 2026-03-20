import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeActivityState,
  wireKeyFromActivity,
  recordActivity,
  getWireTimestamps,
  _resetForTesting,
  ACTIVITY_DECAY_MS,
} from './useWireActivity';
import type { ToolActivityEvent } from './useWireActivity';

describe('useWireActivity', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe('wireKeyFromActivity', () => {
    it('builds wire key from source and target', () => {
      expect(wireKeyFromActivity('agent-1', 'agent-2')).toBe('agent-1--agent-2');
    });
  });

  describe('computeActivityState', () => {
    it('returns idle when not alive', () => {
      expect(computeActivityState(undefined, Date.now(), false)).toBe('idle');
    });

    it('returns ambient when alive with no timestamps', () => {
      expect(computeActivityState(undefined, Date.now(), true)).toBe('ambient');
    });

    it('returns ambient when all timestamps are expired', () => {
      const now = Date.now();
      const ts = { lastForward: now - ACTIVITY_DECAY_MS - 1, lastReverse: 0 };
      expect(computeActivityState(ts, now, true)).toBe('ambient');
    });

    it('returns active-forward when forward is recent', () => {
      const now = Date.now();
      const ts = { lastForward: now - 100, lastReverse: 0 };
      expect(computeActivityState(ts, now, true)).toBe('active-forward');
    });

    it('returns active-reverse when reverse is recent', () => {
      const now = Date.now();
      const ts = { lastForward: 0, lastReverse: now - 100 };
      expect(computeActivityState(ts, now, true)).toBe('active-reverse');
    });

    it('returns active-both when both are recent', () => {
      const now = Date.now();
      const ts = { lastForward: now - 100, lastReverse: now - 200 };
      expect(computeActivityState(ts, now, true)).toBe('active-both');
    });

    it('returns active-forward when only forward is within decay window', () => {
      const now = Date.now();
      const ts = {
        lastForward: now - 100,
        lastReverse: now - ACTIVITY_DECAY_MS - 1, // expired
      };
      expect(computeActivityState(ts, now, true)).toBe('active-forward');
    });
  });

  describe('recordActivity', () => {
    it('records forward activity', () => {
      const event: ToolActivityEvent = {
        sourceAgentId: 'agent-1',
        targetId: 'agent-2',
        direction: 'forward',
        toolSuffix: 'send_message',
        timestamp: 1000,
      };
      recordActivity(event);

      const ts = getWireTimestamps('agent-1--agent-2');
      expect(ts).toBeDefined();
      expect(ts!.lastForward).toBe(1000);
      expect(ts!.lastReverse).toBe(0);
    });

    it('records reverse activity', () => {
      const event: ToolActivityEvent = {
        sourceAgentId: 'agent-1',
        targetId: 'agent-2',
        direction: 'reverse',
        toolSuffix: 'read_output',
        timestamp: 2000,
      };
      recordActivity(event);

      const ts = getWireTimestamps('agent-1--agent-2');
      expect(ts).toBeDefined();
      expect(ts!.lastReverse).toBe(2000);
    });

    it('accumulates forward and reverse timestamps', () => {
      recordActivity({
        sourceAgentId: 'agent-1', targetId: 'agent-2',
        direction: 'forward', toolSuffix: 'send_message', timestamp: 1000,
      });
      recordActivity({
        sourceAgentId: 'agent-1', targetId: 'agent-2',
        direction: 'reverse', toolSuffix: 'read_output', timestamp: 2000,
      });

      const ts = getWireTimestamps('agent-1--agent-2');
      expect(ts!.lastForward).toBe(1000);
      expect(ts!.lastReverse).toBe(2000);
    });

    it('updates reverse key for bidirectional wires', () => {
      // When agent-1 sends to agent-2, the reverse key agent-2--agent-1
      // should also be updated (with swapped direction)
      recordActivity({
        sourceAgentId: 'agent-1', targetId: 'agent-2',
        direction: 'forward', toolSuffix: 'send_message', timestamp: 1000,
      });

      const reverseTs = getWireTimestamps('agent-2--agent-1');
      expect(reverseTs).toBeDefined();
      expect(reverseTs!.lastReverse).toBe(1000); // forward from A→B is reverse from B's perspective
    });

    it('resets cleanly for testing', () => {
      recordActivity({
        sourceAgentId: 'agent-1', targetId: 'agent-2',
        direction: 'forward', toolSuffix: 'send_message', timestamp: 1000,
      });
      _resetForTesting();
      expect(getWireTimestamps('agent-1--agent-2')).toBeUndefined();
    });
  });

  describe('direction inference', () => {
    it('read_output maps to reverse direction', () => {
      // This tests the convention: read_output = data flowing FROM target
      recordActivity({
        sourceAgentId: 'agent-1', targetId: 'agent-2',
        direction: 'reverse', toolSuffix: 'read_output', timestamp: 1000,
      });
      const ts = getWireTimestamps('agent-1--agent-2');
      expect(ts!.lastReverse).toBe(1000);
      expect(ts!.lastForward).toBe(0);
    });

    it('send_message maps to forward direction', () => {
      recordActivity({
        sourceAgentId: 'agent-1', targetId: 'agent-2',
        direction: 'forward', toolSuffix: 'send_message', timestamp: 1000,
      });
      const ts = getWireTimestamps('agent-1--agent-2');
      expect(ts!.lastForward).toBe(1000);
      expect(ts!.lastReverse).toBe(0);
    });
  });
});
