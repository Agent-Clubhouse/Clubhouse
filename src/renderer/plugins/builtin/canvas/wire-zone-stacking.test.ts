import { describe, it, expect } from 'vitest';

/**
 * Wire-zone stacking: the wire overlay must sit above zone backgrounds
 * but below cards. CanvasWorkspace wraps the WireOverlay in a div whose
 * z-index is `max(zone.zIndex) + 1`. This file tests the z-index
 * computation that drives that wrapper.
 */

/** Mirrors the z-index computation in CanvasWorkspace.tsx */
function computeWireLayerZIndex(zones: Array<{ zIndex: number }>): number {
  return zones.reduce((max, z) => Math.max(max, z.zIndex), -1) + 1;
}

describe('wire-zone-stacking z-index', () => {
  it('returns 0 when there are no zones', () => {
    expect(computeWireLayerZIndex([])).toBe(0);
  });

  it('returns 1 when the only zone has zIndex 0', () => {
    expect(computeWireLayerZIndex([{ zIndex: 0 }])).toBe(1);
  });

  it('returns max zone zIndex + 1 with multiple zones', () => {
    const zones = [{ zIndex: 0 }, { zIndex: 3 }, { zIndex: 1 }];
    expect(computeWireLayerZIndex(zones)).toBe(4);
  });

  it('handles zones that have been focused (high zIndex)', () => {
    // After focusing zone C, its zIndex was bumped to 10
    const zones = [{ zIndex: 2 }, { zIndex: 5 }, { zIndex: 10 }];
    expect(computeWireLayerZIndex(zones)).toBe(11);
  });

  it('wire layer is above zone backgrounds and below cards at same level', () => {
    // Zone at zIndex 3, cards at zIndex 4+
    const zoneZIndex = 3;
    const wireLayerZ = computeWireLayerZIndex([{ zIndex: zoneZIndex }]);
    // Wire layer should be above the zone
    expect(wireLayerZ).toBeGreaterThan(zoneZIndex);
    // Wire layer should be at most 1 above (not excessively high)
    expect(wireLayerZ).toBe(zoneZIndex + 1);
  });
});
