import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { clampMenuPosition, resolveRadialRootId } from './canvas-operations';

/**
 * Tests for Mission 40 canvas UX fixes:
 * (a) ELK radial center fallback chain — behavioral tests on resolveRadialRootId
 * (b) Context menu bounds clamping — behavioral tests on clampMenuPosition
 * (c) Wire disconnect single-click — structural verification (PR #1299)
 */

// ── (a) ELK radial layout center fallback ──────────────────────────

describe('resolveRadialRootId', () => {
  it('returns undefined for non-radial algorithms', () => {
    expect(resolveRadialRootId('layered', 'v1', 'v2')).toBeUndefined();
    expect(resolveRadialRootId('force', 'v1', 'v2')).toBeUndefined();
    expect(resolveRadialRootId('mrtree', 'v1', null)).toBeUndefined();
  });

  it('prefers selectedViewId when both are set', () => {
    expect(resolveRadialRootId('radial', 'selected', 'stored')).toBe('selected');
  });

  it('falls back to layoutCenterId when selectedViewId is null', () => {
    expect(resolveRadialRootId('radial', null, 'stored-center')).toBe('stored-center');
  });

  it('returns undefined when both are null (server auto-detects)', () => {
    expect(resolveRadialRootId('radial', null, null)).toBeUndefined();
  });

  it('handles empty string selectedViewId as truthy', () => {
    // Empty string is falsy in JS but ?? only skips null/undefined
    expect(resolveRadialRootId('radial', '', 'stored')).toBe('');
  });
});

// ── (b) Context menu viewport bounds clamping ──────────────────────

describe('clampMenuPosition', () => {
  const vw = 1280;
  const vh = 800;
  const menuW = 180;
  const menuH = 70;

  it('returns original position when menu fits within viewport', () => {
    const result = clampMenuPosition(400, 300, menuW, menuH, vw, vh);
    expect(result).toEqual({ x: 400, y: 300 });
  });

  it('clamps x when menu overflows right edge', () => {
    // Click at x=1200, menu width=180 → right edge at 1388 > 1280
    const result = clampMenuPosition(1200, 300, menuW, menuH, vw, vh);
    expect(result.x).toBeLessThan(1200);
    expect(result.x + menuW + 8).toBeLessThanOrEqual(vw);
    expect(result.y).toBe(300); // y unchanged
  });

  it('clamps y when menu overflows bottom edge', () => {
    // Click at y=760, menu height=70 → bottom edge at 838 > 800
    const result = clampMenuPosition(400, 760, menuW, menuH, vw, vh);
    expect(result.y).toBeLessThan(760);
    expect(result.y + menuH + 8).toBeLessThanOrEqual(vh);
    expect(result.x).toBe(400); // x unchanged
  });

  it('clamps both x and y when menu overflows both edges', () => {
    const result = clampMenuPosition(1200, 760, menuW, menuH, vw, vh);
    expect(result.x).toBeLessThan(1200);
    expect(result.y).toBeLessThan(760);
    expect(result.x + menuW + 8).toBeLessThanOrEqual(vw);
    expect(result.y + menuH + 8).toBeLessThanOrEqual(vh);
  });

  it('uses custom padding', () => {
    // With padding=20, the threshold is tighter
    const result = clampMenuPosition(1100, 300, menuW, menuH, vw, vh, 20);
    // 1100 + 180 + 20 = 1300 > 1280 → should clamp
    expect(result.x).toBeLessThan(1100);
  });

  it('does not clamp when menu exactly fits', () => {
    // Position where menu exactly fills to edge minus padding
    const exactX = vw - menuW - 8;
    const result = clampMenuPosition(exactX, 300, menuW, menuH, vw, vh);
    expect(result.x).toBe(exactX);
  });

  it('handles zero-size viewport gracefully', () => {
    const result = clampMenuPosition(100, 100, menuW, menuH, 0, 0);
    expect(result.x).toBeLessThan(100);
    expect(result.y).toBeLessThan(100);
  });
});

// ── (c) Wire disconnect (PR #1299 verification — structural) ──────

describe('Wire disconnect (PR #1299 verification)', () => {
  it('onRemoveWireDefinition is called before unbind in handleDisconnect', () => {
    // PR #1299 fixed the double-click wire disconnect by moving
    // onRemoveWireDefinition before await unbind() to prevent
    // onBindingsChanged from overwriting state.
    // Structural verification is acceptable here — we're confirming
    // another PR's fix is still in place.
    const popoverSource = fs.readFileSync(
      path.resolve(__dirname, 'WireConfigPopover.tsx'),
      'utf-8',
    );

    const disconnectBlock = popoverSource.slice(
      popoverSource.indexOf('handleDisconnect'),
      popoverSource.indexOf('handleDisconnect') + 300,
    );

    const removeIdx = disconnectBlock.indexOf('onRemoveWireDefinition');
    const unbindIdx = disconnectBlock.indexOf('await unbind');
    expect(removeIdx).toBeGreaterThan(-1);
    expect(unbindIdx).toBeGreaterThan(-1);
    // onRemoveWireDefinition must come BEFORE await unbind
    expect(removeIdx).toBeLessThan(unbindIdx);
  });
});
