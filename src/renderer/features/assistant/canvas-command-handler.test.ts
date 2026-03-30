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
  getKnownProjectIds: () => Array.from(projectStores.keys()),
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

async function sendCommand(command: string, args: Record<string, unknown> = {}): Promise<any> {
  const callId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await commandHandler!({ callId, command, args });
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

  it('add_canvas creates a canvas and returns its ID', async () => {
    const result = await sendCommand('add_canvas', {});
    expect(result).toEqual({ success: true, data: expect.objectContaining({ canvas_id: expect.stringContaining('canvas_') }) });
    expect(mockCanvases).toHaveLength(1);
  });

  it('add_canvas with name renames the canvas', async () => {
    const result = await sendCommand('add_canvas', { name: 'My Canvas' });
    expect(result.success).toBe(true);
    expect(appStoreState.renameCanvas).toHaveBeenCalledWith(expect.stringContaining('canvas_'), 'My Canvas');
  });

  it('add_canvas awaits persistence before returning', async () => {
    await sendCommand('add_canvas', {});
    // persistCanvas calls saveCanvas + saveWires — should be called before result is sent
    expect(appStoreState.saveCanvas).toHaveBeenCalled();
    expect(appStoreState.saveWires).toHaveBeenCalled();
  });

  // ── list_canvases ───────────────────────────────────────────────────────

  it('list_canvases returns empty array when no canvases exist', async () => {
    const result = await sendCommand('list_canvases', {});
    expect(result).toEqual({ success: true, data: [] });
  });

  it('list_canvases returns canvas info after creation', async () => {
    await sendCommand('add_canvas', { name: 'Test' });
    const result = await sendCommand('list_canvases', {});
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual(expect.objectContaining({ name: expect.any(String), cardCount: 0 }));
  });

  // ── add_view ────────────────────────────────────────────────────────────

  it('add_view adds a card to an existing canvas', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    const result = await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ view_id: expect.stringContaining('view_'), canvas_id: canvasId }));
  });

  it('add_view response includes canvas_id', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    const result = await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    expect(result.data.canvas_id).toBe(canvasId);
  });

  it('add_view fails when canvas does not exist', async () => {
    const result = await sendCommand('add_view', { canvas_id: 'nonexistent', type: 'agent' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Canvas not found');
  });

  // ── withCanvas app store fallback (P0 fix) ──────────────────────────────

  it('add_view finds app-level canvas when project_id is provided', async () => {
    // Create canvas at app level (no project_id)
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;

    // Add card with project_id (for agent binding) — should still find the app-level canvas
    const result = await sendCommand('add_view', {
      canvas_id: canvasId,
      type: 'agent',
      project_id: 'some-project-id',
    });
    expect(result.success).toBe(true);
    expect(result.data.view_id).toBeTruthy();
  });

  // ── move_view / resize_view / remove_view / rename_view response data ──

  it('move_view response includes canvas_id and view_id', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    const result = await sendCommand('move_view', { canvas_id: canvasId, view_id: 'view_1', position: { x: 50, y: 50 } });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ canvas_id: canvasId, view_id: 'view_1' });
  });

  it('resize_view response includes canvas_id and view_id', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    const result = await sendCommand('resize_view', { canvas_id: canvasId, view_id: 'view_1', size: { w: 400, h: 300 } });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ canvas_id: canvasId, view_id: 'view_1' });
  });

  it('remove_view response includes canvas_id and view_id', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    const addResult = await sendCommand('add_view', { canvas_id: canvasId, type: 'anchor' });
    const viewId = addResult.data.view_id;
    const result = await sendCommand('remove_view', { canvas_id: canvasId, view_id: viewId });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ canvas_id: canvasId, view_id: viewId });
  });

  it('remove_view fails on nonexistent canvas', async () => {
    const result = await sendCommand('remove_view', { canvas_id: 'bad', view_id: 'v1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Canvas not found');
  });

  // ── rename_view ─────────────────────────────────────────────────────────

  it('rename_view renames a card and returns canvas_id', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    await sendCommand('add_view', { canvas_id: canvasId, type: 'anchor' });

    const result = await sendCommand('rename_view', { canvas_id: canvasId, view_id: 'view_1', name: 'New Name' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ canvas_id: canvasId, view_id: 'view_1' });
  });

  // ── find_canvas_for_view ────────────────────────────────────────────────

  it('find_canvas_for_view finds canvas by view_id in app store', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    const addResult = await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    const viewId = addResult.data.view_id;

    const result = await sendCommand('find_canvas_for_view', { view_id: viewId });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ canvas_id: canvasId, project_id: null });
  });

  it('find_canvas_for_view returns error for unknown view', async () => {
    const result = await sendCommand('find_canvas_for_view', { view_id: 'nonexistent_view' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No canvas contains view');
  });

  it('find_canvas_for_view requires view_id', async () => {
    const result = await sendCommand('find_canvas_for_view', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('view_id is required');
  });

  it('find_canvas_for_view finds correct canvas with multiple canvases', async () => {
    const c1 = await sendCommand('add_canvas', { name: 'A' });
    const c2 = await sendCommand('add_canvas', { name: 'B' });
    await sendCommand('add_view', { canvas_id: c1.data.canvas_id, type: 'agent' });
    const addResult = await sendCommand('add_view', { canvas_id: c2.data.canvas_id, type: 'anchor' });
    const viewId = addResult.data.view_id;

    const result = await sendCommand('find_canvas_for_view', { view_id: viewId });
    expect(result.success).toBe(true);
    expect(result.data.canvas_id).toBe(c2.data.canvas_id);
  });

  // ── query_views ─────────────────────────────────────────────────────────

  it('query_views returns views in a canvas', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    await sendCommand('add_view', { canvas_id: canvasId, type: 'anchor' });

    const result = await sendCommand('query_views', { canvas_id: canvasId });
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('query_views fails on nonexistent canvas', async () => {
    const result = await sendCommand('query_views', { canvas_id: 'nope' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Canvas not found');
  });

  // ── connect_views ───────────────────────────────────────────────────────

  it('connect_views fails when source has no agent assigned', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });

    const result = await sendCommand('connect_views', {
      canvas_id: canvasId,
      source_view_id: 'view_1',
      target_view_id: 'view_2',
    });
    // Should fail because source has no agentId bound
    expect(result.success).toBe(false);
    expect(result.error).toContain('no agent assigned');
  });

  it('connect_views response includes canvas_id', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });

    const canvas = mockCanvases.find(c => c.id === canvasId);
    canvas!.views[0].agentId = 'agent_A';
    canvas!.views[0].displayName = 'Agent A';
    canvas!.views[1].agentId = 'agent_B';
    canvas!.views[1].displayName = 'Agent B';

    const result = await sendCommand('connect_views', {
      canvas_id: canvasId,
      source_view_id: 'view_1',
      target_view_id: 'view_2',
    });
    expect(result.success).toBe(true);
    expect(result.data.canvas_id).toBe(canvasId);
  });

  it('connect_views creates bidirectional wires by default for agent-to-agent', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });

    // Set agentIds on the views
    const canvas = mockCanvases.find(c => c.id === canvasId);
    canvas!.views[0].agentId = 'agent_A';
    canvas!.views[0].displayName = 'Agent A';
    canvas!.views[1].agentId = 'agent_B';
    canvas!.views[1].displayName = 'Agent B';

    const result = await sendCommand('connect_views', {
      canvas_id: canvasId,
      source_view_id: 'view_1',
      target_view_id: 'view_2',
    });
    expect(result.success).toBe(true);
    expect(result.data.bidirectional).toBe(true);
    expect(result.data.reverseBindingCreated).toBe(true);
    // Forward wire: agent_A → agent_B
    expect(appStoreState.addWireDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_A', targetId: 'agent_B' }),
    );
    // Reverse wire: agent_B → agent_A
    expect(appStoreState.addWireDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_B', targetId: 'agent_A' }),
    );
    // Both MCP bindings attempted
    expect(mockBind).toHaveBeenCalledTimes(2);
  });

  it('connect_views creates unidirectional wire when bidirectional=false', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });

    const canvas = mockCanvases.find(c => c.id === canvasId);
    canvas!.views[0].agentId = 'agent_A';
    canvas!.views[0].displayName = 'Agent A';
    canvas!.views[1].agentId = 'agent_B';
    canvas!.views[1].displayName = 'Agent B';

    const result = await sendCommand('connect_views', {
      canvas_id: canvasId,
      source_view_id: 'view_1',
      target_view_id: 'view_2',
      bidirectional: false,
    });
    expect(result.success).toBe(true);
    expect(result.data.bidirectional).toBe(false);
    // Only forward wire
    expect(appStoreState.addWireDefinition).toHaveBeenCalledTimes(1);
    expect(mockBind).toHaveBeenCalledTimes(1);
  });

  it('connect_views defaults to unidirectional for non-agent targets', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    await sendCommand('add_view', { canvas_id: canvasId, type: 'zone' });

    const canvas = mockCanvases.find(c => c.id === canvasId);
    canvas!.views[0].agentId = 'agent_A';
    canvas!.views[0].displayName = 'Agent A';

    const result = await sendCommand('connect_views', {
      canvas_id: canvasId,
      source_view_id: 'view_1',
      target_view_id: 'view_2',
    });
    expect(result.success).toBe(true);
    expect(result.data.bidirectional).toBe(false);
    // Only forward wire, no reverse
    expect(appStoreState.addWireDefinition).toHaveBeenCalledTimes(1);
    expect(mockBind).toHaveBeenCalledTimes(1);
  });

  it('connect_views allows forcing bidirectional=true even for non-agent targets', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    await sendCommand('add_view', { canvas_id: canvasId, type: 'agent' });
    await sendCommand('add_view', { canvas_id: canvasId, type: 'zone' });

    const canvas = mockCanvases.find(c => c.id === canvasId);
    canvas!.views[0].agentId = 'agent_A';
    canvas!.views[0].displayName = 'Agent A';

    const result = await sendCommand('connect_views', {
      canvas_id: canvasId,
      source_view_id: 'view_1',
      target_view_id: 'view_2',
      bidirectional: true,
    });
    expect(result.success).toBe(true);
    // bidirectional=true but target is not agent, so no reverse binding created
    expect(result.data.bidirectional).toBe(true);
    // Reverse only created for agent-to-agent
    expect(appStoreState.addWireDefinition).toHaveBeenCalledTimes(1);
    expect(mockBind).toHaveBeenCalledTimes(1);
  });

  // ── Unknown command ─────────────────────────────────────────────────────

  it('returns error for unknown command', async () => {
    const result = await sendCommand('nonexistent_command', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown canvas command');
  });

  // ── findCanvas fallback ─────────────────────────────────────────────────

  it('query_views finds app-level canvas when project_id is given', async () => {
    const createResult = await sendCommand('add_canvas', {});
    const canvasId = createResult.data.canvas_id;
    await sendCommand('add_view', { canvas_id: canvasId, type: 'anchor' });

    // Query with project_id — should fall back to app store
    const result = await sendCommand('query_views', { canvas_id: canvasId, project_id: 'proj_123' });
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
  });

  // ── Multiple canvases ───────────────────────────────────────────────────

  it('handles multiple canvases independently', async () => {
    const c1 = await sendCommand('add_canvas', { name: 'Canvas A' });
    const c2 = await sendCommand('add_canvas', { name: 'Canvas B' });

    await sendCommand('add_view', { canvas_id: c1.data.canvas_id, type: 'agent' });
    await sendCommand('add_view', { canvas_id: c2.data.canvas_id, type: 'anchor' });
    await sendCommand('add_view', { canvas_id: c2.data.canvas_id, type: 'anchor' });

    const q1 = await sendCommand('query_views', { canvas_id: c1.data.canvas_id });
    const q2 = await sendCommand('query_views', { canvas_id: c2.data.canvas_id });
    expect(q1.data).toHaveLength(1);
    expect(q2.data).toHaveLength(2);
  });
});
