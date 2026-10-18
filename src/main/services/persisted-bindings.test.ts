/**
 * Ownership rules for pruning sources (#2246) and explicit claims and
 * releases made on a source's behalf (#2230).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  claimSourceBinding,
  clearBindingRemovedByUser,
  consumeRestoredBinding,
  markBindingRemovedByUser,
  rebuildPersistedBindings,
  registerPersistedBindingSource,
  releaseSourceBinding,
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
