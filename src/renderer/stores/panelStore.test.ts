import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePanelStore } from './panelStore';

describe('panelStore', () => {
  beforeEach(() => {
    usePanelStore.setState({
      explorerWidth: 200,
      explorerCollapsed: false,
      accessoryWidth: 280,
      accessoryCollapsed: false,
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
});
