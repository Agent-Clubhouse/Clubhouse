import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CanvasTabBar } from './CanvasTabBar';
import type { CanvasInstance } from './canvas-types';

function makeCanvas(id: string, name: string): CanvasInstance {
  return {
    id,
    name,
    views: [],
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nextZIndex: 0,
    zoomedViewId: null,
    selectedViewId: null,
    minimapAutoHide: true,
    elkAlgorithm: 'layered',
    elkDirection: 'RIGHT',
    layoutCenterId: null,
  };
}

const defaultProps = {
  canvases: [makeCanvas('c1', 'Canvas 1'), makeCanvas('c2', 'Canvas 2')],
  activeCanvasId: 'c1',
  onSelectCanvas: vi.fn(),
  onAddCanvas: vi.fn(),
  onRemoveCanvas: vi.fn(),
  onRenameCanvas: vi.fn(),
};

describe('CanvasTabBar', () => {
  it('renders canvas tabs', () => {
    render(<CanvasTabBar {...defaultProps} />);
    expect(screen.getByText('Canvas 1')).toBeDefined();
    expect(screen.getByText('Canvas 2')).toBeDefined();
  });

  it('renders + button that opens dropdown when onAddFromBlueprint is provided', () => {
    const onAddFromBlueprint = vi.fn();
    render(<CanvasTabBar {...defaultProps} onAddFromBlueprint={onAddFromBlueprint} />);

    const addBtn = screen.getByTestId('canvas-add-button');
    fireEvent.click(addBtn);

    expect(screen.getByTestId('canvas-add-menu')).toBeDefined();
    expect(screen.getByTestId('canvas-add-new')).toBeDefined();
    expect(screen.getByTestId('canvas-add-from-blueprint')).toBeDefined();
  });

  it('"New Canvas" menu item calls onAddCanvas', () => {
    const onAddFromBlueprint = vi.fn();
    render(<CanvasTabBar {...defaultProps} onAddFromBlueprint={onAddFromBlueprint} />);

    fireEvent.click(screen.getByTestId('canvas-add-button'));
    fireEvent.click(screen.getByTestId('canvas-add-new'));

    expect(defaultProps.onAddCanvas).toHaveBeenCalled();
  });

  it('"From Blueprint" menu item calls onAddFromBlueprint', () => {
    const onAddFromBlueprint = vi.fn();
    render(<CanvasTabBar {...defaultProps} onAddFromBlueprint={onAddFromBlueprint} />);

    fireEvent.click(screen.getByTestId('canvas-add-button'));
    fireEvent.click(screen.getByTestId('canvas-add-from-blueprint'));

    expect(onAddFromBlueprint).toHaveBeenCalled();
  });

  it('+ button calls onAddCanvas directly when no onAddFromBlueprint', () => {
    render(<CanvasTabBar {...defaultProps} />);
    fireEvent.click(screen.getByTestId('canvas-add-button'));
    expect(defaultProps.onAddCanvas).toHaveBeenCalled();
  });

  it('right-click on tab shows context menu with Export as Blueprint', () => {
    const onExportBlueprint = vi.fn();
    render(<CanvasTabBar {...defaultProps} onExportBlueprint={onExportBlueprint} />);

    const tab = screen.getByTestId('canvas-tab-c1');
    fireEvent.contextMenu(tab);

    expect(screen.getByTestId('canvas-tab-context-menu')).toBeDefined();
    expect(screen.getByTestId('canvas-tab-export-blueprint')).toBeDefined();
  });

  it('Export as Blueprint context menu item calls onExportBlueprint', () => {
    const onExportBlueprint = vi.fn();
    render(<CanvasTabBar {...defaultProps} onExportBlueprint={onExportBlueprint} />);

    const tab = screen.getByTestId('canvas-tab-c1');
    fireEvent.contextMenu(tab);
    fireEvent.click(screen.getByTestId('canvas-tab-export-blueprint'));

    expect(onExportBlueprint).toHaveBeenCalledWith('c1');
  });
});
