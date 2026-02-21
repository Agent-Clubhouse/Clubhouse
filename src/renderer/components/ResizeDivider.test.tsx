import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ResizeDivider } from './ResizeDivider';

describe('ResizeDivider', () => {
  it('renders the divider', () => {
    const { getByTestId } = render(
      <ResizeDivider
        onResize={vi.fn()}
        onToggleCollapse={vi.fn()}
        collapsed={false}
        collapseDirection="left"
      />
    );
    expect(getByTestId('resize-divider')).toBeInTheDocument();
  });

  it('calls onToggleCollapse on double-click', () => {
    const onToggle = vi.fn();
    const { getByTestId } = render(
      <ResizeDivider
        onResize={vi.fn()}
        onToggleCollapse={onToggle}
        collapsed={false}
        collapseDirection="left"
      />
    );
    fireEvent.doubleClick(getByTestId('resize-divider'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('shows collapse button on hover', () => {
    const onToggle = vi.fn();
    const { getByTestId, queryByTestId } = render(
      <ResizeDivider
        onResize={vi.fn()}
        onToggleCollapse={onToggle}
        collapsed={false}
        collapseDirection="left"
      />
    );
    expect(queryByTestId('collapse-button')).toBeNull();
    fireEvent.mouseEnter(getByTestId('resize-divider'));
    expect(queryByTestId('collapse-button')).toBeInTheDocument();
  });

  it('sets col-resize cursor style', () => {
    const { getByTestId } = render(
      <ResizeDivider
        onResize={vi.fn()}
        onToggleCollapse={vi.fn()}
        collapsed={false}
        collapseDirection="left"
      />
    );
    expect(getByTestId('resize-divider').style.cursor).toBe('col-resize');
  });

  it('calls onResize during drag', () => {
    const onResize = vi.fn();
    const { getByTestId } = render(
      <ResizeDivider
        onResize={onResize}
        onToggleCollapse={vi.fn()}
        collapsed={false}
        collapseDirection="left"
      />
    );
    fireEvent.mouseDown(getByTestId('resize-divider'), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 120 });
    expect(onResize).toHaveBeenCalledWith(20);
    fireEvent.mouseUp(document);
  });
});
