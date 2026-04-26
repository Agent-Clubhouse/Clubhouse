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
  useProjectStore: Object.assign(
    (selector: any) => selector({ activeProjectId: 'p1', projects: [{ id: 'p1', name: 'Project', path: '/tmp/proj' }] }),
    { getState: () => ({ projects: [{ id: 'p1', name: 'Project', path: '/tmp/proj' }] }) },
  ),
}));

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: { getState: () => ({ agents: {} }) },
}));

const mockLegacyImport = vi.fn(() => ({
  id: 'canvas_1', name: 'Imported', views: [],
  viewport: { panX: 0, panY: 0, zoom: 1 },
  nextZIndex: 0, zoomedViewId: null, selectedViewId: null,
  minimapAutoHide: true, elkAlgorithm: 'layered', elkDirection: 'RIGHT', layoutCenterId: null,
}));
vi.mock('../../plugins/builtin/canvas/canvas-blueprint', () => ({
  importBlueprint: (...args: any[]) => mockLegacyImport(...args),
  validateBlueprint: vi.fn(() => null),
}));

const mockManifestImport = vi.fn(() => ({
  canvas: {
    id: 'canvas_m', name: 'Manifest Imported', views: [],
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nextZIndex: 0, zoomedViewId: null, selectedViewId: null,
    minimapAutoHide: true, elkAlgorithm: 'layered', elkDirection: 'RIGHT', layoutCenterId: null,
  },
  stubs: [],
  projectMatches: [],
  pendingWires: [],
  refIdToViewId: new Map(),
}));
vi.mock('./blueprint-import', () => ({
  importBlueprint: (...args: any[]) => mockManifestImport(...args),
}));

const mockInsertCanvas = vi.fn();
const mockAddWireDefinition = vi.fn();
vi.mock('../../plugins/builtin/canvas/main', () => ({
  getProjectCanvasStore: () => ({ getState: () => ({ insertCanvas: mockInsertCanvas, addWireDefinition: mockAddWireDefinition }) }),
  useAppCanvasStore: { getState: () => ({ insertCanvas: mockInsertCanvas, addWireDefinition: mockAddWireDefinition }) },
}));

const mockBlueprintList = vi.fn();
const mockBlueprintRead = vi.fn();
const mockBlueprintDelete = vi.fn();
const mockBlueprintOpenAndRead = vi.fn();

beforeEach(() => {
  (globalThis as any).window ??= {};
  (globalThis as any).window.clubhouse = {
    blueprint: {
      list: mockBlueprintList,
      read: mockBlueprintRead,
      delete: mockBlueprintDelete,
      openAndRead: mockBlueprintOpenAndRead,
    },
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

  // ── Manifest-aware import (LB-CRIT-01) ────────────────────────

  it('uses manifest-aware import for BlueprintManifest files', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([makeBp()]);
    mockBlueprintRead.mockResolvedValue({
      schemaVersion: 1,
      id: 'bp-123',
      name: 'Manifest BP',
      version: '1.0.0',
      createdAt: '2026-01-01',
      canvas: { views: [], wires: [] },
      agents: [{ refId: 'a1', name: 'Agent A' }],
    });

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByText('Test BP')).toBeDefined(); });

    fireEvent.dblClick(screen.getByTestId('blueprint-card-Test BP'));
    await waitFor(() => {
      expect(mockManifestImport).toHaveBeenCalled();
      expect(mockInsertCanvas).toHaveBeenCalled();
    });
    // Legacy import should NOT have been called
    expect(mockLegacyImport).not.toHaveBeenCalled();
  });

  it('uses legacy import for non-manifest blueprint files', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([makeBp()]);
    mockBlueprintRead.mockResolvedValue({
      version: 1,
      name: 'Legacy BP',
      views: [{ type: 'agent', position: { x: 0, y: 0 } }],
    });

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByText('Test BP')).toBeDefined(); });

    fireEvent.dblClick(screen.getByTestId('blueprint-card-Test BP'));
    await waitFor(() => {
      expect(mockLegacyImport).toHaveBeenCalled();
      expect(mockInsertCanvas).toHaveBeenCalled();
    });
    // Manifest import should NOT have been called
    expect(mockManifestImport).not.toHaveBeenCalled();
  });

  // ── Open from file (arbitrary path, bypasses sandbox) ──────────

  it('renders an "Open from file…" button in the header', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([]);
    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByTestId('blueprint-gallery-open-from-file')).toBeDefined(); });
  });

  it('imports a manifest blueprint chosen via the OS file picker', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([]);
    mockBlueprintOpenAndRead.mockResolvedValue({
      canceled: false,
      filePath: '/Users/me/Downloads/squad.json',
      data: {
        schemaVersion: 1,
        id: 'bp-import-1',
        name: 'Manifest from disk',
        version: '1.0.0',
        createdAt: '2026-04-25',
        canvas: { views: [], wires: [] },
      },
    });

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByTestId('blueprint-gallery-open-from-file')).toBeDefined(); });

    fireEvent.click(screen.getByTestId('blueprint-gallery-open-from-file'));

    await waitFor(() => {
      expect(mockBlueprintOpenAndRead).toHaveBeenCalled();
      expect(mockManifestImport).toHaveBeenCalled();
      expect(mockInsertCanvas).toHaveBeenCalled();
    });
  });

  it('imports a legacy blueprint chosen via the OS file picker', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([]);
    mockBlueprintOpenAndRead.mockResolvedValue({
      canceled: false,
      filePath: '/elsewhere/legacy.json',
      data: {
        version: 1,
        name: 'Legacy from disk',
        views: [],
      },
    });

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByTestId('blueprint-gallery-open-from-file')).toBeDefined(); });

    fireEvent.click(screen.getByTestId('blueprint-gallery-open-from-file'));

    await waitFor(() => {
      expect(mockLegacyImport).toHaveBeenCalled();
      expect(mockInsertCanvas).toHaveBeenCalled();
    });
  });

  it('does nothing visible when the user cancels the file picker', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([]);
    mockBlueprintOpenAndRead.mockResolvedValue({ canceled: true });

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByTestId('blueprint-gallery-open-from-file')).toBeDefined(); });

    fireEvent.click(screen.getByTestId('blueprint-gallery-open-from-file'));

    await waitFor(() => {
      expect(mockBlueprintOpenAndRead).toHaveBeenCalled();
    });
    expect(mockInsertCanvas).not.toHaveBeenCalled();
    expect(mockCloseBlueprintGallery).not.toHaveBeenCalled();
  });

  it('shows an error when the chosen file is unreadable', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([]);
    mockBlueprintOpenAndRead.mockResolvedValue({
      canceled: false,
      filePath: '/tmp/broken.json',
      error: 'Unexpected token in JSON',
    });

    render(<BlueprintGallery />);
    await waitFor(() => { expect(screen.getByTestId('blueprint-gallery-open-from-file')).toBeDefined(); });

    fireEvent.click(screen.getByTestId('blueprint-gallery-open-from-file'));

    await waitFor(() => {
      expect(screen.getByTestId('blueprint-gallery-error')).toBeDefined();
    });
    expect(screen.getByText(/Unexpected token/)).toBeDefined();
  });
});
