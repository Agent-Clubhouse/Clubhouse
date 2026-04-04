import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural tests for Mission 40 canvas UX fixes:
 * (a) ELK radial center fallback chain
 * (b) View context menu positioning with bounds clamping
 * (c) Wire disconnect single-click (verified already fixed by PR #1299)
 */

const workspaceSource = fs.readFileSync(
  path.resolve(__dirname, 'CanvasWorkspace.tsx'),
  'utf-8',
);

describe('ELK radial layout center fallback', () => {
  it('rootId uses selectedViewId ?? layoutCenterId ?? undefined fallback chain', () => {
    // The rootId computation must fall back through selectedViewId → layoutCenterId → undefined
    // Previously it only used selectedViewId, ignoring the stored layoutCenterId
    const rootIdLine = workspaceSource
      .split('\n')
      .find((line) => line.includes('const rootId') && line.includes('radial'));
    expect(rootIdLine).toBeTruthy();
    expect(rootIdLine).toContain('selectedViewId ?? layoutCenterId');
  });

  it('passes rootId to layoutElk options', () => {
    // The computed rootId should be passed in the options to the ELK layout call
    const layoutBlock = workspaceSource.slice(
      workspaceSource.indexOf('window.clubhouse.canvas.layoutElk'),
      workspaceSource.indexOf('window.clubhouse.canvas.layoutElk') + 300,
    );
    expect(layoutBlock).toContain('rootId');
    expect(layoutBlock).toContain('layoutCenterId');
  });

  it('layoutCenterId is included in component props', () => {
    // The CanvasWorkspace must accept layoutCenterId as a prop
    expect(workspaceSource).toContain('layoutCenterId: string | null');
  });
});

describe('View context menu positioning', () => {
  it('view context menu uses MenuPortal for correct fixed positioning', () => {
    // The view context menu must render through MenuPortal to bypass
    // the canvas transform container's containing block.
    // Search the JSX render section (second occurrence of the comment, near MenuPortal)
    const renderIdx = workspaceSource.lastIndexOf('{/* View context menu (right-click');
    const menuBlock = workspaceSource.slice(renderIdx, renderIdx + 500);
    expect(menuBlock).toContain('MenuPortal');
    expect(menuBlock).toContain('fixed');
  });

  it('view context menu has a ref for bounds clamping and dismissal', () => {
    // The menu div must have a ref for viewport bounds adjustment
    const renderIdx = workspaceSource.lastIndexOf('{/* View context menu (right-click');
    const menuBlock = workspaceSource.slice(renderIdx, renderIdx + 500);
    expect(menuBlock).toContain('ref={viewMenuRef}');
  });

  it('viewport bounds clamping adjusts menu position when overflowing', () => {
    // There must be a useLayoutEffect that clamps the menu to viewport bounds
    expect(workspaceSource).toContain('overflowX');
    expect(workspaceSource).toContain('overflowY');
    expect(workspaceSource).toContain('window.innerWidth');
    expect(workspaceSource).toContain('window.innerHeight');
  });

  it('view context menu has useDismissibleLayer for click-outside dismiss', () => {
    // The view context menu must use useDismissibleLayer for proper dismissal
    expect(workspaceSource).toContain('useDismissibleLayer');
    expect(workspaceSource).toContain('viewMenuRef');
  });
});

describe('Wire disconnect (PR #1299 verification)', () => {
  it('onRemoveWireDefinition is called before unbind in handleDisconnect', () => {
    // PR #1299 fixed the double-click wire disconnect by moving
    // onRemoveWireDefinition before await unbind() to prevent
    // onBindingsChanged from overwriting state
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
