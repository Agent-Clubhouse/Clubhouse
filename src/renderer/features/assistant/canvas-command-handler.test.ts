import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock canvas store ──────────────────────────────────────────────────────

const mockCanvases: Array<{ id: string; name: string; views: any[] }> = [];
let mockActiveCanvasId: string | null = null;
let mockViewIdCounter = 0;
const mockWireDefinitions: any[] = [];

const mockStoreState = () => ({
  canvases: mockCanvases,
  activeCanvasId: mockActiveCanvasId,
  loaded: true,
  addCanvas: vi.fn(() => {
    const id = `canvas_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const canvas = { id, name: `Canvas ${mockCanvases.length + 1}`, views: [] };
    mockCanvases.push(canvas);
    mockActiveCanvasId = id;
    return id;
  }),
  insertCanvas: vi.fn((canvas: any) => {
    mockCanvases.push(canvas);
    mockActiveCanvasId = canvas.id;
  }),
  renameCanvas: vi.fn((id: string, name: string) => {
    const c = mockCanvases.find(c => c.id === id);
    if (c) c.name = name;
  }),
  setActiveCanvas: vi.fn((id: string) => { mockActiveCanvasId = id; }),
  addView: vi.fn((type: string, position: any) => {
    const viewId = `view_${++mockViewIdCounter}`;
    const active = mockCanvases.find(c => c.id === mockActiveCanvasId);
    if (active) {
      active.views.push({ id: viewId, type, position, displayName: '', title: '', size: { width: 300, height: 200 }, metadata: {} });
    }
    return viewId;
  }),
  renameView: vi.fn((viewId: string, name: string) => {
    for (const c of mockCanvases) {
      const v = c.views.find((v: any) => v.id === viewId);
      if (v) { v.displayName = name; v.title = name; }
    }
  }),
  resizeView: vi.fn(),
  moveView: vi.fn(),
  removeView: vi.fn((viewId: string) => {
    for (const c of mockCanvases) {
      c.views = c.views.filter((v: any) => v.id !== viewId);
    }
  }),
  updateView: vi.fn(),
  addWireDefinition: vi.fn((def: any) => { mockWireDefinitions.push(def); }),
  saveCanvas: vi.fn().mockResolvedValue(undefined),
  saveWires: vi.fn().mockResolvedValue(undefined),
  loadCanvas: vi.fn().mockResolvedValue(undefined),
});

// Separate app store and project stores
const appStoreState = mockStoreState();
const projectStores = new Map<string, ReturnType<typeof mockStoreState>>();

vi.mock('../../plugins/builtin/canvas/main', () => ({
  useAppCanvasStore: { getState: () => appStoreState },
  getProjectCanvasStore: (pid: string) => {
    if (!projectStores.has(pid)) {
      projectStores.set(pid, mockStoreState());
    }
    return { getState: () => projectStores.get(pid)! };
  },
}));

vi.mock('../../plugins/builtin/canvas/canvas-blueprint', () => ({
  exportBlueprint: vi.fn((canvas: any) => ({ name: canvas.name, views: canvas.views })),
  importBlueprint: vi.fn((bp: any, opts: any) => ({
    id: `canvas_imported_${Date.now()}`,
    name: opts?.name || bp.name || 'Imported',
    views: bp.views || [],
  })),
  validateBlueprint: vi.fn(() => null),
}));

vi.mock('../../plugins/plugin-api-storage', () => ({
  createScopedStorage: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  })),
}));

// Mock window.clubhouse
const mockSendCommandResult = vi.fn();
const mockBind = vi.fn();
let commandHandler: ((req: any) => void) | null = null;

vi.stubGlobal('window', {
  clubhouse: {
    canvas: {
      sendCommandResult: mockSendCommandResult,
      onCommand: (handler: (req: any) => void) => {
        commandHandler = handler;
        return () => { commandHandler = null; };
      },
    },
    mcpBinding: {
      bind: mockBind,
    },
  },
});

// Import after mocks
import { initCanvasCommandHandler } from './canvas-command-handler';

// ── Helper to send a command and get result ────────────────────────────────

function sendCommand(command: string, args: Record<string, unknown> = {}): any {
  const callId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  commandHandler!({ callId, command, args });
  const call = mockSendCommandResult.mock.calls.find(c => c[0] === callId);
  return call ? call[1] : null;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('canvas-command-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvases.length = 0;
    mockActiveCanvasId = null;
    mockViewIdCounter = 0;
    mockWireDefinitions.length = 0;
    projectStores.clear();
    // Re-wire mock implementations after clearAllMocks
    appStoreState.addCanvas.mockImplementation(() => {
      const id = `canvas_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const canvas = { id, name: `Canvas ${mockCanvases.length + 1}`, views: [] };
      mockCanvases.push(canvas);
      mockActiveCanvasId = id;
      return id;
    });
    appStoreState.addView.mockImplementation((type: string, position: any) => {
      const viewId = `view_${++mockViewIdCounter}`;
      const active = mockCanvases.find(c => c.id === mockActiveCanvasId);
      if (active) {
        active.views.push({ id: viewId, type, position, displayName: '', title: '', size: { width: 300, height: 200 }, metadata: {} });
      }
      return viewId;
    });
    appStoreState.saveCanvas.mockResolvedValue(undefined);
    appStoreState.saveWires.mockResolvedValue(undefined);
    // Init handler
    initCanvasCommandHandler();
  });

  // ── add_canvas ──────────────────────────────────────────────────────────

  it('add_canvas creates a canvas and returns its ID', () => {
    const result = sendCommand('add_canvas', {});
    expect(result).toEqual({ success: true, data: expect.objectContaining({ canvas_id: expect.stringContaining('canvas_') }) });
    expect(mockCanvases).toHaveLength(1);
  });

  it('add_canvas with name renames the canvas', () => {
    const result = sendCommand('add_canvas', { name: 'My Canvas' });
    expect(result.success).toBe(true);
    expect(appStoreState.renameCanvas).toHaveBeenCalledWith(expect.stringContaining('canvas_'), 'My Canvas');
  });

  // ── list_canvases ───────────────────────────────────────────────────────

  it('list_canvases returns empty array when no canvases exist', () => {
    const result = sendCommand('list_canvases', {});
    expect(result).toEqual({ success: true, data: [] });
  });

  it('list_canvases returns canvas info after creation', () => {
    sendCommand('add_canvas', { name: 'Test' });
    const result = sendCommand('list_canvases', {});
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual(expect.objectContaining({ name: expect.any(String), cardCount: 0 }));
  });

  // ── add_view ────────────────────────────────────────────────────────────

  it('add_view adds a card to an existing canvas', () => {
    const createResult = sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    const result = sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ view_id: expect.stringContaining('view_') }));
  });

  it('add_view fails when canvas does not exist', () => {
    const result = sendCommand('add_view', { canvas_id: 'nonexistent', type: 'agent' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Canvas not found');
  });

  // ── withCanvas app store fallback (P0 fix) ──────────────────────────────

  it('add_view finds app-level canvas when project_id is provided', () => {
    // Create canvas at app level (no project_id)
    const createResult = sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;

    // Add card with project_id (for agent binding) — should still find the app-level canvas
    const result = sendCommand('add_view', {
      canvas_id: canvasId,
      type: 'agent',
      project_id: 'some-project-id',
    });
    expect(result.success).toBe(true);
    expect(result.data.view_id).toBeTruthy();
  });

  // ── remove_view ─────────────────────────────────────────────────────────

  it('remove_view removes a card from canvas', () => {
    const createResult = sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    const addResult = sendCommand('add_view', { canvas_id: canvasId, type: 'anchor' });
    const viewId = addResult.data.view_id;

    const result = sendCommand('remove_view', { canvas_id: canvasId, view_id: viewId });
    expect(result.success).toBe(true);
  });

  it('remove_view fails on nonexistent canvas', () => {
    const result = sendCommand('remove_view', { canvas_id: 'bad', view_id: 'v1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Canvas not found');
  });

  // ── rename_view ─────────────────────────────────────────────────────────

  it('rename_view renames a card', () => {
    const createResult = sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    sendCommand('add_view', { canvas_id: canvasId, type: 'anchor' });

    const result = sendCommand('rename_view', { canvas_id: canvasId, view_id: 'view_1', name: 'New Name' });
    expect(result.success).toBe(true);
  });

  // ── query_views ─────────────────────────────────────────────────────────

  it('query_views returns views in a canvas', () => {
    const createResult = sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    sendCommand('add_view', { canvas_id: canvasId, type: 'anchor' });

    const result = sendCommand('query_views', { canvas_id: canvasId });
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('query_views fails on nonexistent canvas', () => {
    const result = sendCommand('query_views', { canvas_id: 'nope' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Canvas not found');
  });

  // ── connect_views ───────────────────────────────────────────────────────

  it('connect_views fails when source has no agent assigned', () => {
    const createResult = sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });

    const result = sendCommand('connect_views', {
      canvas_id: canvasId,
      source_view_id: 'view_1',
      target_view_id: 'view_2',
    });
    // Should fail because source has no agentId bound
    expect(result.success).toBe(false);
    expect(result.error).toContain('no agent assigned');
  });

  // ── Unknown command ─────────────────────────────────────────────────────

  it('returns error for unknown command', () => {
    const result = sendCommand('nonexistent_command', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown canvas command');
  });

  // ── findCanvas fallback ─────────────────────────────────────────────────

  it('query_views finds app-level canvas when project_id is given', () => {
    const createResult = sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    sendCommand('add_view', { canvas_id: canvasId, type: 'anchor' });

    // Query with project_id — should fall back to app store
    const result = sendCommand('query_views', { canvas_id: canvasId, project_id: 'proj_123' });
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
  });

  // ── Multiple canvases ───────────────────────────────────────────────────

  it('handles multiple canvases independently', () => {
    const c1 = sendCommand('add_canvas', { name: 'Canvas A' });
    const c2 = sendCommand('add_canvas', { name: 'Canvas B' });

    sendCommand('add_view', { canvas_id: c1.data.canvas_id, type: 'agent' });
    sendCommand('add_view', { canvas_id: c2.data.canvas_id, type: 'anchor' });
    sendCommand('add_view', { canvas_id: c2.data.canvas_id, type: 'anchor' });

    const q1 = sendCommand('query_views', { canvas_id: c1.data.canvas_id });
    const q2 = sendCommand('query_views', { canvas_id: c2.data.canvas_id });
    expect(q1.data).toHaveLength(1);
    expect(q2.data).toHaveLength(2);
  });
});
