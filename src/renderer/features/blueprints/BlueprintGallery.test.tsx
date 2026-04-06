import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BlueprintGallery } from './BlueprintGallery';

const state = { blueprintGalleryOpen: false };
const mockCloseBlueprintGallery = vi.fn();

vi.mock('../../stores/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: any) => selector({
      get blueprintGalleryOpen() { return state.blueprintGalleryOpen; },
      closeBlueprintGallery: mockCloseBlueprintGallery,
    }),
    { getState: () => ({ closeBlueprintGallery: mockCloseBlueprintGallery }) },
  ),
}));

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector: any) => selector({ activeProjectId: 'p1' }),
}));

vi.mock('../../plugins/builtin/canvas/canvas-blueprint', () => ({
  importBlueprint: vi.fn(() => ({
    id: 'canvas_1', name: 'Imported', views: [],
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nextZIndex: 0, zoomedViewId: null, selectedViewId: null,
    minimapAutoHide: true, elkAlgorithm: 'layered', elkDirection: 'RIGHT', layoutCenterId: null,
  })),
  validateBlueprint: vi.fn(() => null),
}));

const mockInsertCanvas = vi.fn();
vi.mock('../../plugins/builtin/canvas/main', () => ({
  getProjectCanvasStore: () => ({ getState: () => ({ insertCanvas: mockInsertCanvas }) }),
  useAppCanvasStore: { getState: () => ({ insertCanvas: mockInsertCanvas }) },
}));

const mockBlueprintList = vi.fn();
const mockBlueprintRead = vi.fn();
const mockBlueprintDelete = vi.fn();

beforeEach(() => {
  (globalThis as any).window ??= {};
  (globalThis as any).window.clubhouse = {
    blueprint: { list: mockBlueprintList, read: mockBlueprintRead, delete: mockBlueprintDelete },
  };
});

function makeBp(overrides: Partial<any> = {}) {
  return {
    filePath: '/tmp/bp.json', name: 'Test BP', viewCount: 3, agentCount: 2,
    wireCount: 1, version: 1, source: 'My Project', agentNames: ['Alpha', 'Beta'],
    ...overrides,
  };
}

describe('BlueprintGallery', () => {
  beforeEach(() => { vi.clearAllMocks(); state.blueprintGalleryOpen = false; });

  it('renders nothing when closed', () => {
    const { container } = render(<BlueprintGallery />);
    expect(container.innerHTML).toBe('');
  });

  it('renders gallery when open', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([]);
    render(<BlueprintGallery />);
    expect(screen.getByTestId('blueprint-gallery-overlay')).toBeDefined();
  });

  // ── Search ──────────────────────────────────────────────────────

  it('fuzzy searches across name, description, and agent names', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([
      makeBp({ filePath: '/a.json', name: 'Squad Setup', agentNames: ['Researcher'] }),
      makeBp({ filePath: '/b.json', name: 'Solo', description: 'single agent', agentNames: ['Writer'] }),
    ]);

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByText('Squad Setup')).toBeDefined(); });

    // Search by agent name
    fireEvent.change(screen.getByTestId('blueprint-gallery-search'), { target: { value: 'researcher' } });
    expect(screen.getByText('Squad Setup')).toBeDefined();
    expect(screen.queryByText('Solo')).toBeNull();

    // Search by description
    fireEvent.change(screen.getByTestId('blueprint-gallery-search'), { target: { value: 'single agent' } });
    expect(screen.queryByText('Squad Setup')).toBeNull();
    expect(screen.getByText('Solo')).toBeDefined();
  });

  it('token-based fuzzy search matches multiple tokens', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([
      makeBp({ filePath: '/a.json', name: 'Team Alpha Blueprint', agentNames: [] }),
    ]);

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByText('Team Alpha Blueprint')).toBeDefined(); });

    fireEvent.change(screen.getByTestId('blueprint-gallery-search'), { target: { value: 'team alpha' } });
    expect(screen.getByText('Team Alpha Blueprint')).toBeDefined();
  });

  // ── Sort ────────────────────────────────────────────────────────

  it('sorts by name (default), then by view count', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([
      makeBp({ filePath: '/c.json', name: 'Charlie', viewCount: 1, agentNames: [] }),
      makeBp({ filePath: '/a.json', name: 'Alpha', viewCount: 5, agentNames: [] }),
      makeBp({ filePath: '/b.json', name: 'Bravo', viewCount: 3, agentNames: [] }),
    ]);

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByText('Alpha')).toBeDefined(); });

    const grid = screen.getByTestId('blueprint-gallery-grid');
    const cards = grid.querySelectorAll('[data-testid^="blueprint-card-"]');
    // Default sort by name
    expect(cards[0].textContent).toContain('Alpha');
    expect(cards[1].textContent).toContain('Bravo');
    expect(cards[2].textContent).toContain('Charlie');

    // Sort by views
    fireEvent.change(screen.getByTestId('blueprint-gallery-sort'), { target: { value: 'views' } });
    const sorted = grid.querySelectorAll('[data-testid^="blueprint-card-"]');
    expect(sorted[0].textContent).toContain('Alpha'); // 5 views
    expect(sorted[2].textContent).toContain('Charlie'); // 1 view
  });

  // ── Preview panel ──────────────────────────────────────────────

  it('shows preview panel when card is selected', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([makeBp({ agentNames: ['Agent A', 'Agent B'] })]);
    mockBlueprintRead.mockResolvedValue({
      version: 1, name: 'Test BP',
      views: [
        { type: 'agent', title: 'Agent A', position: { x: 0, y: 0 }, size: { width: 200, height: 100 } },
        { type: 'agent', title: 'Agent B', position: { x: 300, y: 0 }, size: { width: 200, height: 100 } },
      ],
    });

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByText('Test BP')).toBeDefined(); });

    fireEvent.click(screen.getByTestId('blueprint-card-Test BP'));

    await waitFor(() => {
      expect(screen.getByTestId('blueprint-preview-panel')).toBeDefined();
    });
    expect(screen.getByTestId('blueprint-preview-import')).toBeDefined();
    expect(screen.getByTestId('blueprint-mini-layout')).toBeDefined();
  });

  // ── Empty state ────────────────────────────────────────────────

  it('shows helpful empty state with export guidance', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([]);

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByTestId('blueprint-gallery-empty')).toBeDefined(); });
    expect(screen.getByText('No blueprints yet')).toBeDefined();
  });

  it('shows search-specific empty state when no results', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([makeBp()]);

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByText('Test BP')).toBeDefined(); });

    fireEvent.change(screen.getByTestId('blueprint-gallery-search'), { target: { value: 'nonexistent' } });
    expect(screen.getByText('No matching blueprints')).toBeDefined();
  });

  // ── Delete ─────────────────────────────────────────────────────

  it('deletes blueprint after confirmation', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([makeBp()]);
    mockBlueprintDelete.mockResolvedValue(true);

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByText('Test BP')).toBeDefined(); });

    fireEvent.contextMenu(screen.getByTestId('blueprint-card-Test BP'));
    fireEvent.click(screen.getByTestId('blueprint-card-delete'));
    expect(screen.getByTestId('blueprint-delete-confirm')).toBeDefined();

    fireEvent.click(screen.getByTestId('blueprint-delete-confirm-yes'));
    await waitFor(() => { expect(mockBlueprintDelete).toHaveBeenCalledWith('/tmp/bp.json'); });
  });

  // ── Import error paths ─────────────────────────────────────────

  it('shows error when blueprint.read returns null', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([makeBp()]);
    mockBlueprintRead.mockResolvedValue(null);

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByText('Test BP')).toBeDefined(); });

    fireEvent.dblClick(screen.getByTestId('blueprint-card-Test BP'));
    await waitFor(() => { expect(screen.getByTestId('blueprint-gallery-error')).toBeDefined(); });
  });

  it('closes on Escape', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([]);
    render(<BlueprintGallery />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mockCloseBlueprintGallery).toHaveBeenCalled();
  });
});
