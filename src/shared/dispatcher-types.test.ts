import { describe, expect, it } from 'vitest';
import { resolveDispatcherEnablement, type DispatcherOffReason } from './dispatcher-types';
import { isGraduatedFlagOn } from './graduated-flags';

type Row = [saved: boolean | undefined, experimental: boolean | undefined, newLayout: boolean, savedOn: boolean, enabled: boolean, reason: DispatcherOffReason | null];

/** Every combination. Clubhouse MCP is never an input: it always runs. */
const TABLE: Row[] = [
  // Nothing saved: on by default in the new layout, off on the classic.
  [undefined, undefined, true, true, true, null],
  [undefined, undefined, false, false, false, 'classic_layout'],
  // A saved experimental true is no different from nothing saved.
  [undefined, true, true, true, true, null],
  [undefined, true, false, false, false, 'classic_layout'],
  // A saved experimental false with no explicit true means off.
  [undefined, false, true, false, false, 'experimental_off'],
  [undefined, false, false, false, false, 'experimental_off'],
  // An explicit true wins over the experimental flag and the layout.
  [true, undefined, true, true, true, null],
  [true, undefined, false, true, true, null],
  [true, true, true, true, true, null],
  [true, true, false, true, true, null],
  [true, false, true, true, true, null],
  [true, false, false, true, true, null],
  // An explicit false wins over everything.
  [false, undefined, true, false, false, 'switch_off'],
  [false, undefined, false, false, false, 'switch_off'],
  [false, true, true, false, false, 'switch_off'],
  [false, true, false, false, false, 'switch_off'],
  [false, false, true, false, false, 'switch_off'],
  [false, false, false, false, false, 'switch_off'],
];

describe('resolveDispatcherEnablement', () => {
  it('covers every combination', () => {
    expect(new Set(TABLE.map((r) => r.slice(0, 3).join())).size).toBe(3 * 3 * 2);
  });

  it.each(TABLE)('saved %s, experimental %s, new layout %s', (saved, experimental, newLayout, savedOn, enabled, reason) => {
    const graduatedFlagOn = isGraduatedFlagOn(experimental === undefined ? {} : { dispatcher: experimental }, 'dispatcher');
    expect(resolveDispatcherEnablement({ saved, graduatedFlagOn, newLayout })).toEqual({ savedOn, enabled, reason });
  });
});
