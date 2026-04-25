import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural regression tests for the granular sleeping-agent selector (PERF-1).
 *
 * The bug: CanvasWorkspace subscribed to `api.agents.onAnyChange` and incremented
 * a coarse `agentTick` counter, causing the entire 1,450-line component to re-render
 * on every agent state change — even ones that didn't affect sleeping/error status.
 *
 * The fix: replace `agentTick` with a `sleepingLocalIds` state that uses a functional
 * update with set-equality comparison, so re-renders only occur when the sleeping/error
 * agent set actually changes.
 */
describe('CanvasWorkspace — granular sleeping-agent selector (PERF-1)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, 'CanvasWorkspace.tsx'),
    'utf-8',
  );

  it('does not use coarse agentTick counter', () => {
    // The old pattern incremented a tick on every agent change, causing full re-renders.
    expect(source).not.toContain('agentTick');
    expect(source).not.toContain('setAgentTick');
  });

  it('uses sleepingLocalIds state with functional updater', () => {
    // The replacement state holds only the IDs that matter for wire dimming.
    expect(source).toContain('sleepingLocalIds');
    expect(source).toContain('setSleepingLocalIds');
  });

  it('functional updater returns previous state when set is unchanged (equality guard)', () => {
    // The guard `if (prev.size === next.size && [...prev].every(id => next.has(id))) return prev`
    // prevents React from scheduling a re-render when the sleeping set hasn't changed.
    expect(source).toContain('prev.size === next.size');
    expect(source).toContain('return prev');
  });

  it('sleepingAgentIds memo depends on sleepingLocalIds not agentTick', () => {
    // The useMemo dependency array must include sleepingLocalIds (not agentTick).
    const memoBlock = source.slice(
      source.indexOf('sleepingAgentIds = useMemo'),
      source.indexOf('Satellite pause detection'),
    );
    expect(memoBlock).toContain('sleepingLocalIds');
    expect(memoBlock).not.toContain('agentTick');
  });

  it('initializes sleepingLocalIds by scanning api.agents.list() on mount', () => {
    // The initial state function runs the same filter logic as the updater,
    // so the first render already has correct sleeping IDs.
    const startIdx = source.indexOf('sleepingLocalIds, setSleepingLocalIds');
    const initBlock = source.slice(startIdx, startIdx + 400);
    expect(initBlock).toContain("status === 'sleeping'");
    expect(initBlock).toContain("status === 'error'");
  });
});
