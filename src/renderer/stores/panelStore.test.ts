import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePanelStore } from './panelStore';

describe('panelStore', () => {
  beforeEach(() => {
    usePanelStore.setState({
      explorerWidth: 200,
      explorerCollapsed: false,
      accessoryWidth: 280,
      accessoryCollapsed: false,
      railPinned: false,
      railWidth: 200,
    });
    vi.restoreAllMocks();
  });

  it('resizes explorer within bounds', () => {
    usePanelStore.getState().resizeExplorer(50);
    expect(usePanelStore.getState().explorerWidth).toBe(250);
  });

  it('clamps explorer at max', () => {
    usePanelStore.getState().resizeExplorer(300);
    expect(usePanelStore.getState().explorerWidth).toBe(400);
  });

  it('clamps explorer to min when dragged between snap and min', () => {
    usePanelStore.getState().resizeExplorer(-100);
    expect(usePanelStore.getState().explorerCollapsed).toBe(false);
    expect(usePanelStore.getState().explorerWidth).toBe(140);
  });

  it('auto-collapses explorer only when dragged below snap threshold', () => {
    usePanelStore.getState().resizeExplorer(-200);
    expect(usePanelStore.getState().explorerCollapsed).toBe(true);
  });

  it('ignores resize when explorer is collapsed', () => {
    usePanelStore.setState({ explorerCollapsed: true });
    usePanelStore.getState().resizeExplorer(50);
    expect(usePanelStore.getState().explorerWidth).toBe(200);
  });

  it('toggles explorer collapse', () => {
    expect(usePanelStore.getState().explorerCollapsed).toBe(false);
    usePanelStore.getState().toggleExplorerCollapse();
    expect(usePanelStore.getState().explorerCollapsed).toBe(true);
    usePanelStore.getState().toggleExplorerCollapse();
    expect(usePanelStore.getState().explorerCollapsed).toBe(false);
  });

  it('resizes accessory within bounds', () => {
    usePanelStore.getState().resizeAccessory(50);
    expect(usePanelStore.getState().accessoryWidth).toBe(330);
  });

  it('clamps accessory at max', () => {
    usePanelStore.getState().resizeAccessory(300);
    expect(usePanelStore.getState().accessoryWidth).toBe(500);
  });

  it('clamps accessory to min when dragged between snap and min', () => {
    usePanelStore.getState().resizeAccessory(-100);
    expect(usePanelStore.getState().accessoryCollapsed).toBe(false);
    expect(usePanelStore.getState().accessoryWidth).toBe(200);
  });

  it('auto-collapses accessory only when dragged below snap threshold', () => {
    usePanelStore.getState().resizeAccessory(-250);
    expect(usePanelStore.getState().accessoryCollapsed).toBe(true);
  });

  it('toggles accessory collapse', () => {
    usePanelStore.getState().toggleAccessoryCollapse();
    expect(usePanelStore.getState().accessoryCollapsed).toBe(true);
  });

  it('state reflects resize across actions', () => {
    usePanelStore.getState().resizeExplorer(50);
    expect(usePanelStore.getState().explorerWidth).toBe(250);
    usePanelStore.getState().resizeAccessory(20);
    expect(usePanelStore.getState().accessoryWidth).toBe(300);
    // Collapse + uncollapse preserves width
    usePanelStore.getState().toggleExplorerCollapse();
    expect(usePanelStore.getState().explorerCollapsed).toBe(true);
    usePanelStore.getState().toggleExplorerCollapse();
    expect(usePanelStore.getState().explorerCollapsed).toBe(false);
    expect(usePanelStore.getState().explorerWidth).toBe(250);
  });

  // ── Rail pin tests ──────────────────────────────────────────────────────

  it('rail starts unpinned', () => {
    expect(usePanelStore.getState().railPinned).toBe(false);
  });

  it('toggleRailPin toggles pinned state', () => {
    usePanelStore.getState().toggleRailPin();
    expect(usePanelStore.getState().railPinned).toBe(true);
    usePanelStore.getState().toggleRailPin();
    expect(usePanelStore.getState().railPinned).toBe(false);
  });

  it('rail starts at default width of 200', () => {
    expect(usePanelStore.getState().railWidth).toBe(200);
  });

  it('resizeRail adjusts width', () => {
    usePanelStore.getState().resizeRail(50);
    expect(usePanelStore.getState().railWidth).toBe(250);
  });

  it('resizeRail clamps at minimum (140)', () => {
    usePanelStore.getState().resizeRail(-100);
    expect(usePanelStore.getState().railWidth).toBe(140);
  });

  it('resizeRail clamps at maximum (400)', () => {
    usePanelStore.getState().resizeRail(300);
    expect(usePanelStore.getState().railWidth).toBe(400);
  });

  it('resizeRail accumulates across multiple calls', () => {
    usePanelStore.getState().resizeRail(30);
    usePanelStore.getState().resizeRail(30);
    expect(usePanelStore.getState().railWidth).toBe(260);
  });

  it('toggling pin preserves rail width', () => {
    usePanelStore.getState().resizeRail(50);
    expect(usePanelStore.getState().railWidth).toBe(250);
    usePanelStore.getState().toggleRailPin();
    expect(usePanelStore.getState().railPinned).toBe(true);
    expect(usePanelStore.getState().railWidth).toBe(250);
    usePanelStore.getState().toggleRailPin();
    expect(usePanelStore.getState().railPinned).toBe(false);
    expect(usePanelStore.getState().railWidth).toBe(250);
  });

  it('resizeRail with zero delta is a no-op', () => {
    usePanelStore.getState().resizeRail(0);
    expect(usePanelStore.getState().railWidth).toBe(200);
  });

  it('resizeRail with negative delta that would go below min clamps', () => {
    usePanelStore.setState({ railWidth: 150 });
    usePanelStore.getState().resizeRail(-20);
    expect(usePanelStore.getState().railWidth).toBe(140);
  });

  it('rail pin state is independent of explorer collapse', () => {
    usePanelStore.getState().toggleRailPin();
    usePanelStore.getState().toggleExplorerCollapse();
    expect(usePanelStore.getState().railPinned).toBe(true);
    expect(usePanelStore.getState().explorerCollapsed).toBe(true);
  });

  // ── Debounced persist tests ──────────────────────────────────────────

  describe('debounced persist', () => {
    it('store state updates immediately despite debounced persist', () => {
      // Rapid resizes should update store state synchronously
      // even though localStorage writes are debounced
      usePanelStore.getState().resizeExplorer(10);
      expect(usePanelStore.getState().explorerWidth).toBe(210);
      usePanelStore.getState().resizeExplorer(10);
      expect(usePanelStore.getState().explorerWidth).toBe(220);
      usePanelStore.getState().resizeExplorer(10);
      expect(usePanelStore.getState().explorerWidth).toBe(230);
    });

    it('rapid accessory resizes all apply without blocking', () => {
      for (let i = 0; i < 50; i++) {
        usePanelStore.getState().resizeAccessory(2);
      }
      // All 50 increments should have applied (280 + 100 = 380, clamped at 400)
      expect(usePanelStore.getState().accessoryWidth).toBe(380);
    });

    it('rapid rail resizes all apply without blocking', () => {
      for (let i = 0; i < 50; i++) {
        usePanelStore.getState().resizeRail(2);
      }
      expect(usePanelStore.getState().railWidth).toBe(300);
    });
  });
});
