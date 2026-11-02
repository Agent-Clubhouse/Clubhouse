/**
 * Ownership rules for pruning sources (#2246) and explicit claims and
 * releases made on a source's behalf (#2230).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { buildToolKey } from './clubhouse-mcp/tool-registry';
import {
  claimSourceBinding,
  clearBindingRemovedByUser,
  onBindingDrawnByUser,
  consumeRestoredBinding,
  markBindingRemovedByUser,
  rebuildPersistedBindings,
  registerPersistedBindingSource,
  releaseSourceBinding,
  listSoleOwnedPairs,
  _resetPersistedBindingSourcesForTesting,
  type PersistedBinding,
} from './persisted-bindings';

const wire = (agentId: string, targetId: string): PersistedBinding => ({ agentId, targetId, targetKind: 'agent', label: targetId });
const pairs = () => bindingManager.getAllBindings().map((b) => `${b.agentId}->${b.targetId}`).sort();

/** A pruning source whose listing the test controls. */
function listSource(id: string, prune = true) {
  const listed: PersistedBinding[] = [];
  registerPersistedBindingSource({ id, prune, collect: async () => [...listed] });
  return listed;
}

beforeEach(() => {
  bindingManager._resetForTesting();
  _resetPersistedBindingSourcesForTesting();
});

describe('claimSourceBinding', () => {
  it('creates the binding as an explicit join, owned by the source', async () => {
    const listed = listSource('mine');
    listed.push(wire('a', 'b'));
    expect(claimSourceBinding('mine', wire('a', 'b'))).toBe('created');
    // Not a restore: the lifecycle announces it.
    expect(consumeRestoredBinding('a', 'b')).toBe(false);

    // Owned, so the source prunes it once it stops listing it.
    listed.length = 0;
    expect((await rebuildPersistedBindings()).sources[0]).toMatchObject({ pruned: 1 });
    expect(pairs()).toEqual([]);
  });

  it('does not own a binding that was already there', async () => {
    const canvas = listSource('canvas', false);
    canvas.push(wire('a', 'b'));
    const mine = listSource('mine');
    await rebuildPersistedBindings();

    mine.push(wire('a', 'b'));
    expect(claimSourceBinding('mine', wire('a', 'b'))).toBe('existing');
    canvas.length = 0;
    mine.length = 0;
    await rebuildPersistedBindings();
    // Neither pruning source created it, so neither removes it.
    expect(pairs()).toEqual(['a->b']);
  });

  it('keeps a pending restore silent when the pair is already bound', async () => {
    const mine = listSource('mine');
    mine.push(wire('a', 'b'));
    await rebuildPersistedBindings(); // restored: the lifecycle has not consumed the marker yet
    expect(claimSourceBinding('mine', wire('a', 'b'))).toBe('existing');
    expect(consumeRestoredBinding('a', 'b')).toBe(true);
  });

  it('refuses a pair the user removed this session and leaves the removal in place', async () => {
    listSource('mine');
    markBindingRemovedByUser('a', 'b');
    expect(claimSourceBinding('mine', wire('a', 'b'))).toBe('removed');
    expect(pairs()).toEqual([]);
    clearBindingRemovedByUser('a', 'b'); // the user draws it again
    expect(claimSourceBinding('mine', wire('a', 'b'))).toBe('created');
  });

  it('rejects an invalid binding', () => {
    expect(claimSourceBinding('mine', { ...wire('a', 'b'), targetKind: 'nope' as never })).toBe('invalid');
  });

  it('rejects a plugin binding (#2082)', () => {
    expect(claimSourceBinding('mine', { ...wire('a', 'p'), targetKind: 'plugin' })).toBe('invalid');
    expect(pairs()).toEqual([]);
  });
});

describe('relabelling a live binding (#2561)', () => {
  const named = (projectName: string): PersistedBinding => ({
    ...wire('a', 'b'), label: 'lead', agentName: 'Dispatcher', targetName: 'lead', projectName,
  });
  const live = () => bindingManager.getBindingsForAgent('a')[0];

  it('a claim updates the label fields in place and refreshes the tool names', () => {
    listSource('mine');
    claimSourceBinding('mine', named('Wardfall'));
    const before = buildToolKey(live());
    const binding = live();
    const changes = vi.fn();
    bindingManager.onChange(changes);

    expect(claimSourceBinding('mine', { ...named('Wardfall Two'), label: 'Lead', targetName: 'Lead', agentName: 'Dispatcher 2' })).toBe('existing');
    // The same binding, not unbound and bound again.
    expect(live()).toBe(binding);
    expect(live()).toMatchObject({ label: 'Lead', agentName: 'Dispatcher 2', targetName: 'Lead', projectName: 'Wardfall Two' });
    expect(buildToolKey(live())).not.toBe(before);
    expect(buildToolKey(live())).toMatch(/^Wardfall_Two_Lead_/);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith('a');
  });

  it('a claim with the same labels changes nothing', () => {
    listSource('mine');
    claimSourceBinding('mine', named('Wardfall'));
    const changes = vi.fn();
    bindingManager.onChange(changes);
    expect(claimSourceBinding('mine', named('Wardfall'))).toBe('existing');
    expect(changes).not.toHaveBeenCalled();
  });

  it('a pruning source relabels on rebuild and keeps ownership', async () => {
    const mine = listSource('mine');
    mine.push(named('Wardfall'));
    await rebuildPersistedBindings();
    const binding = live();

    mine[0] = named('Wardfall Two');
    expect((await rebuildPersistedBindings()).sources[0]).toMatchObject({ created: 0, existing: 1, pruned: 0 });
    expect(live()).toBe(binding);
    expect(live().projectName).toBe('Wardfall Two');

    // Still the source's: it goes once the source stops listing it.
    mine.length = 0;
    await rebuildPersistedBindings();
    expect(pairs()).toEqual([]);
  });

  it('a non-pruning source does not relabel a binding on rebuild', async () => {
    const canvas = listSource('canvas', false);
    canvas.push(named('Wardfall'));
    await rebuildPersistedBindings();
    canvas[0] = named('Stale');
    await rebuildPersistedBindings();
    expect(live().projectName).toBe('Wardfall');
  });
});

describe('persisted plugin bindings (#2082)', () => {
  it('skips a persisted plugin binding and still restores the rest', async () => {
    const listed = listSource('canvas', false);
    listed.push({ ...wire('a', 'p'), targetKind: 'plugin' }, wire('a', 'b'));
    expect((await rebuildPersistedBindings()).sources[0]).toMatchObject({ collected: 2, created: 1, invalid: 1 });
    expect(pairs()).toEqual(['a->b']);
  });
});

describe('releaseSourceBinding', () => {
  it('unbinds a binding the source owns', () => {
    listSource('mine');
    claimSourceBinding('mine', wire('a', 'b'));
    expect(releaseSourceBinding('mine', 'a', 'b')).toBe('unbound');
    expect(pairs()).toEqual([]);
    expect(releaseSourceBinding('mine', 'a', 'b')).toBe('absent');
  });

  it('keeps a binding it does not own', () => {
    listSource('mine');
    bindingManager.bind('a', { targetId: 'b', targetKind: 'agent', label: 'b' });
    expect(releaseSourceBinding('mine', 'a', 'b')).toBe('kept');
    expect(pairs()).toEqual(['a->b']);
  });

  it('hands a binding another pruning source lists to that source', async () => {
    const mine = listSource('mine');
    const other = listSource('other');
    mine.push(wire('a', 'b'));
    other.push(wire('a', 'b'));
    await rebuildPersistedBindings(); // 'mine' creates it; 'other' finds it existing

    mine.length = 0;
    expect(releaseSourceBinding('mine', 'a', 'b')).toBe('kept');
    expect(pairs()).toEqual(['a->b']);

    // 'other' owns it now, so it goes when 'other' stops listing it.
    other.length = 0;
    await rebuildPersistedBindings();
    expect(pairs()).toEqual([]);
  });
});

describe('pruning handoff (#2246)', () => {
  it('hands ownership to a pruning source that still lists the pair', async () => {
    const first = listSource('first');
    const second = listSource('second');
    first.push(wire('a', 'b'));
    second.push(wire('a', 'b'));
    await rebuildPersistedBindings(); // 'first' creates and owns it

    first.length = 0;
    const kept = await rebuildPersistedBindings();
    expect(kept.sources.map((s) => s.pruned)).toEqual([0, 0]);
    expect(pairs()).toEqual(['a->b']);

    second.length = 0;
    const gone = await rebuildPersistedBindings();
    expect(gone.sources[1]).toMatchObject({ id: 'second', pruned: 1 });
    expect(pairs()).toEqual([]);
  });

  it('hands nothing to a non-pruning source: its wire keeps the binding for good', async () => {
    const mine = listSource('mine');
    const canvas = listSource('canvas', false);
    mine.push(wire('a', 'b'));
    canvas.push(wire('a', 'b'));
    await rebuildPersistedBindings();

    mine.length = 0;
    await rebuildPersistedBindings();
    canvas.length = 0;
    await rebuildPersistedBindings();
    expect(pairs()).toEqual(['a->b']);
  });
});

describe('pruning handoff to a claim made during the run (#2230)', () => {
  it('hands the pair to a pruning source that claimed it after its collect', async () => {
    const first = listSource('first');
    const second = listSource('second');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let slow = false;
    registerPersistedBindingSource({ id: 'slow', collect: async () => { if (slow) await gate; return []; } });
    first.push(wire('a', 'b'));
    await rebuildPersistedBindings(); // 'first' creates and owns it

    first.length = 0;
    slow = true;
    const running = rebuildPersistedBindings(); // 'second' collects nothing, then 'slow' waits
    await new Promise((r) => setImmediate(r));
    // 'second' saves the pair to its store and claims it while the run is still going.
    second.push(wire('a', 'b'));
    expect(claimSourceBinding('second', wire('a', 'b'))).toBe('existing');
    release();
    const result = await running;
    expect(result.sources[0]).toMatchObject({ id: 'first', pruned: 0 });
    expect(pairs()).toEqual(['a->b']);

    // 'second' owns it now: it goes once 'second' stops listing it.
    slow = false;
    second.length = 0;
    await rebuildPersistedBindings();
    expect(pairs()).toEqual([]);
  });
});

describe('listSoleOwnedPairs (#2232)', () => {
  it('lists only pairs the source created and no other source lists', async () => {
    const mine = listSource('mine');
    const helpers = listSource('helpers');
    const canvas = listSource('canvas', false);
    canvas.push(wire('c', 'd'));
    await rebuildPersistedBindings();

    mine.push(wire('a', 'b'), wire('c', 'd'), wire('e', 'f'));
    expect(claimSourceBinding('mine', wire('a', 'b'))).toBe('created');
    // Made by the canvas first: never the tool's alone.
    expect(claimSourceBinding('mine', wire('c', 'd'))).toBe('existing');
    expect(claimSourceBinding('mine', wire('e', 'f'))).toBe('created');
    // Another pruning source (helper wires) lists e->f too.
    helpers.push(wire('e', 'f'));
    await rebuildPersistedBindings();

    expect(listSoleOwnedPairs('mine')).toEqual([{ agentId: 'a', targetId: 'b' }]);
    expect(listSoleOwnedPairs('nobody')).toEqual([]);
  });

  it('drops a pair once the user removes it', () => {
    listSource('mine');
    claimSourceBinding('mine', wire('a', 'b'));
    markBindingRemovedByUser('a', 'b');
    expect(listSoleOwnedPairs('mine')).toEqual([]);
  });
});

describe('a gated pruning source (#2537)', () => {
  /** Lists its wires only while open, like the Dispatcher wires while the Dispatcher is on. */
  function gatedSource(id: string) {
    const state = { open: true, listed: [] as PersistedBinding[], unverified: [] as Array<{ agentId: string; targetId: string }> };
    registerPersistedBindingSource({
      id,
      prune: true,
      collect: async () => (state.open ? { bindings: [...state.listed], unverified: [...state.unverified] } : { bindings: [], unverified: [] }),
    });
    return state;
  }

  it('removes every wire it created when the gate closes, and none another pruning source lists', async () => {
    const gated = gatedSource('gated');
    const helpers = listSource('helpers');
    gated.listed.push(wire('d', 'o1'), wire('o1', 'd'), wire('d', 'o2'));
    helpers.push(wire('d', 'o2'));
    await rebuildPersistedBindings();
    expect(pairs()).toEqual(['d->o1', 'd->o2', 'o1->d']);

    gated.open = false;
    const result = await rebuildPersistedBindings();
    expect(result.sources[0]).toMatchObject({ id: 'gated', pruned: 2 });
    expect(pairs()).toEqual(['d->o2']);
  });

  it('keeps the wires it could not check, then prunes them once it can', async () => {
    const gated = gatedSource('gated');
    gated.listed.push(wire('d', 'o1'), wire('o1', 'd'));
    await rebuildPersistedBindings();

    gated.listed.length = 0;
    gated.unverified.push({ agentId: 'd', targetId: 'o1' }, { agentId: 'o1', targetId: 'd' });
    await rebuildPersistedBindings();
    expect(pairs()).toEqual(['d->o1', 'o1->d']);

    gated.unverified.length = 0;
    await rebuildPersistedBindings();
    expect(pairs()).toEqual([]);
  });
});

describe('onBindingDrawnByUser (#2661)', () => {
  it('tells a listener when the user draws a pair, and stops after unsubscribing', () => {
    const listener = vi.fn();
    const off = onBindingDrawnByUser(listener);
    clearBindingRemovedByUser('a', 'b');
    expect(listener).toHaveBeenCalledWith('a', 'b');
    off();
    clearBindingRemovedByUser('a', 'c');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives a listener that throws', () => {
    const off = onBindingDrawnByUser(() => { throw new Error('boom'); });
    expect(() => clearBindingRemovedByUser('a', 'b')).not.toThrow();
    off();
  });
});
