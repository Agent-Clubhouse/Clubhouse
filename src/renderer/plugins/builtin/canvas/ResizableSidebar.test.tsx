import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { ResizableSidebar, RAIL_WIDTH, DEFAULT_MIN_WIDTH, DEFAULT_MAX_WIDTH } from './ResizableSidebar';

describe('ResizableSidebar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the sidebar at the default width', () => {
    const { getByTestId } = render(
      <ResizableSidebar defaultWidth={200}>
        <div>Content</div>
      </ResizableSidebar>,
    );
    const sidebar = getByTestId('resizable-sidebar');
    expect(sidebar).toBeInTheDocument();
    expect(sidebar.style.width).toBe('200px');
  });

  it('renders children inside the sidebar', () => {
    const { getByText } = render(
      <ResizableSidebar defaultWidth={200}>
        <div>My sidebar content</div>
      </ResizableSidebar>,
    );
    expect(getByText('My sidebar content')).toBeInTheDocument();
  });

  it('renders the resize divider', () => {
    const { getByTestId } = render(
      <ResizableSidebar defaultWidth={200}>
        <div>Content</div>
      </ResizableSidebar>,
    );
    expect(getByTestId('resize-divider')).toBeInTheDocument();
  });

  it('resizes the sidebar on drag', () => {
    const { getByTestId } = render(
      <ResizableSidebar defaultWidth={200}>
        <div>Content</div>
      </ResizableSidebar>,
    );
    const divider = getByTestId('resize-divider');
    fireEvent.mouseDown(divider, { clientX: 200 });
    fireEvent.mouseMove(document, { clientX: 250 });
    fireEvent.mouseUp(document);

    const sidebar = getByTestId('resizable-sidebar');
    expect(sidebar.style.width).toBe('250px');
  });

  it('clamps width to minWidth', () => {
    const { getByTestId } = render(
      <ResizableSidebar defaultWidth={200} minWidth={150}>
        <div>Content</div>
      </ResizableSidebar>,
    );
    const divider = getByTestId('resize-divider');
    fireEvent.mouseDown(divider, { clientX: 200 });
    fireEvent.mouseMove(document, { clientX: 100 });
    fireEvent.mouseUp(document);

    const sidebar = getByTestId('resizable-sidebar');
    expect(sidebar.style.width).toBe('150px');
  });

  it('clamps width to maxWidth', () => {
    const { getByTestId } = render(
      <ResizableSidebar defaultWidth={200} maxWidth={300}>
        <div>Content</div>
      </ResizableSidebar>,
    );
    const divider = getByTestId('resize-divider');
    fireEvent.mouseDown(divider, { clientX: 200 });
    fireEvent.mouseMove(document, { clientX: 500 });
    fireEvent.mouseUp(document);

    const sidebar = getByTestId('resizable-sidebar');
    expect(sidebar.style.width).toBe('300px');
  });

  it('collapses to a rail on double-click of divider', () => {
    const { getByTestId, queryByTestId } = render(
      <ResizableSidebar defaultWidth={200}>
        <div>Content</div>
      </ResizableSidebar>,
    );
    fireEvent.doubleClick(getByTestId('resize-divider'));

    expect(queryByTestId('resizable-sidebar')).toBeNull();
    const rail = getByTestId('resizable-sidebar-rail');
    expect(rail).toBeInTheDocument();
    expect(rail.style.width).toBe(`${RAIL_WIDTH}px`);
  });

  it('shows overlay on hover when collapsed', () => {
    const { getByTestId, queryByTestId } = render(
      <ResizableSidebar defaultWidth={200}>
        <div>Sidebar content</div>
      </ResizableSidebar>,
    );

    // Collapse
    fireEvent.doubleClick(getByTestId('resize-divider'));
    expect(queryByTestId('resizable-sidebar-overlay')).toBeNull();

    // Hover over rail
    const rail = getByTestId('resizable-sidebar-rail');
    fireEvent.mouseEnter(rail.querySelector('[title="Expand sidebar"]')!);

    const overlay = getByTestId('resizable-sidebar-overlay');
    expect(overlay).toBeInTheDocument();
    expect(overlay.style.width).toBe('200px');
  });

  it('hides overlay after mouse leaves with delay', () => {
    const { getByTestId, queryByTestId } = render(
      <ResizableSidebar defaultWidth={200}>
        <div>Content</div>
      </ResizableSidebar>,
    );

    // Collapse and hover
    fireEvent.doubleClick(getByTestId('resize-divider'));
    const railInner = getByTestId('resizable-sidebar-rail').querySelector('[title="Expand sidebar"]')!;
    fireEvent.mouseEnter(railInner);
    expect(getByTestId('resizable-sidebar-overlay')).toBeInTheDocument();

    // Leave the rail
    fireEvent.mouseLeave(railInner);

    // Overlay should still be visible during the 150ms delay
    expect(queryByTestId('resizable-sidebar-overlay')).toBeInTheDocument();

    // After the delay, overlay disappears
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(queryByTestId('resizable-sidebar-overlay')).toBeNull();
  });

  it('keeps overlay visible when moving from rail to overlay', () => {
    const { getByTestId, queryByTestId } = render(
      <ResizableSidebar defaultWidth={200}>
        <div>Content</div>
      </ResizableSidebar>,
    );

    // Collapse and hover rail
    fireEvent.doubleClick(getByTestId('resize-divider'));
    const railInner = getByTestId('resizable-sidebar-rail').querySelector('[title="Expand sidebar"]')!;
    fireEvent.mouseEnter(railInner);
    fireEvent.mouseLeave(railInner);

    // Move into overlay before timeout
    const overlay = getByTestId('resizable-sidebar-overlay');
    fireEvent.mouseEnter(overlay);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Overlay should still be visible
    expect(queryByTestId('resizable-sidebar-overlay')).toBeInTheDocument();
  });

  it('expands from collapsed state on rail click', () => {
    const { getByTestId, queryByTestId } = render(
      <ResizableSidebar defaultWidth={200}>
        <div>Content</div>
      </ResizableSidebar>,
    );

    // Collapse
    fireEvent.doubleClick(getByTestId('resize-divider'));
    expect(queryByTestId('resizable-sidebar')).toBeNull();

    // Click the rail to expand
    const railInner = getByTestId('resizable-sidebar-rail').querySelector('[title="Expand sidebar"]')!;
    fireEvent.click(railInner);

    expect(getByTestId('resizable-sidebar')).toBeInTheDocument();
    expect(queryByTestId('resizable-sidebar-rail')).toBeNull();
  });

  it('renders the expand icon in the rail', () => {
    const { getByTestId } = render(
      <ResizableSidebar defaultWidth={200}>
        <div>Content</div>
      </ResizableSidebar>,
    );

    fireEvent.doubleClick(getByTestId('resize-divider'));
    expect(getByTestId('rail-expand-icon')).toBeInTheDocument();
  });

  it('uses default min/max values from constants', () => {
    expect(DEFAULT_MIN_WIDTH).toBe(120);
    expect(DEFAULT_MAX_WIDTH).toBe(400);
    expect(RAIL_WIDTH).toBe(28);
  });

  it('applies className to sidebar container', () => {
    const { getByTestId } = render(
      <ResizableSidebar defaultWidth={200} className="bg-ctp-mantle/30">
        <div>Content</div>
      </ResizableSidebar>,
    );
    expect(getByTestId('resizable-sidebar').className).toContain('bg-ctp-mantle/30');
  });

  it('applies className to overlay when collapsed and hovered', () => {
    const { getByTestId } = render(
      <ResizableSidebar defaultWidth={200} className="bg-ctp-mantle/30">
        <div>Content</div>
      </ResizableSidebar>,
    );

    fireEvent.doubleClick(getByTestId('resize-divider'));
    const railInner = getByTestId('resizable-sidebar-rail').querySelector('[title="Expand sidebar"]')!;
    fireEvent.mouseEnter(railInner);

    expect(getByTestId('resizable-sidebar-overlay').className).toContain('bg-ctp-mantle/30');
  });
});
