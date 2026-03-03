import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Structural tests for the floating card UI reskin.
 *
 * Verifies CSS classes exist and are applied in the correct places,
 * ensuring the floating card visual treatment is consistently applied
 * across all layout paths.
 */

const cssSource = readFileSync(join(__dirname, 'index.css'), 'utf-8').replace(/\r\n/g, '\n');
const appSource = readFileSync(join(__dirname, 'App.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const dividerSource = readFileSync(
  join(__dirname, 'components', 'ResizeDivider.tsx'),
  'utf-8',
).replace(/\r\n/g, '\n');
const explorerSource = readFileSync(
  join(__dirname, 'panels', 'ExplorerRail.tsx'),
  'utf-8',
).replace(/\r\n/g, '\n');
const accessorySource = readFileSync(
  join(__dirname, 'panels', 'AccessoryPanel.tsx'),
  'utf-8',
).replace(/\r\n/g, '\n');
const railSource = readFileSync(
  join(__dirname, 'panels', 'ProjectRail.tsx'),
  'utf-8',
).replace(/\r\n/g, '\n');

// ─── CSS Class Definitions ──────────────────────────────────────────────────

describe('Floating card CSS classes', () => {
  it('should define .floating-panel with border-radius and box-shadow', () => {
    expect(cssSource).toContain('.floating-panel {');
    expect(cssSource).toMatch(/\.floating-panel\s*\{[^}]*border-radius:\s*12px/);
    expect(cssSource).toMatch(/\.floating-panel\s*\{[^}]*box-shadow:/);
    expect(cssSource).toMatch(/\.floating-panel\s*\{[^}]*overflow:\s*hidden/);
  });

  it('should define .floating-panel-pill with larger border-radius', () => {
    expect(cssSource).toContain('.floating-panel-pill {');
    expect(cssSource).toMatch(/\.floating-panel-pill\s*\{[^}]*border-radius:\s*16px/);
    expect(cssSource).toMatch(/\.floating-panel-pill\s*\{[^}]*box-shadow:/);
    expect(cssSource).toMatch(/\.floating-panel-pill\s*\{[^}]*overflow:\s*hidden/);
  });
});

// ─── App.tsx Layout Application ─────────────────────────────────────────────

describe('App.tsx floating card layout', () => {
  it('should use bg-ctp-crust as the window background in all return paths', () => {
    // All outer divs should use crust (darker bg for floating effect)
    const crustMatches = [...appSource.matchAll(/bg-ctp-crust/g)];
    // At least 4 outer containers + title bar references
    expect(crustMatches.length).toBeGreaterThanOrEqual(4);
    // Should NOT use bg-ctp-base as the outer window background
    const outerDivPattern = /h-screen w-screen overflow-hidden bg-ctp-base/;
    expect(appSource).not.toMatch(outerDivPattern);
  });

  it('should apply floating-panel-pill to explorer and accessory wrappers', () => {
    expect(appSource).toContain('floating-panel-pill bg-ctp-mantle');
  });

  it('should apply floating-panel to main content wrapper', () => {
    expect(appSource).toContain('floating-panel bg-ctp-base');
  });

  it('should add padding and gap to the content grid', () => {
    // All content grids should have gap and padding for floating effect
    const gridPattern = /gap-2 px-2 pb-2/;
    expect(appSource).toMatch(gridPattern);
  });
});

// ─── Panel Border Removal ───────────────────────────────────────────────────

describe('Panel border removal (shadow-based separation)', () => {
  it('ExplorerRail should not have border-r border-surface-0', () => {
    expect(explorerSource).not.toContain('border-r border-surface-0');
  });

  it('AccessoryPanel should not have border-r border-surface-0', () => {
    expect(accessorySource).not.toContain('border-r border-surface-0');
  });

  it('ProjectRail should not have border-r border-surface-0', () => {
    expect(railSource).not.toContain('border-r border-surface-0');
  });

  it('ProjectRail should have rounded corners', () => {
    expect(railSource).toContain('rounded-xl');
  });

  it('ProjectRail should have a shadow in non-overlay state', () => {
    expect(railSource).toContain('shadow-md shadow-black/10');
  });
});

// ─── ResizeDivider ──────────────────────────────────────────────────────────

describe('ResizeDivider floating layout', () => {
  it('should be wider than the original 5px to serve as visual gap', () => {
    // The divider width should be > 5 for better spacing between floating cards
    const widthMatch = dividerSource.match(/width:\s*(\d+)/);
    expect(widthMatch).not.toBeNull();
    expect(Number(widthMatch![1])).toBeGreaterThan(5);
  });

  it('should have transparent line by default (not solid)', () => {
    expect(dividerSource).toContain("'transparent'");
  });
});
