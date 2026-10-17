import { describe, it, expect } from 'vitest';
import { computeOverflow, touchMru } from './overflow';

const tabs = ['agents', 'files', 'git', 'terminal', 'canvas'];
const w80 = Object.fromEntries(tabs.map((t) => [t, 80]));

describe('computeOverflow', () => {
  it('shows everything that fits', () => {
    expect(computeOverflow(tabs, w80, 400, 'agents', [], 60)).toEqual({ shown: tabs, overflow: [] });
  });

  it('shows everything before the row is measured', () => {
    expect(computeOverflow(tabs, w80, 0, 'agents', [], 60).overflow).toEqual([]);
  });

  it('fills from the left and leaves room for More', () => {
    // 300 - 60 = 240: three 80px tabs.
    expect(computeOverflow(tabs, w80, 300, 'agents', [], 60)).toEqual({ shown: ['agents', 'files', 'git'], overflow: ['terminal', 'canvas'] });
  });

  it('always shows the active tab, in saved order, in place of the last that fit', () => {
    expect(computeOverflow(tabs, w80, 300, 'canvas', [], 60)).toEqual({ shown: ['agents', 'files', 'canvas'], overflow: ['git', 'terminal'] });
  });

  it('orders the overflow by recent use, then saved order', () => {
    const { overflow } = computeOverflow(tabs, w80, 220, 'agents', ['canvas', 'agents', 'git'], 60);
    expect(overflow).toEqual(['canvas', 'git', 'terminal']);
  });

  it('counts the gap between tabs', () => {
    // Three 80px tabs need 244 with 2px gaps; the room is 240 - 2.
    expect(computeOverflow(tabs, w80, 300, 'agents', [], 60, 2).shown).toEqual(['agents', 'files']);
  });
});

describe('touchMru', () => {
  it('moves a tab to the front and caps the list', () => {
    expect(touchMru(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(touchMru(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });
});
