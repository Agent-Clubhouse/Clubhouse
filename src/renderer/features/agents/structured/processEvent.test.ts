import { describe, it, expect } from 'vitest';
import { processEvent, initialState, MAX_EVENTS } from './StructuredAgentView';
import type { ViewState } from './StructuredAgentView';
import type { StructuredEvent } from '../../../../shared/structured-events';

/**
 * Unit tests for processEvent lazy-copy optimization (Issue #630).
 *
 * These tests verify that processEvent only clones data structures
 * that are actually mutated by each event type, rather than eagerly
 * copying feedItems on every event.
 */

function makeState(overrides: Partial<ViewState> = {}): ViewState {
  return { ...initialState, ...overrides };
}

function ts(): number {
  return Date.now();
}

describe('processEvent – lazy copy optimization', () => {
  // ── Reference stability: events that don't touch feedItems ──────────

  describe('plan_update does not copy feedItems', () => {
    it('preserves the feedItems reference', () => {
      const feedItems = [{ kind: 'text' as const, text: 'hi', isStreaming: false, key: 0 }];
      const prev = makeState({ feedItems });

      const next = processEvent(prev, {
        type: 'plan_update',
        timestamp: ts(),
        data: { steps: [{ description: 'step 1', status: 'pending' }] },
      } as StructuredEvent);

      expect(next.feedItems).toBe(feedItems);
      expect(next.plan).toEqual({ steps: [{ description: 'step 1', status: 'pending' }] });
    });
  });

  describe('usage does not copy feedItems', () => {
    it('preserves the feedItems reference', () => {
      const feedItems = [{ kind: 'text' as const, text: 'hi', isStreaming: false, key: 0 }];
      const prev = makeState({ feedItems });

      const next = processEvent(prev, {
        type: 'usage',
        timestamp: ts(),
        data: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
      } as StructuredEvent);

      expect(next.feedItems).toBe(feedItems);
    });
  });

  // ── Feed-only events clone the feed and assign stable keys ─────────

  describe('appending events assign increasing stable keys', () => {
    it('gives each new feed item the next key', () => {
      let state = makeState();
      state = processEvent(state, { type: 'text_delta', timestamp: ts(), data: { text: 'hi' } } as StructuredEvent);
      state = processEvent(state, {
        type: 'tool_start', timestamp: ts(),
        data: { id: 't1', name: 'Read', displayVerb: 'Reading', input: {} },
      } as StructuredEvent);
      state = processEvent(state, { type: 'error', timestamp: ts(), data: { code: 'E', message: 'x' } } as StructuredEvent);

      expect(state.feedItems.map((i) => i.key)).toEqual([0, 1, 2]);
      expect(state.nextKey).toBe(3);
    });
  });

  describe('tool_output updates the tool in place', () => {
    it('clones the feed and keeps the item key', () => {
      const feedItems = [
        { kind: 'tool' as const, tool: { id: 't1', name: 'Read', displayVerb: 'Reading', input: {} }, output: '', status: 'running' as const, key: 7 },
      ];
      const prev = makeState({ feedItems, nextKey: 8 });

      const next = processEvent(prev, {
        type: 'tool_output',
        timestamp: ts(),
        data: { id: 't1', output: 'file contents', isPartial: false },
      } as StructuredEvent);

      expect(next.feedItems).not.toBe(feedItems); // feed IS cloned
      expect(next.feedItems[0]).toMatchObject({ output: 'file contents', key: 7 });
      expect(next.nextKey).toBe(8);
    });
  });

  describe('command_output (existing command) updates in place', () => {
    it('replaces the command item and keeps its key', () => {
      const feedItems = [
        { kind: 'command' as const, command: { id: 'cmd1', command: 'npm test', status: 'running', output: 'line 1' }, key: 3 },
      ];
      const prev = makeState({ feedItems, nextKey: 4 });

      const next = processEvent(prev, {
        type: 'command_output',
        timestamp: ts(),
        data: { id: 'cmd1', command: 'npm test', status: 'completed', output: 'line 1\nline 2', exitCode: 0 },
      } as StructuredEvent);

      expect(next.feedItems).toHaveLength(1);
      expect(next.feedItems[0]).toMatchObject({ key: 3, command: { status: 'completed' } });
      expect(next.nextKey).toBe(4);
    });
  });

  // ── No-op returns prev identity ────────────────────────────────────

  describe('tool_output for unknown tool returns prev', () => {
    it('returns same state reference when tool ID is not found', () => {
      const prev = makeState({
        feedItems: [{ kind: 'text' as const, text: 'hi', isStreaming: false, key: 0 }],
      });

      const next = processEvent(prev, {
        type: 'tool_output',
        timestamp: ts(),
        data: { id: 'nonexistent', output: 'data', isPartial: false },
      } as StructuredEvent);

      expect(next).toBe(prev); // exact same object, no re-render
    });
  });

  describe('tool_end for unknown tool returns prev', () => {
    it('returns same state reference when tool ID is not found', () => {
      const prev = makeState({
        feedItems: [{ kind: 'text' as const, text: 'hi', isStreaming: false, key: 0 }],
      });

      const next = processEvent(prev, {
        type: 'tool_end',
        timestamp: ts(),
        data: { id: 'nonexistent', name: 'Read', result: 'ok', durationMs: 10, status: 'success' },
      } as StructuredEvent);

      expect(next).toBe(prev);
    });
  });

  describe('end without summary does not copy feedItems', () => {
    it('preserves feedItems reference when no summary', () => {
      const feedItems = [{ kind: 'text' as const, text: 'hi', isStreaming: false, key: 0 }];
      const prev = makeState({ feedItems });

      const next = processEvent(prev, {
        type: 'end',
        timestamp: ts(),
        data: { reason: 'complete' },
      } as StructuredEvent);

      expect(next.feedItems).toBe(feedItems);
      expect(next.isComplete).toBe(true);
    });
  });

  // ── Functional correctness ─────────────────────────────────────────

  describe('consecutive text_deltas merge into one item', () => {
    it('appends text to the last streaming item', () => {
      let state = makeState();
      state = processEvent(state, {
        type: 'text_delta', timestamp: ts(), data: { text: 'a' },
      } as StructuredEvent);
      state = processEvent(state, {
        type: 'text_delta', timestamp: ts(), data: { text: 'b' },
      } as StructuredEvent);
      state = processEvent(state, {
        type: 'text_delta', timestamp: ts(), data: { text: 'c' },
      } as StructuredEvent);

      expect(state.feedItems).toHaveLength(1);
      expect(state.feedItems[0]).toEqual({ kind: 'text', text: 'abc', isStreaming: true, key: 0 });
    });
  });

  describe('usage accumulates across events', () => {
    it('sums inputTokens and outputTokens', () => {
      let state = makeState();
      state = processEvent(state, {
        type: 'usage', timestamp: ts(),
        data: { inputTokens: 1000, outputTokens: 500, costUsd: 0.003 },
      } as StructuredEvent);
      state = processEvent(state, {
        type: 'usage', timestamp: ts(),
        data: { inputTokens: 500, outputTokens: 200, costUsd: 0.001 },
      } as StructuredEvent);

      expect(state.usage).toEqual({
        inputTokens: 1500,
        outputTokens: 700,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.004,
      });
    });
  });

  describe('feed cap at MAX_EVENTS', () => {
    it('trims older items when feed exceeds MAX_EVENTS', () => {
      let state = makeState();
      for (let i = 0; i < MAX_EVENTS + 10; i++) {
        state = processEvent(state, {
          type: 'error', timestamp: ts(),
          data: { code: 'E', message: `error-${i}` },
        } as StructuredEvent);
      }

      expect(state.feedItems).toHaveLength(MAX_EVENTS);
      // First item should be error-10 (oldest 10 were trimmed)
      const first = state.feedItems[0];
      expect(first.kind).toBe('error');
      if (first.kind === 'error') {
        expect(first.error.message).toBe('error-10');
      }
    });
  });

  // ── ID-based association survives trimming (audit finding 10b) ─────

  describe('tool events after the feed is trimmed', () => {
    function toolStart(id: string): StructuredEvent {
      return { type: 'tool_start', timestamp: ts(), data: { id, name: 'Read', displayVerb: id, input: {} } } as StructuredEvent;
    }
    function toolEnd(id: string): StructuredEvent {
      return {
        type: 'tool_end', timestamp: ts(),
        data: { id, name: 'Read', result: 'ok', durationMs: 1, status: 'success' },
      } as StructuredEvent;
    }

    function trimmedState(): ViewState {
      let state = makeState();
      state = processEvent(state, toolStart('A'));
      state = processEvent(state, toolStart('B'));
      // Push just enough to trim exactly one item (A) off the front.
      for (let i = 0; i < MAX_EVENTS - 1; i++) {
        state = processEvent(state, {
          type: 'error', timestamp: ts(), data: { code: 'E', message: `e-${i}` },
        } as StructuredEvent);
      }
      expect(state.feedItems).toHaveLength(MAX_EVENTS);
      expect(state.feedItems[0]).toMatchObject({ kind: 'tool', tool: { id: 'B' } });
      return state;
    }

    it('does not attach a trimmed tool\'s completion to a different card', () => {
      const state = trimmedState();
      const next = processEvent(state, toolEnd('A'));
      expect(next).toBe(state);
      expect(next.feedItems[0]).toMatchObject({ tool: { id: 'B' }, status: 'running' });
    });

    it('still delivers output and completion to a surviving tool', () => {
      let state = trimmedState();
      state = processEvent(state, {
        type: 'tool_output', timestamp: ts(), data: { id: 'B', output: 'b-out', isPartial: false },
      } as StructuredEvent);
      state = processEvent(state, toolEnd('B'));
      expect(state.feedItems[0]).toMatchObject({ tool: { id: 'B' }, output: 'b-out', status: 'completed' });
    });

    it('keeps keys unique and stable across the trim', () => {
      const state = trimmedState();
      const keys = state.feedItems.map((i) => i.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(state.feedItems[0].key).toBe(1); // B's original key
    });
  });
});
