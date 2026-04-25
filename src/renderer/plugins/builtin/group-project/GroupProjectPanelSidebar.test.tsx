import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import {
  GroupProjectPanelSidebar,
  useGroupProjectPanelLayout,
  loadPanelLayout,
  savePanelLayout,
  PANEL_RAIL_WIDTH,
  TOPICS_DEFAULT_WIDTH,
  TOPICS_MIN_WIDTH,
  TOPICS_MAX_WIDTH,
  MESSAGES_DEFAULT_WIDTH,
  MESSAGES_MIN_WIDTH,
  MESSAGES_MAX_WIDTH,
} from './GroupProjectPanelSidebar';

// Stub localStorage for tests that use it
const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => localStorageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { localStorageStore[key] = value; }),
  removeItem: vi.fn((key: string) => { delete localStorageStore[key]; }),
});

/* ---------- GroupProjectPanelSidebar component tests ---------- */

describe('GroupProjectPanelSidebar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders sidebar at the given width when not collapsed', () => {
    const { getByTestId } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={false}
        onResize={vi.fn()}
        onToggleCollapse={vi.fn()}
      >
        <div>Content</div>
      </GroupProjectPanelSidebar>,
    );
    const sidebar = getByTestId('group-project-panel-sidebar');
    expect(sidebar).toBeInTheDocument();
    expect(sidebar.style.width).toBe('200px');
  });

  it('renders children when not collapsed', () => {
    const { getByText } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={false}
        onResize={vi.fn()}
        onToggleCollapse={vi.fn()}
      >
        <div>Panel content</div>
      </GroupProjectPanelSidebar>,
    );
    expect(getByText('Panel content')).toBeInTheDocument();
  });

  it('renders a ResizeDivider when not collapsed', () => {
    const { getByTestId } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={false}
        onResize={vi.fn()}
        onToggleCollapse={vi.fn()}
      >
        <div>Content</div>
      </GroupProjectPanelSidebar>,
    );
    expect(getByTestId('resize-divider')).toBeInTheDocument();
  });

  it('calls onResize when the divider is dragged', () => {
    const onResize = vi.fn();
    const { getByTestId } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={false}
        onResize={onResize}
        onToggleCollapse={vi.fn()}
      >
        <div>Content</div>
      </GroupProjectPanelSidebar>,
    );
    fireEvent.mouseDown(getByTestId('resize-divider'), { clientX: 200 });
    fireEvent.mouseMove(document, { clientX: 230 });
    fireEvent.mouseUp(document);
    expect(onResize).toHaveBeenCalledWith(30);
  });

  it('calls onToggleCollapse on divider double-click', () => {
    const onToggle = vi.fn();
    const { getByTestId } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={false}
        onResize={vi.fn()}
        onToggleCollapse={onToggle}
      >
        <div>Content</div>
      </GroupProjectPanelSidebar>,
    );
    fireEvent.doubleClick(getByTestId('resize-divider'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('renders a rail at PANEL_RAIL_WIDTH when collapsed', () => {
    const { getByTestId, queryByTestId } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={true}
        onResize={vi.fn()}
        onToggleCollapse={vi.fn()}
      >
        <div>Content</div>
      </GroupProjectPanelSidebar>,
    );
    expect(queryByTestId('group-project-panel-sidebar')).toBeNull();
    expect(queryByTestId('resize-divider')).toBeNull();
    const rail = getByTestId('group-project-panel-rail');
    expect(rail).toBeInTheDocument();
    expect(rail.style.width).toBe(`${PANEL_RAIL_WIDTH}px`);
  });

  it('shows the expand chevron icon in the rail', () => {
    const { getByTestId } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={true}
        onResize={vi.fn()}
        onToggleCollapse={vi.fn()}
      >
        <div>Content</div>
      </GroupProjectPanelSidebar>,
    );
    expect(getByTestId('panel-rail-icon')).toBeInTheDocument();
  });

  it('calls onToggleCollapse when rail toggle is clicked', () => {
    const onToggle = vi.fn();
    const { getByTestId } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={true}
        onResize={vi.fn()}
        onToggleCollapse={onToggle}
      >
        <div>Content</div>
      </GroupProjectPanelSidebar>,
    );
    fireEvent.click(getByTestId('panel-rail-toggle'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('shows hover overlay when mouse enters the rail', () => {
    const { getByTestId, queryByTestId } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={true}
        onResize={vi.fn()}
        onToggleCollapse={vi.fn()}
      >
        <div>Overlay content</div>
      </GroupProjectPanelSidebar>,
    );
    expect(queryByTestId('panel-rail-overlay')).toBeNull();
    fireEvent.mouseEnter(getByTestId('panel-rail-toggle'));
    const overlay = getByTestId('panel-rail-overlay');
    expect(overlay).toBeInTheDocument();
    expect(overlay.style.width).toBe('200px');
  });

  it('renders children inside the overlay', () => {
    const { getByTestId, getByText } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={true}
        onResize={vi.fn()}
        onToggleCollapse={vi.fn()}
      >
        <div>Overlay content</div>
      </GroupProjectPanelSidebar>,
    );
    fireEvent.mouseEnter(getByTestId('panel-rail-toggle'));
    expect(getByText('Overlay content')).toBeInTheDocument();
  });

  it('hides overlay after mouse leaves with 150ms delay', () => {
    const { getByTestId, queryByTestId } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={true}
        onResize={vi.fn()}
        onToggleCollapse={vi.fn()}
      >
        <div>Content</div>
      </GroupProjectPanelSidebar>,
    );
    fireEvent.mouseEnter(getByTestId('panel-rail-toggle'));
    expect(queryByTestId('panel-rail-overlay')).toBeInTheDocument();

    fireEvent.mouseLeave(getByTestId('panel-rail-toggle'));
    // Still visible before the delay
    expect(queryByTestId('panel-rail-overlay')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(200); });
    expect(queryByTestId('panel-rail-overlay')).toBeNull();
  });

  it('keeps overlay visible when mouse moves from rail into overlay', () => {
    const { getByTestId, queryByTestId } = render(
      <GroupProjectPanelSidebar
        width={200}
        collapsed={true}
        onResize={vi.fn()}
        onToggleCollapse={vi.fn()}
      >
        <div>Content</div>
      </GroupProjectPanelSidebar>,
    );
    fireEvent.mouseEnter(getByTestId('panel-rail-toggle'));
    fireEvent.mouseLeave(getByTestId('panel-rail-toggle'));

    // Move into overlay before timeout fires
    const overlay = getByTestId('panel-rail-overlay');
    fireEvent.mouseEnter(overlay);

    act(() => { vi.advanceTimersByTime(200); });
    // Overlay should still be visible
    expect(queryByTestId('panel-rail-overlay')).toBeInTheDocument();
  });
});

/* ---------- useGroupProjectPanelLayout hook tests ---------- */

describe('useGroupProjectPanelLayout', () => {
  beforeEach(() => {
    // Clear the store object and reset mock call history
    for (const key of Object.keys(localStorageStore)) delete localStorageStore[key];
    vi.mocked(localStorage.getItem).mockClear();
    vi.mocked(localStorage.setItem).mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const key of Object.keys(localStorageStore)) delete localStorageStore[key];
    vi.useRealTimers();
  });

  it('initializes with default widths and collapsed states', () => {
    const { result } = renderHook(() => useGroupProjectPanelLayout());
    expect(result.current.topicsWidth).toBe(TOPICS_DEFAULT_WIDTH);
    expect(result.current.topicsCollapsed).toBe(false);
    expect(result.current.messagesWidth).toBe(MESSAGES_DEFAULT_WIDTH);
    expect(result.current.messagesCollapsed).toBe(false);
  });

  it('loads persisted state from localStorage', () => {
    savePanelLayout({ topicsWidth: 160, topicsCollapsed: true, messagesWidth: 250, messagesCollapsed: false });
    const { result } = renderHook(() => useGroupProjectPanelLayout());
    expect(result.current.topicsWidth).toBe(160);
    expect(result.current.topicsCollapsed).toBe(true);
    expect(result.current.messagesWidth).toBe(250);
  });

  it('resizeTopics increases topics width', () => {
    const { result } = renderHook(() => useGroupProjectPanelLayout());
    act(() => { result.current.resizeTopics(20); });
    expect(result.current.topicsWidth).toBe(TOPICS_DEFAULT_WIDTH + 20);
  });

  it('resizeTopics clamps to TOPICS_MIN_WIDTH', () => {
    const { result } = renderHook(() => useGroupProjectPanelLayout());
    act(() => { result.current.resizeTopics(-9999); });
    expect(result.current.topicsWidth).toBe(TOPICS_MIN_WIDTH);
  });

  it('resizeTopics clamps to TOPICS_MAX_WIDTH', () => {
    const { result } = renderHook(() => useGroupProjectPanelLayout());
    act(() => { result.current.resizeTopics(9999); });
    expect(result.current.topicsWidth).toBe(TOPICS_MAX_WIDTH);
  });

  it('toggleTopicsCollapse flips topicsCollapsed', () => {
    const { result } = renderHook(() => useGroupProjectPanelLayout());
    expect(result.current.topicsCollapsed).toBe(false);
    act(() => { result.current.toggleTopicsCollapse(); });
    expect(result.current.topicsCollapsed).toBe(true);
    act(() => { result.current.toggleTopicsCollapse(); });
    expect(result.current.topicsCollapsed).toBe(false);
  });

  it('resizeMessages increases messages width', () => {
    const { result } = renderHook(() => useGroupProjectPanelLayout());
    act(() => { result.current.resizeMessages(30); });
    expect(result.current.messagesWidth).toBe(MESSAGES_DEFAULT_WIDTH + 30);
  });

  it('resizeMessages clamps to MESSAGES_MIN_WIDTH', () => {
    const { result } = renderHook(() => useGroupProjectPanelLayout());
    act(() => { result.current.resizeMessages(-9999); });
    expect(result.current.messagesWidth).toBe(MESSAGES_MIN_WIDTH);
  });

  it('resizeMessages clamps to MESSAGES_MAX_WIDTH', () => {
    const { result } = renderHook(() => useGroupProjectPanelLayout());
    act(() => { result.current.resizeMessages(9999); });
    expect(result.current.messagesWidth).toBe(MESSAGES_MAX_WIDTH);
  });

  it('toggleMessagesCollapse flips messagesCollapsed', () => {
    const { result } = renderHook(() => useGroupProjectPanelLayout());
    expect(result.current.messagesCollapsed).toBe(false);
    act(() => { result.current.toggleMessagesCollapse(); });
    expect(result.current.messagesCollapsed).toBe(true);
  });

  it('saves layout to localStorage after debounce', () => {
    const { result } = renderHook(() => useGroupProjectPanelLayout());
    act(() => { result.current.resizeTopics(50); });
    // Not yet saved (debounced) — setItem not called yet
    expect(vi.mocked(localStorage.setItem)).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(350); });
    const saved = loadPanelLayout();
    expect(saved.topicsWidth).toBe(TOPICS_DEFAULT_WIDTH + 50);
  });

  it('handles corrupt localStorage gracefully', () => {
    localStorage.setItem('clubhouse_group_project_panel_layout', 'not-valid-json{{{');
    const layout = loadPanelLayout();
    expect(layout.topicsWidth).toBe(TOPICS_DEFAULT_WIDTH);
    expect(layout.topicsCollapsed).toBe(false);
    expect(layout.messagesWidth).toBe(MESSAGES_DEFAULT_WIDTH);
    expect(layout.messagesCollapsed).toBe(false);
  });
});
