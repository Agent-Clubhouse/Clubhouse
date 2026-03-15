import { describe, it, expect } from 'vitest';
import { processEvent, initialState, MAX_EVENTS } from './StructuredAgentView';
import type { ViewState } from './StructuredAgentView';
import type { StructuredEvent } from '../../../../shared/structured-events';

/**
 * Unit tests for processEvent lazy-copy optimization (Issue #630).
 *
 * These tests verify that processEvent only clones data structures
 * that are actually mutated by each event type, rather than eagerly
 * copying feedItems + both Maps on every event.
 */

function makeState(overrides: Partial<ViewState> = {}): ViewState {
  return { ...initialState, ...overrides };
}

function ts(): number {
  return Date.now();
}

describe('processEvent – lazy copy optimization', () => {
  // ── Reference stability: events that don't touch feedItems ──────────

  describe('plan_update does not copy feedItems or maps', () => {
    it('preserves feedItems, toolIndexMap, and commandIndexMap references', () => {
      const feedItems = [{ kind: 'text' as const, text: 'hi', isStreaming: false }];
      const toolIndexMap = new Map([['t1', 0]]);
      const commandIndexMap = new Map([['c1', 0]]);
      const prev = makeState({ feedItems, toolIndexMap, commandIndexMap });

      const next = processEvent(prev, {
        type: 'plan_update',
        timestamp: ts(),
        data: { steps: [{ description: 'step 1', status: 'pending' }] },
      } as StructuredEvent);

      expect(next.feedItems).toBe(feedItems);
      expect(next.toolIndexMap).toBe(toolIndexMap);
      expect(next.commandIndexMap).toBe(commandIndexMap);
      expect(next.plan).toEqual({ steps: [{ description: 'step 1', status: 'pending' }] });
    });
  });

  describe('usage does not copy feedItems or maps', () => {
    it('preserves feedItems, toolIndexMap, and commandIndexMap references', () => {
      const feedItems = [{ kind: 'text' as const, text: 'hi', isStreaming: false }];
      const toolIndexMap = new Map([['t1', 0]]);
      const commandIndexMap = new Map([['c1', 0]]);
      const prev = makeState({ feedItems, toolIndexMap, commandIndexMap });

      const next = processEvent(prev, {
        type: 'usage',
        timestamp: ts(),
        data: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
      } as StructuredEvent);

      expect(next.feedItems).toBe(feedItems);
      expect(next.toolIndexMap).toBe(toolIndexMap);
      expect(next.commandIndexMap).toBe(commandIndexMap);
    });
  });

  // ── Reference stability: events that only touch feedItems ───────────

  describe('text_delta does not copy maps', () => {
    it('preserves toolIndexMap and commandIndexMap references', () => {
      const toolIndexMap = new Map([['t1', 0]]);
      const commandIndexMap = new Map([['c1', 1]]);
      const prev = makeState({ toolIndexMap, commandIndexMap });

      const next = processEvent(prev, {
        type: 'text_delta',
        timestamp: ts(),
        data: { text: 'hello' },
      } as StructuredEvent);

      expect(next.toolIndexMap).toBe(toolIndexMap);
      expect(next.commandIndexMap).toBe(commandIndexMap);
      expect(next.feedItems).not.toBe(prev.feedItems); // feed IS cloned
      expect(next.feedItems).toHaveLength(1);
    });
  });

  describe('text_done does not copy maps', () => {
    it('preserves map references', () => {
      const toolIndexMap = new Map<string, number>();
      const commandIndexMap = new Map<string, number>();
      const prev = makeState({ toolIndexMap, commandIndexMap });

      const next = processEvent(prev, {
        type: 'text_done',
        timestamp: ts(),
        data: { text: 'done' },
      } as StructuredEvent);

      expect(next.toolIndexMap).toBe(toolIndexMap);
      expect(next.commandIndexMap).toBe(commandIndexMap);
    });
  });

  describe('tool_output does not copy maps', () => {
    it('preserves toolIndexMap and commandIndexMap when updating existing tool', () => {
      const toolIndexMap = new Map([['t1', 0]]);
      const commandIndexMap = new Map<string, number>();
      const feedItems = [
        { kind: 'tool' as const, tool: { id: 't1', name: 'Read', displayVerb: 'Reading', input: {} }, output: '', status: 'running' as const },
      ];
      const prev = makeState({ feedItems, toolIndexMap, commandIndexMap });

      const next = processEvent(prev, {
        type: 'tool_output',
        timestamp: ts(),
        data: { id: 't1', output: 'file contents', isPartial: false },
      } as StructuredEvent);

      expect(next.toolIndexMap).toBe(toolIndexMap);
      expect(next.commandIndexMap).toBe(commandIndexMap);
      expect(next.feedItems).not.toBe(feedItems); // feed IS cloned
    });
  });

  describe('tool_end does not copy maps', () => {
    it('preserves map references', () => {
      const toolIndexMap = new Map([['t1', 0]]);
      const commandIndexMap = new Map<string, number>();
      const feedItems = [
        { kind: 'tool' as const, tool: { id: 't1', name: 'Read', displayVerb: 'Reading', input: {} }, output: 'data', status: 'running' as const },
      ];
      const prev = makeState({ feedItems, toolIndexMap, commandIndexMap });

      const next = processEvent(prev, {
        type: 'tool_end',
        timestamp: ts(),
        data: { id: 't1', name: 'Read', result: 'ok', durationMs: 50, status: 'success' },
      } as StructuredEvent);

      expect(next.toolIndexMap).toBe(toolIndexMap);
      expect(next.commandIndexMap).toBe(commandIndexMap);
      expect(next.feedItems).not.toBe(feedItems);
    });
  });

  describe('error does not copy maps', () => {
    it('preserves map references', () => {
      const toolIndexMap = new Map<string, number>();
      const commandIndexMap = new Map<string, number>();
      const prev = makeState({ toolIndexMap, commandIndexMap });

      const next = processEvent(prev, {
        type: 'error',
        timestamp: ts(),
        data: { code: 'ERR', message: 'oops' },
      } as StructuredEvent);

      expect(next.toolIndexMap).toBe(toolIndexMap);
      expect(next.commandIndexMap).toBe(commandIndexMap);
    });
  });

  describe('thinking does not copy maps', () => {
    it('preserves map references', () => {
      const toolIndexMap = new Map<string, number>();
      const commandIndexMap = new Map<string, number>();
      const prev = makeState({ toolIndexMap, commandIndexMap });

      const next = processEvent(prev, {
        type: 'thinking',
        timestamp: ts(),
        data: { text: 'hmm', isPartial: false },
      } as StructuredEvent);

      expect(next.toolIndexMap).toBe(toolIndexMap);
      expect(next.commandIndexMap).toBe(commandIndexMap);
    });
  });

  // ── Events that DO need to copy specific maps ──────────────────────

  describe('tool_start copies only toolIndexMap', () => {
    it('clones toolIndexMap but preserves commandIndexMap', () => {
      const toolIndexMap = new Map<string, number>();
      const commandIndexMap = new Map<string, number>();
      const prev = makeState({ toolIndexMap, commandIndexMap });

      const next = processEvent(prev, {
        type: 'tool_start',
        timestamp: ts(),
        data: { id: 't1', name: 'Read', displayVerb: 'Reading', input: {} },
      } as StructuredEvent);

      expect(next.toolIndexMap).not.toBe(toolIndexMap); // cloned
      expect(next.commandIndexMap).toBe(commandIndexMap); // preserved
      expect(next.toolIndexMap.get('t1')).toBe(0);
    });
  });

  describe('command_output (new command) copies only commandIndexMap', () => {
    it('clones commandIndexMap but preserves toolIndexMap', () => {
      const toolIndexMap = new Map<string, number>();
      const commandIndexMap = new Map<string, number>();
      const prev = makeState({ toolIndexMap, commandIndexMap });

      const next = processEvent(prev, {
        type: 'command_output',
        timestamp: ts(),
        data: { id: 'cmd1', command: 'npm test', status: 'running', output: 'ok' },
      } as StructuredEvent);

      expect(next.commandIndexMap).not.toBe(commandIndexMap); // cloned
      expect(next.toolIndexMap).toBe(toolIndexMap); // preserved
      expect(next.commandIndexMap.get('cmd1')).toBe(0);
    });
  });

  describe('command_output (existing command) preserves both maps', () => {
    it('does not clone commandIndexMap for in-place update', () => {
      const commandIndexMap = new Map([['cmd1', 0]]);
      const toolIndexMap = new Map<string, number>();
      const feedItems = [
        { kind: 'command' as const, command: { id: 'cmd1', command: 'npm test', status: 'running', output: 'line 1' } },
      ];
      const prev = makeState({ feedItems, toolIndexMap, commandIndexMap });

      const next = processEvent(prev, {
        type: 'command_output',
        timestamp: ts(),
        data: { id: 'cmd1', command: 'npm test', status: 'completed', output: 'line 1\nline 2', exitCode: 0 },
      } as StructuredEvent);

      expect(next.commandIndexMap).toBe(commandIndexMap); // preserved
      expect(next.toolIndexMap).toBe(toolIndexMap); // preserved
    });
  });

  // ── No-op returns prev identity ────────────────────────────────────

  describe('tool_output for unknown tool returns prev', () => {
    it('returns same state reference when tool ID is not found', () => {
      const prev = makeState({
        feedItems: [{ kind: 'text' as const, text: 'hi', isStreaming: false }],
        toolIndexMap: new Map(),
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
        feedItems: [{ kind: 'text' as const, text: 'hi', isStreaming: false }],
        toolIndexMap: new Map(),
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
      const feedItems = [{ kind: 'text' as const, text: 'hi', isStreaming: false }];
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
      expect(state.feedItems[0]).toEqual({ kind: 'text', text: 'abc', isStreaming: true });
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
});
