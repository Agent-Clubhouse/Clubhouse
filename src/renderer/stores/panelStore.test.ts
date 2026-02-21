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

  it('auto-collapses explorer when dragged below min', () => {
    usePanelStore.getState().resizeExplorer(-100);
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

  it('auto-collapses accessory when dragged below min', () => {
    usePanelStore.getState().resizeAccessory(-100);
    expect(usePanelStore.getState().accessoryCollapsed).toBe(true);
  });

  it('toggles accessory collapse', () => {
    usePanelStore.getState().toggleAccessoryCollapse();
    expect(usePanelStore.getState().accessoryCollapsed).toBe(true);
  });

  it('persists state to localStorage', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    usePanelStore.getState().resizeExplorer(50);
    expect(spy).toHaveBeenCalledWith('clubhouse_panel_sizes', expect.any(String));
    const saved = JSON.parse(spy.mock.calls[0][1] as string);
    expect(saved.explorerWidth).toBe(250);
  });
});
