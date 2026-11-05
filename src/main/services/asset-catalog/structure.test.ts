import { describe, expect, it } from 'vitest';
import {
  applyCleanUpdate,
  applyStructureChoice,
  checkStructure,
  checkSubagentSet,
  firstBundleAbove,
  hasMovedEntries,
  instanceFromTemplate,
  mergeOrder,
  switchTemplate,
  takeableRevision,
} from './structure';
import type {
  CompositionInput,
  StructureInput,
  StructureInstanceEntry,
  SubagentSetInput,
} from '../../../shared/asset-catalog-types';

const base = (...ids: string[]) => ids.map((id) => ({ entryId: id, blockId: `block-${id}`, name: id }));

/** `Name` follows the base, `*Name` is a fork of its base entry, `+Name` is local. */
function instance(...spec: string[]): StructureInstanceEntry[] {
  return spec.map((item): StructureInstanceEntry => {
    if (item.startsWith('+')) {
      const name = item.slice(1);
      return { key: `local:${name}`, baseEntryId: null, sources: [`block-local-${name}`], name, forked: false };
    }
    if (item.startsWith('*')) {
      const name = item.slice(1);
      return { key: `base:${name}`, baseEntryId: name, sources: [`fork-of-${name}`, `block-${name}`], name, forked: true };
    }
    return { key: `base:${item}`, baseEntryId: item, sources: [`block-${item}`], name: item, forked: false };
  });
}

function input(accepted: string[], target: string[], spec: string[], excluded: string[] = []): StructureInput {
  return { accepted: base(...accepted), target: base(...target), instance: instance(...spec), excluded };
}

const keys = (...spec: string[]) => spec.map((item) => (item.startsWith('+') ? `local:${item.slice(1)}` : `base:${item}`));
const codes = (check: ReturnType<typeof checkStructure>) => check.reasons.map((reason) => reason.code);

const A = ['Identity', 'Job', 'Handoff'];
const SIMPLE = ['Identity', 'Job', 'Handoff', '+Rules'];
const DRAGGED = ['Identity', 'Handoff', 'Job', '+Rules'];

describe('takeableRevision', () => {
  const independent = (revision: number) => ({ revision });
  const bundled = (revision: number, templateRevision: number, templateId = 'T') => ({ revision, bundledBy: { templateId, templateRevision } });

  it('takes independent revisions up to the head', () => {
    expect(takeableRevision([independent(1), independent(2), independent(3)], 1)).toBe(3);
  });

  it('stops before a bundled revision', () => {
    expect(takeableRevision([independent(5), bundled(6, 2)], 5)).toBe(5);
  });

  it('a later independent edit waits with the bundle under it', () => {
    expect(takeableRevision([independent(5), bundled(6, 2), independent(7)], 5)).toBe(5);
  });

  it('takes what comes before the bundle', () => {
    expect(takeableRevision([independent(5), independent(6), bundled(7, 2), independent(8)], 5)).toBe(6);
  });

  it('a floor at or past the bundle is past it: accepting T2 sets the floor to r6', () => {
    const history = [independent(5), bundled(6, 2), independent(7)];
    expect(takeableRevision(history, 6)).toBe(7);
    expect(takeableRevision(history, 7)).toBe(7);
  });

  it('accepting T3 absorbs a skipped T2: only the floor counts', () => {
    const history = [independent(5), bundled(6, 2), independent(7), bundled(8, 3), independent(9)];
    expect(takeableRevision(history, 5)).toBe(5);
    expect(takeableRevision(history, 8)).toBe(9);
  });

  it('a later ref to a bundled revision reaches past it with no new tag involved', () => {
    const history = [independent(1), bundled(2, 2), independent(3)];
    expect(takeableRevision(history, 3)).toBe(3);
  });

  it('never goes below the floor, whatever the history holds', () => {
    expect(takeableRevision([], 4)).toBe(4);
    expect(takeableRevision([independent(1)], 4)).toBe(4);
    expect(takeableRevision([bundled(5, 1)], 4)).toBe(4);
  });

  it('reads history in revision order whatever order it arrives in', () => {
    expect(takeableRevision([independent(3), bundled(4, 2), independent(2)], 1)).toBe(3);
  });

  it('names the first bundle above a floor', () => {
    const history = [independent(5), bundled(6, 2, 'T'), bundled(7, 1, 'U')];
    expect(firstBundleAbove(history, 5)).toEqual({ templateId: 'T', templateRevision: 2 });
    expect(firstBundleAbove(history, 6)).toEqual({ templateId: 'U', templateRevision: 1 });
    expect(firstBundleAbove(history, 7)).toBeNull();
  });
});

describe('structure, with a dragged instance: [Identity, Handoff, Job, Rules]', () => {
  it.each([
    ['adds Safety between Identity and Job', ['Identity', 'Safety', 'Job', 'Handoff'], 'add_position'],
    ['adds Safety after Handoff in the base', ['Identity', 'Job', 'Handoff', 'Safety'], 'add_position'],
    ['removes Handoff', ['Identity', 'Job'], 'removed_moved'],
    ['reorders Identity and Job', ['Job', 'Identity', 'Handoff'], 'reorder_conflict'],
    ['splits Job into two', ['Identity', 'JobA', 'JobB', 'Handoff'], 'removed_moved'],
  ])('%s: needs a choice', (_label, target, code) => {
    const check = checkStructure(input(A, target, DRAGGED));
    expect(check.clean).toBe(false);
    expect(codes(check)).toContain(code);
  });

  it('a split shows as one removal and one run', () => {
    const check = checkStructure(input(A, ['Identity', 'JobA', 'JobB', 'Handoff'], DRAGGED));
    expect(check.reasons).toContainEqual({ code: 'removed_moved', entries: ['base:Job'] });
    expect(check.order).toEqual(keys('Identity', 'JobA', 'JobB', 'Handoff', '+Rules'));
  });

  it('suggests a position after its base neighbor, without applying it', () => {
    const check = checkStructure(input(A, ['Identity', 'Job', 'Handoff', 'Safety'], DRAGGED));
    expect(check.order).toEqual(keys('Identity', 'Handoff', 'Safety', 'Job', '+Rules'));
  });

  it('a base change that keeps the drag and its neighbors stays clean: adding at the very start', () => {
    const check = checkStructure(input(A, ['Safety', 'Identity', 'Job', 'Handoff'], DRAGGED));
    expect(check.clean).toBe(true);
    expect(check.order).toEqual(keys('Safety', 'Identity', 'Handoff', 'Job', '+Rules'));
  });

  it('Correction 1: removing a neighbor of a moved entry needs a choice', () => {
    const check = checkStructure(input(A, ['Job', 'Handoff'], DRAGGED));
    expect(check.clean).toBe(false);
    expect(check.reasons).toContainEqual({ code: 'neighbors_changed', entries: ['base:Handoff'] });
  });
});

describe('structure, with only a local block: [Identity, Job, Handoff, Rules]', () => {
  it('adding Safety between Identity and Job is clean, at that position', () => {
    const check = checkStructure(input(A, ['Identity', 'Safety', 'Job', 'Handoff'], SIMPLE));
    expect(check).toMatchObject({ clean: true, reasons: [] });
    expect(check.order).toEqual(keys('Identity', 'Safety', 'Job', 'Handoff', '+Rules'));
  });

  it('adding Safety after Handoff needs a choice: before or after Rules', () => {
    const check = checkStructure(input(A, ['Identity', 'Job', 'Handoff', 'Safety'], SIMPLE));
    expect(check.clean).toBe(false);
    expect(codes(check)).toContain('add_position');
  });

  it('removing Job is clean: Rules stays after Handoff', () => {
    const check = checkStructure(input(A, ['Identity', 'Handoff'], SIMPLE));
    expect(check.clean).toBe(true);
    expect(check.order).toEqual(keys('Identity', 'Handoff', '+Rules'));
  });

  it('reordering Identity and Job is clean: Rules still follows Handoff', () => {
    const check = checkStructure(input(A, ['Job', 'Identity', 'Handoff'], SIMPLE));
    expect(check.clean).toBe(true);
    expect(check.order).toEqual(keys('Job', 'Identity', 'Handoff', '+Rules'));
  });

  it('removing Handoff needs a choice: Rules followed it', () => {
    const check = checkStructure(input(A, ['Identity', 'Job'], SIMPLE));
    expect(check.clean).toBe(false);
    expect(codes(check)).toEqual(expect.arrayContaining(['removed_beside_local', 'neighbors_changed']));
  });

  it('Correction 1: swapping Job and Handoff needs a choice, since Rules would follow Job', () => {
    const check = checkStructure(input(A, ['Identity', 'Handoff', 'Job'], SIMPLE));
    expect(check.clean).toBe(false);
    expect(check.reasons).toContainEqual({ code: 'neighbors_changed', entries: ['local:Rules'] });
  });

  it('reading decision: a split here needs a choice, since Job sits between the new run\'s neighbors', () => {
    const check = checkStructure(input(A, ['Identity', 'JobA', 'JobB', 'Handoff'], SIMPLE));
    expect(check.clean).toBe(false);
    expect(check.reasons).toContainEqual({ code: 'add_position', entries: ['base:JobA', 'base:JobB'] });
  });

  it('adding at the start needs a choice when a local block leads', () => {
    expect(checkStructure(input(A, ['Safety', 'Identity', 'Job', 'Handoff'], ['+Rules', 'Identity', 'Job', 'Handoff'])).clean).toBe(false);
    expect(checkStructure(input(A, ['Safety', 'Identity', 'Job', 'Handoff'], ['Identity', 'Job', 'Handoff', '+Rules'])).clean).toBe(true);
  });

  it('a change away from a local block in the middle is clean', () => {
    const check = checkStructure(input(A, ['Identity', 'Job', 'Safety', 'Handoff'], ['Identity', '+Rules', 'Job', 'Handoff']));
    expect(check.clean).toBe(true);
    expect(check.order).toEqual(keys('Identity', '+Rules', 'Job', 'Safety', 'Handoff'));
  });

  it('a swap with a local block between the pair needs a choice', () => {
    const check = checkStructure(input(['a', 'b'], ['b', 'a'], ['a', '+L', 'b']));
    expect(check.clean).toBe(false);
    expect(codes(check)).toContain('reorder_conflict');
  });
});

describe('excluded entries are ignored throughout', () => {
  it('Handoff excluded, Rules local after it, base removes Handoff: clean', () => {
    const check = checkStructure(input(A, ['Identity', 'Job'], ['Identity', 'Job', '+Rules'], ['Handoff']));
    expect(check.clean).toBe(true);
    expect(check.order).toEqual(keys('Identity', 'Job', '+Rules'));
  });

  it('an exclusion between two entries does not break their adjacency', () => {
    const check = checkStructure(input(['a', 'x', 'b'], ['a', 'new', 'x', 'b'], ['a', 'b', '+L'], ['x']));
    expect(check.clean).toBe(true);
    expect(check.order).toEqual(keys('a', 'new', 'b', '+L'));
  });

  it('a removal stays when the base re-adds that id, with a notice', () => {
    const check = checkStructure(input(['Identity', 'Job'], ['Identity', 'Job', 'Handoff'], ['Identity', 'Job'], ['Handoff']));
    expect(check.clean).toBe(true);
    expect(check.order).toEqual(keys('Identity', 'Job'));
    expect(check.reAddedExcluded).toEqual(['Handoff']);
  });

  it('nothing is re-added while the base has kept the id all along', () => {
    expect(checkStructure(input(A, A, ['Identity', 'Job'], ['Handoff'])).reAddedExcluded).toEqual([]);
  });

  it('does not count as moved', () => {
    expect(hasMovedEntries(A, ['Identity', 'Handoff'], ['Job'])).toBe(false);
    expect(hasMovedEntries(A, ['Handoff', 'Identity'], ['Job'])).toBe(true);
  });
});

describe('forks are not moves', () => {
  it('fork Job only, base adds Safety before Job: clean, and the fork keeps its slot', () => {
    const check = checkStructure(input(A, ['Identity', 'Safety', 'Job', 'Handoff'], ['Identity', '*Job', 'Handoff']));
    expect(check.clean).toBe(true);
    expect(check.order).toEqual(keys('Identity', 'Safety', 'Job', 'Handoff'));
  });

  it('an instance with only forks passes the order rules, as a follower does', () => {
    const check = checkStructure(input(['a', 'b', 'c'], ['a', 'c', 'new', 'b'], ['a', '*b', 'c']));
    expect(check).toMatchObject({ clean: true, reasons: [] });
    expect(check.order).toEqual(keys('a', 'c', 'new', 'b'));
  });

  it('base removes a forked entry: needs a choice, and the suggestion keeps the fork in place', () => {
    const check = checkStructure(input(A, ['Identity', 'Handoff'], ['Identity', '*Job', 'Handoff']));
    expect(check.clean).toBe(false);
    expect(check.reasons).toEqual([{ code: 'removed_forked', entries: ['base:Job'] }]);
    expect(check.order).toEqual(keys('Identity', 'Job', 'Handoff'));
  });

  it('a fork beside a local block is still protected by the order rules', () => {
    const check = checkStructure(input(A, ['Identity', 'Job'], ['Identity', 'Job', '*Handoff', '+Rules']));
    expect(check.clean).toBe(false);
    expect(codes(check)).toContain('removed_forked');
  });
});

describe('followers take everything', () => {
  it('reading decision: an instance with nothing placed passes the order rules whatever the base does', () => {
    const check = checkStructure(input(['a', 'b', 'c'], ['a', 'c', 'new', 'b'], ['a', 'b', 'c']));
    expect(check).toMatchObject({ clean: true, order: keys('a', 'c', 'new', 'b') });
  });

  it('takes additions at the end, removals, reorders and splits', () => {
    expect(checkStructure(input(A, ['Identity', 'Job', 'Handoff', 'Safety'], A)).clean).toBe(true);
    expect(checkStructure(input(A, ['Handoff'], A)).clean).toBe(true);
    expect(checkStructure(input(A, ['Handoff', 'Job', 'Identity'], A)).clean).toBe(true);
    expect(checkStructure(input(A, ['Identity', 'JobA', 'JobB', 'Handoff'], A)).clean).toBe(true);
  });

  it('identity is still checked', () => {
    const accepted = base('a', 'b');
    const target = [...base('a', 'b'), { entryId: 'c', blockId: 'block-c', name: 'A' }];
    const check = checkStructure({ accepted, target, instance: instance('a', 'b'), excluded: [] });
    expect(check.clean).toBe(false);
    expect(check.reasons).toEqual([{ code: 'identity_conflict', entries: ['base:c'] }]);
  });
});

describe('identity', () => {
  it('a local block named like a new entry needs a choice', () => {
    const check = checkStructure(input(A, ['Identity', 'Safety', 'Job', 'Handoff'], ['Identity', 'Job', 'Handoff', '+safety']));
    expect(check.clean).toBe(false);
    expect(check.reasons).toContainEqual({ code: 'identity_conflict', entries: ['base:Safety'] });
  });

  it('a duplicate source needs a choice, even under another name', () => {
    const entries: StructureInstanceEntry[] = [...instance('Identity', 'Job', 'Handoff'), {
      key: 'local:mine', baseEntryId: null, sources: ['block-shared'], name: 'Something else', forked: false,
    }];
    const target = [...base('Identity'), { entryId: 'New', blockId: 'block-shared', name: 'New' }, ...base('Job', 'Handoff')];
    const check = checkStructure({ accepted: base(...A), target, instance: entries, excluded: [] });
    expect(check.reasons).toContainEqual({ code: 'identity_conflict', entries: ['base:New'] });
  });

  it('a new entry from the block a fork came from needs a choice', () => {
    const entries = instance('Identity', '*Job', 'Handoff');
    entries[1].sources = ['my-fork', 'block-origin'];
    const target = [...base(...A), { entryId: 'Again', blockId: 'block-origin', name: 'Again' }];
    expect(checkStructure({ accepted: base(...A), target, instance: entries, excluded: [] }).reasons).toContainEqual({ code: 'identity_conflict', entries: ['base:Again'] });
  });

  it('an entry this revision removes no longer counts as existing', () => {
    const accepted = base('Identity', 'Job');
    const target = [...base('Identity'), { entryId: 'Job2', blockId: 'block-Job2', name: 'Job' }];
    expect(checkStructure({ accepted, target, instance: instance('Identity', 'Job'), excluded: [] }).clean).toBe(true);
  });
});

describe('runs and whole revisions', () => {
  it('two new blocks in a row are one run, so one position', () => {
    const check = checkStructure(input(A, ['Identity', 'Job', 'Handoff', 'One', 'Two'], SIMPLE));
    expect(check.reasons.filter((reason) => reason.code === 'add_position')).toEqual([{ code: 'add_position', entries: ['base:One', 'base:Two'] }]);
    const clean = checkStructure(input(A, ['Identity', 'One', 'Two', 'Job', 'Handoff'], SIMPLE));
    expect(clean.order).toEqual(keys('Identity', 'One', 'Two', 'Job', 'Handoff', '+Rules'));
  });

  it('one clean add and one conflict: all of it waits', () => {
    const check = checkStructure(input(A, ['Identity', 'Safety', 'Job', 'Handoff', 'Late'], SIMPLE));
    expect(check.clean).toBe(false);
    expect(check.reasons.map((reason) => reason.entries)).toContainEqual(['base:Late']);
    expect(check.reasons.map((reason) => reason.entries)).not.toContainEqual(['base:Safety']);
  });

  it('is deterministic, and reasons come out in one order', () => {
    const request = input(A, ['Job', 'Safety', 'Identity'], DRAGGED);
    expect(checkStructure(request)).toEqual(checkStructure(request));
    expect(mergeOrder(request)).toEqual(mergeOrder(request));
    expect(JSON.stringify(checkStructure(request))).toBe(JSON.stringify(checkStructure(input(A, ['Job', 'Safety', 'Identity'], DRAGGED))));
  });

  it('an unchanged base is clean and changes nothing', () => {
    for (const spec of [A, SIMPLE, DRAGGED]) {
      const check = checkStructure(input(A, A, spec));
      expect(check.clean).toBe(true);
      expect(check.order).toEqual(keys(...spec));
    }
  });

  it('a base with everything replaced, on a follower', () => {
    expect(checkStructure(input(['a'], ['z'], ['a']))).toMatchObject({ clean: true, order: keys('z') });
  });
});

describe('native subagent set', () => {
  const set = (entries: Array<[string, string]>) => entries.map(([entryId, name]) => ({ entryId, name }));
  const follow = (entryId: string, name: string) => ({ key: `base:${entryId}`, baseEntryId: entryId, name, forked: false });
  const check = (over: Partial<SubagentSetInput>) => checkSubagentSet({ accepted: [], target: [], instance: [], excluded: [], ...over });

  it('adding with a unique name is clean', () => {
    const result = check({ target: set([['a', 'tester']]) });
    expect(result).toMatchObject({ clean: true, added: ['base:a'], removed: [] });
  });

  it('removing a followed definition is clean, and shown', () => {
    const result = check({ accepted: set([['a', 'tester']]), instance: [follow('a', 'tester')] });
    expect(result).toMatchObject({ clean: true, removed: ['base:a'] });
  });

  it('has no order: an arrangement changes nothing', () => {
    const accepted = set([['a', 'one'], ['b', 'two']]);
    const target = set([['b', 'two'], ['a', 'one']]);
    expect(check({ accepted, target, instance: [follow('b', 'two'), follow('a', 'one')] }).clean).toBe(true);
  });

  it('the same name as a local definition needs a choice', () => {
    const result = check({ target: set([['a', 'tester']]), instance: [{ key: 'local:x', baseEntryId: null, name: 'Tester', forked: false }] });
    expect(result.reasons).toEqual([{ code: 'name_collision', entries: ['base:a'] }]);
  });

  it('the same name as a foreign definition needs a choice', () => {
    expect(check({ target: set([['a', 'tester']]), foreignNames: ['TESTER'] }).reasons).toEqual([{ code: 'foreign_name_collision', entries: ['base:a'] }]);
  });

  it('upstream removing a fork needs a choice', () => {
    const result = check({ accepted: set([['a', 'one']]), instance: [{ key: 'base:a', baseEntryId: 'a', name: 'one', forked: true }] });
    expect(result.reasons).toEqual([{ code: 'removed_forked', entries: ['base:a'] }]);
  });

  it('upstream renaming onto an existing name needs a choice', () => {
    const result = check({
      accepted: set([['a', 'one'], ['b', 'two']]),
      target: set([['a', 'two'], ['b', 'two-old']]),
      instance: [follow('a', 'one'), { key: 'local:x', baseEntryId: null, name: 'two', forked: false }, follow('b', 'two')],
    });
    expect(result.reasons).toContainEqual({ code: 'renamed_onto_existing', entries: ['base:a'] });
  });

  it('a rename to a free name is clean', () => {
    expect(check({ accepted: set([['a', 'one']]), target: set([['a', 'new-name']]), instance: [follow('a', 'one')] }).clean).toBe(true);
  });

  it('an excluded definition stays out when re-added, with a notice', () => {
    const result = check({ target: set([['a', 'one']]), excluded: ['a'] });
    expect(result).toMatchObject({ clean: true, added: [], reAddedExcluded: ['a'] });
  });

  it('anything raising authority needs a person', () => {
    const result = check({ target: set([['a', 'one']]), authorityEntries: ['a'] });
    expect(result.reasons).toEqual([{ code: 'authority_fields', entries: ['base:a'] }]);
  });
});

describe('applying', () => {
  const target = { templateId: 'T', revision: 2, entryIds: ['Identity', 'Safety', 'Job', 'Handoff'], subagentIds: ['sub-new'] };
  const context = {
    acceptedBlocks: {
      Identity: { assetId: 'block-Identity', revision: 1 },
      Job: { assetId: 'block-Job', revision: 5 },
      Handoff: { assetId: 'block-Handoff', revision: 1 },
    },
    acceptedSubagents: { 'sub-old': { assetId: 'subagent-old', revision: 3 } },
  };
  const instanceOf = (over: Partial<CompositionInput> = {}): CompositionInput => ({
    ...instanceFromTemplate({ templateId: 'T', revision: 1, entryIds: ['Identity', 'Job', 'Handoff'], subagentIds: [] }),
    ...over,
  });
  const rules = { localId: 'Rules', source: { kind: 'local' as const, blockId: 'block-rules' } };

  it('a new instance follows everything, with no floors of its own', () => {
    expect(instanceFromTemplate(target)).toEqual({
      template: { templateId: 'T', acceptedRevision: 2 },
      entries: target.entryIds.map((baseEntryId) => ({ baseEntryId, source: { kind: 'follow' } })),
      excludedEntryIds: [],
      subagents: [{ baseEntryId: 'sub-new', source: { kind: 'follow' } }],
      excludedSubagentEntryIds: [],
      additions: [],
      removals: [],
      floors: {},
      keepMarkers: {},
      authorityApprovals: {},
    });
  });

  it('a clean update takes the merged order and keeps forks and locals as they were', () => {
    const fork = { baseEntryId: 'Job', source: { kind: 'fork' as const, blockId: 'my-job', forkedFrom: { assetId: 'block-Job', revision: 5 } } };
    const current = instanceOf({ entries: [{ baseEntryId: 'Identity', source: { kind: 'follow' } }, fork, { baseEntryId: 'Handoff', source: { kind: 'follow' } }, rules] });
    const result = applyCleanUpdate(current, target, ['base:Identity', 'base:Safety', 'base:Job', 'base:Handoff', 'local:Rules']);
    expect(result.template).toEqual({ templateId: 'T', acceptedRevision: 2 });
    expect(result.entries).toEqual([
      { baseEntryId: 'Identity', source: { kind: 'follow' } },
      { baseEntryId: 'Safety', source: { kind: 'follow' } },
      fork,
      { baseEntryId: 'Handoff', source: { kind: 'follow' } },
      rules,
    ]);
    expect(result.subagents).toEqual([{ baseEntryId: 'sub-new', source: { kind: 'follow' } }]);
  });

  describe('a choice', () => {
    const current = () => instanceOf({ entries: [...instanceOf().entries, rules] });
    const order = ['base:Identity', 'base:Safety', 'base:Job', 'base:Handoff', 'local:Rules'];

    it('takes a position the person picked', () => {
      const result = applyStructureChoice(current(), target, { order: ['base:Identity', 'base:Job', 'base:Safety', 'base:Handoff', 'local:Rules'] }, context);
      expect(result.ok === true && result.composition.entries.map((entry) => entry.baseEntryId ?? entry.localId)).toEqual(['Identity', 'Job', 'Safety', 'Handoff', 'Rules']);
      expect(result.ok === true && result.composition.template?.acceptedRevision).toBe(2);
    });

    it('is whole or refused: a new entry left out', () => {
      const result = applyStructureChoice(current(), target, { order: order.filter((key) => key !== 'base:Safety') }, context);
      expect(result).toMatchObject({ ok: false, issues: [{ code: 'invalid_choice', path: 'entry:base:Safety' }] });
    });

    it('is whole or refused: a local entry neither kept nor dropped', () => {
      expect(applyStructureChoice(current(), target, { order: order.filter((key) => key !== 'local:Rules') }, context).ok).toBe(false);
      const dropped = applyStructureChoice(current(), target, { order: order.filter((key) => key !== 'local:Rules'), dropLocal: ['local:Rules'] }, context);
      expect(dropped.ok === true && dropped.composition.entries.some((entry) => entry.localId)).toBe(false);
    });

    it('refuses an entry it has never heard of, and a repeat', () => {
      expect(applyStructureChoice(current(), target, { order: [...order, 'base:Nope'] }, context).ok).toBe(false);
      expect(applyStructureChoice(current(), target, { order: [...order, 'base:Job'] }, context).ok).toBe(false);
    });

    it('excluding a new entry is a real exclusion, and it stays', () => {
      const result = applyStructureChoice(current(), target, { order: order.filter((key) => key !== 'base:Safety'), excludeBaseEntries: ['base:Safety'] }, context);
      expect(result.ok === true && result.composition.excludedEntryIds).toEqual(['Safety']);
    });

    it('a removed entry kept keeps following its block directly, from the revision it had', () => {
      const removing = { templateId: 'T', revision: 2, entryIds: ['Identity', 'Job'], subagentIds: [] };
      const result = applyStructureChoice(current(), removing, { order: ['base:Identity', 'base:Job', 'base:Handoff', 'local:Rules'], keepRemoved: ['base:Handoff'] }, context);
      expect(result.ok === true && result.composition.entries[2]).toEqual({ localId: 'Handoff', source: { kind: 'follow', blockId: 'block-Handoff' } });
      expect(result.ok === true && result.composition.floors).toEqual({ 'block-Handoff': 1 });
    });

    it('a removed fork kept stays that fork, with its content', () => {
      const fork = { baseEntryId: 'Job', source: { kind: 'fork' as const, blockId: 'my-job', forkedFrom: { assetId: 'block-Job', revision: 5 } } };
      const forked = instanceOf({ entries: [{ baseEntryId: 'Identity', source: { kind: 'follow' } }, fork, { baseEntryId: 'Handoff', source: { kind: 'follow' } }] });
      const removing = { templateId: 'T', revision: 2, entryIds: ['Identity', 'Handoff'], subagentIds: [] };
      const result = applyStructureChoice(forked, removing, { order: ['base:Identity', 'base:Job', 'base:Handoff'], keepRemoved: ['base:Job'] }, context);
      expect(result.ok === true && result.composition.entries[1]).toEqual({ localId: 'Job', source: fork.source });
    });

    it('refuses to keep something the base didn\'t remove, or something local', () => {
      const removing = { templateId: 'T', revision: 2, entryIds: ['Identity', 'Job'], subagentIds: [] };
      const order2 = ['base:Identity', 'base:Job', 'local:Rules'];
      expect(applyStructureChoice(current(), removing, { order: order2, keepRemoved: ['base:Job'] }, context).ok).toBe(false);
      expect(applyStructureChoice(current(), removing, { order: order2, keepRemoved: ['local:Rules'] }, context).ok).toBe(false);
      expect(applyStructureChoice(current(), removing, { order: 'nope' as never }, context).ok).toBe(false);
    });

    it('refuses to keep an entry whose local id is taken', () => {
      const removing = { templateId: 'T', revision: 2, entryIds: ['Identity', 'Job'], subagentIds: [] };
      const taken = instanceOf({ entries: [...instanceOf().entries, { localId: 'Handoff', source: { kind: 'local', blockId: 'x' } }] });
      const result = applyStructureChoice(taken, removing, { order: ['base:Identity', 'base:Job', 'base:Handoff', 'local:Handoff'], keepRemoved: ['base:Handoff'] }, context);
      expect(result).toMatchObject({ ok: false, issues: [{ code: 'invalid_choice', path: 'keepRemoved:base:Handoff' }] });
    });

    it('a removed entry neither kept nor gone is refused', () => {
      const removing = { templateId: 'T', revision: 2, entryIds: ['Identity', 'Job'], subagentIds: [] };
      expect(applyStructureChoice(current(), removing, { order: ['base:Identity', 'base:Job', 'base:Handoff', 'local:Rules'] }, context).ok).toBe(false);
      expect(applyStructureChoice(current(), removing, { order: ['base:Identity', 'base:Job', 'local:Rules'] }, context).ok).toBe(true);
    });

    it('handles the subagent set explicitly', () => {
      const withSub = instanceOf({
        entries: current().entries,
        subagents: [{ baseEntryId: 'sub-old', source: { kind: 'follow' } }, { localId: 'mine', source: { kind: 'local', subagentId: 'my-sub' } }],
      });
      const result = applyStructureChoice(withSub, target, {
        order,
        subagents: { keepRemoved: ['base:sub-old'], excludeBaseEntries: ['base:sub-new'], dropLocal: ['local:mine'] },
      }, context);
      expect(result.ok === true && result.composition.subagents).toEqual([{ localId: 'sub-old', source: { kind: 'follow', subagentId: 'subagent-old' } }]);
      expect(result.ok === true && result.composition.excludedSubagentEntryIds).toEqual(['sub-new']);
      expect(result.ok === true && result.composition.floors['subagent-old']).toBe(3);
    });
  });

  describe('a template switch', () => {
    const fork = { baseEntryId: 'Job', source: { kind: 'fork' as const, blockId: 'my-job', forkedFrom: { assetId: 'block-Job', revision: 5 } } };
    const current = () => instanceOf({
      entries: [{ baseEntryId: 'Identity', source: { kind: 'follow' } }, fork, { baseEntryId: 'Handoff', source: { kind: 'follow' } }, rules],
      excludedEntryIds: ['Gone'],
      additions: ['skill-1', 'skill-2'],
      keepMarkers: { 'block-Job': 9 },
      authorityApprovals: { x: 1 },
    });
    const other = { templateId: 'U', revision: 4, entryIds: ['One', 'Two'], subagentIds: [] };

    it('replaces: nothing carries over unless selected', () => {
      const result = switchTemplate(current(), other, {}, context);
      expect(result).toMatchObject({ ok: true, composition: {
        template: { templateId: 'U', acceptedRevision: 4 },
        entries: [{ baseEntryId: 'One', source: { kind: 'follow' } }, { baseEntryId: 'Two', source: { kind: 'follow' } }],
        excludedEntryIds: [],
        additions: [],
        keepMarkers: {},
        authorityApprovals: {},
      } });
    });

    it('carries over what is selected, as local, after the new base', () => {
      const result = switchTemplate(current(), other, { entries: ['base:Job', 'local:Rules'], additions: ['skill-2'] }, context);
      expect(result.ok === true && result.composition.entries).toEqual([
        { baseEntryId: 'One', source: { kind: 'follow' } },
        { baseEntryId: 'Two', source: { kind: 'follow' } },
        { localId: 'Job', source: fork.source },
        rules,
      ]);
      expect(result.ok === true && result.composition.additions).toEqual(['skill-2']);
    });

    it('a followed entry carried over follows directly, from the revision it had', () => {
      const result = switchTemplate(current(), other, { entries: ['base:Handoff'] }, context);
      expect(result.ok === true && result.composition.entries[2]).toEqual({ localId: 'Handoff', source: { kind: 'follow', blockId: 'block-Handoff' } });
      expect(result.ok === true && result.composition.floors).toEqual({ 'block-Handoff': 1 });
    });

    it('refuses a selection of something not there', () => {
      expect(switchTemplate(current(), other, { entries: ['base:Nope'] }, context).ok).toBe(false);
      expect(switchTemplate(current(), other, { additions: ['skill-9'] }, context).ok).toBe(false);
    });
  });
});
