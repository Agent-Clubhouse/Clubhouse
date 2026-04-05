import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BlueprintGallery } from './BlueprintGallery';

// Use ref object so mutation is visible inside mock closures
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
    id: 'canvas_1',
    name: 'Imported',
    views: [],
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nextZIndex: 0,
    zoomedViewId: null,
    selectedViewId: null,
    minimapAutoHide: true,
    elkAlgorithm: 'layered',
    elkDirection: 'RIGHT',
    layoutCenterId: null,
  })),
  validateBlueprint: vi.fn(() => null),
}));

const mockInsertCanvas = vi.fn();
vi.mock('../../plugins/builtin/canvas/main', () => ({
  getProjectCanvasStore: () => ({
    getState: () => ({ insertCanvas: mockInsertCanvas }),
  }),
  useAppCanvasStore: {
    getState: () => ({ insertCanvas: mockInsertCanvas }),
  },
}));

// Mock window.clubhouse.blueprint
const mockBlueprintList = vi.fn();
const mockBlueprintRead = vi.fn();

beforeEach(() => {
  (globalThis as any).window ??= {};
  (globalThis as any).window.clubhouse = {
    blueprint: {
      list: mockBlueprintList,
      read: mockBlueprintRead,
    },
  };
});

describe('BlueprintGallery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.blueprintGalleryOpen = false;
  });

  it('renders nothing when closed', () => {
    state.blueprintGalleryOpen = false;
    const { container } = render(<BlueprintGallery />);
    expect(container.innerHTML).toBe('');
  });

  it('renders gallery overlay when open', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([]);

    render(<BlueprintGallery />);
    expect(screen.getByTestId('blueprint-gallery-overlay')).toBeDefined();
    expect(screen.getByText('Import Blueprint')).toBeDefined();
  });

  it('displays blueprint cards after loading', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([
      {
        filePath: '/tmp/.clubhouse/blueprints/squad.json',
        name: 'Squad Setup',
        description: 'A team of agents',
        viewCount: 3,
        agentCount: 2,
        wireCount: 1,
        version: 1,
        source: 'My Project',
      },
      {
        filePath: '/tmp/.clubhouse/blueprints/solo.json',
        name: 'Solo Agent',
        viewCount: 1,
        agentCount: 1,
        wireCount: 0,
        version: 1,
        source: 'Other Project',
      },
    ]);

    render(<BlueprintGallery />);
    await waitFor(() => {
      expect(screen.getByText('Squad Setup')).toBeDefined();
    });
    expect(screen.getByText('Solo Agent')).toBeDefined();
    expect(screen.getByText('A team of agents')).toBeDefined();
    expect(screen.getByText('My Project')).toBeDefined();
  });

  it('filters blueprints by search text', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([
      { filePath: '/a.json', name: 'Squad', viewCount: 3, agentCount: 2, wireCount: 0, version: 1, source: 'A' },
      { filePath: '/b.json', name: 'Solo', viewCount: 1, agentCount: 1, wireCount: 0, version: 1, source: 'B' },
    ]);

    render(<BlueprintGallery />);
    await waitFor(() => {
      expect(screen.getByText('Squad')).toBeDefined();
    });

    const searchInput = screen.getByTestId('blueprint-gallery-search');
    fireEvent.change(searchInput, { target: { value: 'solo' } });

    expect(screen.queryByText('Squad')).toBeNull();
    expect(screen.getByText('Solo')).toBeDefined();
  });

  it('shows empty state when no blueprints found', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([]);

    render(<BlueprintGallery />);
    await waitFor(() => {
      expect(screen.getByText('No blueprints found')).toBeDefined();
    });
  });

  it('imports a blueprint when card is clicked', async () => {
    state.blueprintGalleryOpen = true;
    const blueprintData = { version: 1, name: 'Test BP', views: [] };
    mockBlueprintList.mockResolvedValue([
      { filePath: '/test.json', name: 'Test BP', viewCount: 0, agentCount: 0, wireCount: 0, version: 1, source: 'Proj' },
    ]);
    mockBlueprintRead.mockResolvedValue(blueprintData);

    render(<BlueprintGallery />);
    await waitFor(() => {
      expect(screen.getByText('Test BP')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Test BP'));
    await waitFor(() => {
      expect(mockBlueprintRead).toHaveBeenCalledWith('/test.json');
      expect(mockInsertCanvas).toHaveBeenCalled();
      expect(mockCloseBlueprintGallery).toHaveBeenCalled();
    });
  });

  it('closes on Escape key', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([]);

    render(<BlueprintGallery />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mockCloseBlueprintGallery).toHaveBeenCalled();
  });

  it('shows error when blueprint.read returns null', async () => {
    state.blueprintGalleryOpen = true;
    mockBlueprintList.mockResolvedValue([
      { filePath: '/bad.json', name: 'Bad BP', viewCount: 0, agentCount: 0, wireCount: 0, version: 1, source: 'P' },
    ]);
    mockBlueprintRead.mockResolvedValue(null);

    render(<BlueprintGallery />);
    await waitFor(() => {
      expect(screen.getByText('Bad BP')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Bad BP'));
    await waitFor(() => {
      expect(screen.getByTestId('blueprint-gallery-error')).toBeDefined();
    });
    expect(mockInsertCanvas).not.toHaveBeenCalled();
  });

  it('shows error when validateBlueprint returns error string', async () => {
    state.blueprintGalleryOpen = true;
    const { validateBlueprint } = await import('../../plugins/builtin/canvas/canvas-blueprint');
    vi.mocked(validateBlueprint).mockReturnValueOnce('Invalid blueprint: bad version');

    mockBlueprintList.mockResolvedValue([
      { filePath: '/invalid.json', name: 'Invalid', viewCount: 0, agentCount: 0, wireCount: 0, version: 99, source: 'P' },
    ]);
    mockBlueprintRead.mockResolvedValue({ version: 99, views: [] });

    render(<BlueprintGallery />);
    await waitFor(() => {
      expect(screen.getByText('Invalid')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Invalid'));
    await waitFor(() => {
      expect(screen.getByTestId('blueprint-gallery-error')).toBeDefined();
    });
    expect(mockInsertCanvas).not.toHaveBeenCalled();
  });
});
