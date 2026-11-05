import { describe, expect, it } from 'vitest';
import { resolveDispatcherEnablement, type DispatcherOffReason } from './dispatcher-types';
import { isGraduatedFlagOn } from './graduated-flags';

type Row = [saved: boolean | undefined, experimental: boolean | undefined, newLayout: boolean, appMcp: boolean, savedOn: boolean, enabled: boolean, reason: DispatcherOffReason | null];

/** Every combination. Project and agent MCP overrides aren't inputs: they can't keep it on. */
const TABLE: Row[] = [
  // Nothing saved: on by default in the new layout, off on the classic.
  [undefined, undefined, true, true, true, true, null],
  [undefined, undefined, true, false, true, false, 'mcp_off'],
  [undefined, undefined, false, true, false, false, 'classic_layout'],
  [undefined, undefined, false, false, false, false, 'classic_layout'],
  // A saved experimental true is no different from nothing saved.
  [undefined, true, true, true, true, true, null],
  [undefined, true, true, false, true, false, 'mcp_off'],
  [undefined, true, false, true, false, false, 'classic_layout'],
  [undefined, true, false, false, false, false, 'classic_layout'],
  // A saved experimental false with no explicit true means off.
  [undefined, false, true, true, false, false, 'experimental_off'],
  [undefined, false, true, false, false, false, 'experimental_off'],
  [undefined, false, false, true, false, false, 'experimental_off'],
  [undefined, false, false, false, false, false, 'experimental_off'],
  // An explicit true wins over the experimental flag and the layout. Only MCP derives it off.
  [true, undefined, true, true, true, true, null],
  [true, undefined, true, false, true, false, 'mcp_off'],
  [true, undefined, false, true, true, true, null],
  [true, undefined, false, false, true, false, 'mcp_off'],
  [true, true, true, true, true, true, null],
  [true, true, true, false, true, false, 'mcp_off'],
  [true, true, false, true, true, true, null],
  [true, true, false, false, true, false, 'mcp_off'],
  [true, false, true, true, true, true, null],
  [true, false, true, false, true, false, 'mcp_off'],
  [true, false, false, true, true, true, null],
  [true, false, false, false, true, false, 'mcp_off'],
  // An explicit false wins over everything.
  [false, undefined, true, true, false, false, 'switch_off'],
  [false, undefined, true, false, false, false, 'switch_off'],
  [false, undefined, false, true, false, false, 'switch_off'],
  [false, undefined, false, false, false, false, 'switch_off'],
  [false, true, true, true, false, false, 'switch_off'],
  [false, true, true, false, false, false, 'switch_off'],
  [false, true, false, true, false, false, 'switch_off'],
  [false, true, false, false, false, false, 'switch_off'],
  [false, false, true, true, false, false, 'switch_off'],
  [false, false, true, false, false, false, 'switch_off'],
  [false, false, false, true, false, false, 'switch_off'],
  [false, false, false, false, false, false, 'switch_off'],
];

describe('resolveDispatcherEnablement', () => {
  it('covers every combination', () => {
    expect(new Set(TABLE.map((r) => r.slice(0, 4).join())).size).toBe(3 * 3 * 2 * 2);
  });

  it.each(TABLE)('saved %s, experimental %s, new layout %s, app MCP %s', (saved, experimental, newLayout, appMcp, savedOn, enabled, reason) => {
    const graduatedFlagOn = isGraduatedFlagOn(experimental === undefined ? {} : { dispatcher: experimental }, 'dispatcher');
    expect(resolveDispatcherEnablement({ saved, graduatedFlagOn, newLayout, appMcp })).toEqual({ savedOn, enabled, reason });
  });
});
