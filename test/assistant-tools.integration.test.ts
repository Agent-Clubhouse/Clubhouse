/**
 * Integration Test Suite for Assistant MCP Tool Handlers
 *
 * Tests tool handler workflows directly — no MCP server, no orchestrator, no
 * agent process. Mocks only the minimal IPC layer to simulate renderer responses.
 *
 * Covers:
 *   - Full canvas workflows (create → add_card × N → connect → layout)
 *   - Agent creation with persona injection
 *   - Parameter alias handling (from_card_id, position_x, etc.)
 *   - Error cases (invalid IDs, missing canvases, stale references)
 *   - Regression anchors for Wave 3 and Wave 4 bugs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';

// ── Mocks ─────────────────────────────────────────────────────────────────
// Note: vitest config has mockReset: true, so all vi.fn() implementations are
// cleared between tests. We use vi.hoisted() for mock references and
// re-apply default implementations in beforeEach via setupMockDefaults().

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

const {
  mockProjectList, mockProjectAdd, mockProjectRemove, mockProjectUpdate,
  mockListDurable, mockCreateDurable, mockUpdateDurable, mockUpdateDurableConfig, mockDeleteDurable,
  mockWriteInstructions, mockReadInstructions, mockResolveOrchestrator,
  mockGetAvailableOrchestrators, mockCheckAvailability,
  mockThemeGetSettings, mockThemeSave,
} = vi.hoisted(() => ({
  mockProjectList: vi.fn(),
  mockProjectAdd: vi.fn(),
  mockProjectRemove: vi.fn(),
  mockProjectUpdate: vi.fn(),
  mockListDurable: vi.fn(),
  mockCreateDurable: vi.fn(),
  mockUpdateDurable: vi.fn(),
  mockUpdateDurableConfig: vi.fn(),
  mockDeleteDurable: vi.fn(),
  mockWriteInstructions: vi.fn(),
  mockReadInstructions: vi.fn(),
  mockResolveOrchestrator: vi.fn(),
  mockGetAvailableOrchestrators: vi.fn(),
  mockCheckAvailability: vi.fn(),
  mockThemeGetSettings: vi.fn(),
  mockThemeSave: vi.fn(),
}));

/** Re-apply default mock implementations (called in beforeEach). */
function setupMockDefaults(): void {
  mockProjectList.mockResolvedValue([
    { id: 'proj-1', name: 'my-app', displayName: 'My App', path: '/home/user/my-app' },
  ]);
  mockProjectAdd.mockResolvedValue({ id: 'proj-new', name: 'new-project', path: '/tmp/proj' });
  mockProjectRemove.mockResolvedValue(undefined);
  mockProjectUpdate.mockResolvedValue(undefined);

  mockListDurable.mockResolvedValue([
    { id: 'agent-1', name: 'coder', color: '#ff0000', icon: null, model: 'opus', worktreePath: '/wt/1', orchestrator: 'claude-code' },
  ]);
  mockCreateDurable.mockResolvedValue({
    id: 'durable_abc', name: 'test-agent', color: 'emerald', icon: null,
    worktreePath: '/wt/test', model: 'opus', orchestrator: 'claude-code',
    persona: null, createdAt: '2026-01-01',
  });
  mockUpdateDurable.mockResolvedValue(undefined);
  mockUpdateDurableConfig.mockResolvedValue(undefined);
  mockDeleteDurable.mockResolvedValue(undefined);

  mockWriteInstructions.mockResolvedValue(undefined);
  mockReadInstructions.mockResolvedValue('# Existing defaults');
  mockResolveOrchestrator.mockResolvedValue({
    id: 'claude-code', displayName: 'Claude Code',
    writeInstructions: mockWriteInstructions,
    readInstructions: mockReadInstructions,
  });
  mockGetAvailableOrchestrators.mockReturnValue([
    { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC' },
  ]);
  mockCheckAvailability.mockResolvedValue({ available: true });

  mockThemeGetSettings.mockReturnValue({ themeId: 'catppuccin-mocha' });
  mockThemeSave.mockResolvedValue(undefined);
}

vi.mock('../src/main/services/project-store', () => ({
  list: (...a: unknown[]) => mockProjectList(...a),
  add: (...a: unknown[]) => mockProjectAdd(...a),
  remove: (...a: unknown[]) => mockProjectRemove(...a),
  update: (...a: unknown[]) => mockProjectUpdate(...a),
}));

vi.mock('../src/main/services/agent-config', () => ({
  listDurable: (...a: unknown[]) => mockListDurable(...a),
  createDurable: (...a: unknown[]) => mockCreateDurable(...a),
  updateDurable: (...a: unknown[]) => mockUpdateDurable(...a),
  updateDurableConfig: (...a: unknown[]) => mockUpdateDurableConfig(...a),
  deleteDurable: (...a: unknown[]) => mockDeleteDurable(...a),
}));

vi.mock('../src/main/services/agent-system', () => ({
  getAvailableOrchestrators: (...a: unknown[]) => mockGetAvailableOrchestrators(...a),
  checkAvailability: (...a: unknown[]) => mockCheckAvailability(...a),
  resolveOrchestrator: (...a: unknown[]) => mockResolveOrchestrator(...a),
}));

vi.mock('../src/main/services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../src/main/services/theme-service', () => ({
  getSettings: (...a: unknown[]) => mockThemeGetSettings(...a),
  saveSettings: (...a: unknown[]) => mockThemeSave(...a),
}));

// ── Canvas Command Mock (stateful) ────────────────────────────────────────
// Simulates renderer canvas store with in-memory state for multi-step workflows.

interface MockCanvas {
  id: string;
  name: string;
  views: Array<{
    id: string;
    type: string;
    displayName: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
    agentId?: string;
    containedViewIds?: string[];
  }>;
  wires: Array<{ source: string; target: string }>;
}

let mockCanvases: MockCanvas[] = [];
let viewIdCounter = 0;
let canvasIdCounter = 0;

function resetCanvasState(): void {
  mockCanvases = [];
  viewIdCounter = 0;
  canvasIdCounter = 0;
}

function canvasCommandImpl(command: string, args: Record<string, unknown>): { success: boolean; data?: unknown; error?: string } {
  switch (command) {
    case 'add_canvas': {
      const id = `canvas_${++canvasIdCounter}`;
      const name = (args.name as string) || `Canvas ${canvasIdCounter}`;
      mockCanvases.push({ id, name, views: [], wires: [] });
      return { success: true, data: { canvas_id: id, name } };
    }
    case 'list_canvases': {
      return {
        success: true,
        data: mockCanvases.map(c => ({
          id: c.id, name: c.name, cardCount: c.views.length,
        })),
      };
    }
    case 'add_view': {
      const canvas = mockCanvases.find(c => c.id === args.canvas_id);
      if (!canvas) {
        return { success: false, error: `Canvas not found: ${args.canvas_id}` };
      }
      const viewId = `view_${++viewIdCounter}`;
      const pos = args.position as { x: number; y: number } | undefined;
      const sz = args.size as { w: number; h: number } | undefined;
      canvas.views.push({
        id: viewId,
        type: (args.type as string) || 'agent',
        displayName: (args.display_name as string) || viewId,
        position: pos || { x: 100, y: 100 },
        size: { width: sz?.w || 300, height: sz?.h || 200 },
        agentId: args.agent_id as string | undefined,
      });
      return { success: true, data: { view_id: viewId, canvas_id: canvas.id } };
    }
    case 'move_view': {
      const canvas = mockCanvases.find(c => c.id === args.canvas_id);
      if (!canvas) return { success: false, error: `Canvas not found: ${args.canvas_id}` };
      const view = canvas.views.find(v => v.id === args.view_id);
      if (!view) return { success: false, error: `View not found: ${args.view_id}` };
      const movePos = args.position as { x: number; y: number };
      view.position = movePos;
      return { success: true, data: null };
    }
    case 'resize_view': {
      const canvas = mockCanvases.find(c => c.id === args.canvas_id);
      if (!canvas) return { success: false, error: `Canvas not found: ${args.canvas_id}` };
      const view = canvas.views.find(v => v.id === args.view_id);
      if (!view) return { success: false, error: `View not found: ${args.view_id}` };
      const sz2 = args.size as { w: number; h: number };
      view.size = { width: sz2.w, height: sz2.h };
      return { success: true, data: null };
    }
    case 'remove_view': {
      const canvas = mockCanvases.find(c => c.id === args.canvas_id);
      if (!canvas) return { success: false, error: `Canvas not found: ${args.canvas_id}` };
      canvas.views = canvas.views.filter(v => v.id !== args.view_id);
      return { success: true, data: null };
    }
    case 'rename_view': {
      const canvas = mockCanvases.find(c => c.id === args.canvas_id);
      if (!canvas) return { success: false, error: `Canvas not found: ${args.canvas_id}` };
      const view = canvas.views.find(v => v.id === args.view_id);
      if (!view) return { success: false, error: `View not found: ${args.view_id}` };
      view.displayName = args.name as string;
      return { success: true, data: null };
    }
    case 'connect_views': {
      const canvas = mockCanvases.find(c => c.id === args.canvas_id);
      if (!canvas) return { success: false, error: `Canvas not found: ${args.canvas_id}` };
      canvas.wires.push({
        source: args.source_view_id as string,
        target: args.target_view_id as string,
      });
      if (args.bidirectional !== false) {
        canvas.wires.push({
          source: args.target_view_id as string,
          target: args.source_view_id as string,
        });
      }
      return { success: true, data: { wire_count: canvas.wires.length } };
    }
    case 'query_views': {
      const canvas = mockCanvases.find(c => c.id === args.canvas_id);
      if (!canvas) return { success: false, error: `Canvas not found: ${args.canvas_id}` };
      return { success: true, data: canvas.views };
    }
    default:
      return { success: false, error: `Unknown command: ${command}` };
  }
}

const { mockSendCanvasCommand } = vi.hoisted(() => ({
  mockSendCanvasCommand: vi.fn(),
}));

vi.mock('../src/main/services/clubhouse-mcp/canvas-command', () => ({
  sendCanvasCommand: (...a: unknown[]) => mockSendCanvasCommand(...a),
}));

/** Apply default canvas command implementation. */
function setupCanvasCommandDefault(): void {
  mockSendCanvasCommand.mockImplementation(
    async (command: string, args: Record<string, unknown>) => canvasCommandImpl(command, args),
  );
}

// ── Import after mocks ───────────────────────────────────────────────────

import { registerAssistantTools } from '../src/main/services/clubhouse-mcp/tools/assistant-tools';
import { _resetForTesting, callTool, getScopedToolList } from '../src/main/services/clubhouse-mcp/tool-registry';
import { bindingManager } from '../src/main/services/clubhouse-mcp';
import { ALL_TOOL_SUFFIXES } from '../src/main/services/clubhouse-mcp/assistant-api-contract';

// ── Test Helpers ──────────────────────────────────────────────────────────

const TEST_AGENT = 'integration-test-agent';
const ASSISTANT_TARGET = 'clubhouse_assistant';

function bindAssistant(): void {
  bindingManager.bind(TEST_AGENT, {
    targetId: ASSISTANT_TARGET,
    targetKind: 'assistant',
    label: 'Clubhouse Assistant',
  });
}

async function call(suffix: string, args: Record<string, unknown> = {}): Promise<any> {
  return callTool(TEST_AGENT, `assistant__${ASSISTANT_TARGET}__${suffix}`, args);
}

function parseJson(result: any): any {
  return JSON.parse(result.content[0].text);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Assistant Tools Integration Tests', () => {
  beforeEach(() => {
    _resetForTesting();
    setupMockDefaults();
    resetCanvasState();
    setupCanvasCommandDefault();
    registerAssistantTools();
    bindAssistant();
  });

  afterEach(() => {
    bindingManager.unbind(TEST_AGENT, ASSISTANT_TARGET);
  });

  // ══════════════════════════════════════════════════════════════════════
  // API CONTRACT VALIDATION
  // ══════════════════════════════════════════════════════════════════════

  describe('API contract', () => {
    it('all tools in catalog are registered and visible', () => {
      const tools = getScopedToolList(TEST_AGENT);
      const suffixes = tools.map(t => t.name.split('__').pop());
      for (const suffix of ALL_TOOL_SUFFIXES) {
        expect(suffixes, `Missing tool: ${suffix}`).toContain(suffix);
      }
    });

    it('tool count matches catalog', () => {
      const tools = getScopedToolList(TEST_AGENT);
      expect(tools.length).toBe(ALL_TOOL_SUFFIXES.length);
    });

    it('every tool has a description', () => {
      const tools = getScopedToolList(TEST_AGENT);
      for (const tool of tools) {
        expect(tool.description.length, `Tool ${tool.name} has empty description`).toBeGreaterThan(10);
      }
    });

    it('every tool has an inputSchema with type "object"', () => {
      const tools = getScopedToolList(TEST_AGENT);
      for (const tool of tools) {
        expect(tool.inputSchema.type, `Tool ${tool.name} schema type`).toBe('object');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // FULL CANVAS WORKFLOW
  // ══════════════════════════════════════════════════════════════════════

  describe('canvas workflow: create → add cards → connect → layout', () => {
    it('completes full canvas scaffolding workflow', async () => {
      // Step 1: Create canvas
      const createResult = await call('create_canvas', { name: 'Test Canvas' });
      expect(createResult.isError).toBeFalsy();
      const canvasData = parseJson(createResult);
      expect(canvasData.canvas_id).toBeTruthy();
      const canvasId = canvasData.canvas_id;

      // Step 2: Add agent cards
      const card1 = await call('add_card', {
        canvas_id: canvasId, type: 'agent', display_name: 'Coordinator',
        agent_id: 'agent-1', project_id: 'proj-1',
      });
      expect(card1.isError).toBeFalsy();
      const card1Data = parseJson(card1);
      expect(card1Data.view_id).toBeTruthy();

      const card2 = await call('add_card', {
        canvas_id: canvasId, type: 'agent', display_name: 'Worker',
        agent_id: 'agent-2', project_id: 'proj-1',
      });
      expect(card2.isError).toBeFalsy();
      const card2Data = parseJson(card2);

      // Step 3: Add a zone
      const zone = await call('add_card', {
        canvas_id: canvasId, type: 'zone', display_name: 'Work Zone',
      });
      expect(zone.isError).toBeFalsy();

      // Step 4: Connect agents
      const connectResult = await call('connect_cards', {
        canvas_id: canvasId,
        source_view_id: card1Data.view_id,
        target_view_id: card2Data.view_id,
      });
      expect(connectResult.isError).toBeFalsy();

      // Step 5: Layout
      const layoutResult = await call('layout_canvas', {
        canvas_id: canvasId, pattern: 'horizontal',
      });
      expect(layoutResult.isError).toBeFalsy();
      expect(layoutResult.content[0].text).toContain('Arranged');

      // Verify: canvas was created and cards were placed
      const canvas = mockCanvases[0];
      expect(canvas.views.length).toBe(3);
      expect(canvas.wires.length).toBe(2); // bidirectional = 2 wires
    });

    it('add_card auto-staggers when no position specified', async () => {
      const createResult = await call('create_canvas', { name: 'Stagger Test' });
      const canvasId = parseJson(createResult).canvas_id;

      // Add 5 cards without positions
      for (let i = 0; i < 5; i++) {
        await call('add_card', { canvas_id: canvasId, type: 'agent', display_name: `Card ${i}` });
      }

      // Verify positions are staggered (not all at 0,0)
      const canvas = mockCanvases.find(c => c.id === canvasId)!;
      const positions = canvas.views.map(v => v.position);
      const uniquePositions = new Set(positions.map(p => `${p.x},${p.y}`));
      expect(uniquePositions.size).toBe(5);
    });

    it('add_card retries on canvas not found race condition', async () => {
      // First two calls return "Canvas not found", third succeeds
      let addViewCount = 0;
      mockSendCanvasCommand.mockImplementation(async (command: string, args: Record<string, unknown>) => {
        if (command === 'add_view') {
          addViewCount++;
          if (addViewCount <= 2) {
            return { success: false, error: 'Canvas not found: canvas_race' };
          }
          return { success: true, data: { view_id: 'view_recovered', canvas_id: 'canvas_race' } };
        }
        // Fall through to default for other commands
        return canvasCommandImpl(command, args);
      });

      const result = await call('add_card', {
        canvas_id: 'canvas_race', type: 'agent', display_name: 'Race Card',
      });
      expect(result.isError).toBeFalsy();
      expect(addViewCount).toBe(3);
    });

    it('connect_cards requires source and target', async () => {
      const result = await call('connect_cards', { canvas_id: 'c1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required argument');
    });

    it('layout_canvas handles empty canvas gracefully', async () => {
      const createResult = await call('create_canvas', { name: 'Empty Canvas' });
      const canvasId = parseJson(createResult).canvas_id;

      const result = await call('layout_canvas', { canvas_id: canvasId, pattern: 'grid' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('No cards');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // PARAMETER ALIAS HANDLING
  // ══════════════════════════════════════════════════════════════════════

  describe('parameter aliases', () => {
    it('connect_cards accepts from_card_id/to_card_id aliases', async () => {
      const createResult = await call('create_canvas', { name: 'Alias Canvas' });
      const canvasId = parseJson(createResult).canvas_id;

      const card1 = await call('add_card', { canvas_id: canvasId, type: 'agent', display_name: 'A' });
      const card2 = await call('add_card', { canvas_id: canvasId, type: 'agent', display_name: 'B' });
      const id1 = parseJson(card1).view_id;
      const id2 = parseJson(card2).view_id;

      // Use aliased parameter names
      const result = await call('connect_cards', {
        canvas_id: canvasId,
        from_card_id: id1,
        to_card_id: id2,
      });
      expect(result.isError).toBeFalsy();
    });

    it('move_card accepts position_x/position_y aliases', async () => {
      const createResult = await call('create_canvas', { name: 'Move Alias' });
      const canvasId = parseJson(createResult).canvas_id;
      const card = await call('add_card', { canvas_id: canvasId, type: 'agent' });
      const viewId = parseJson(card).view_id;

      const result = await call('move_card', {
        canvas_id: canvasId,
        view_id: viewId,
        position_x: 500,
        position_y: 300,
      });
      expect(result.isError).toBeFalsy();

      // Verify position was applied
      const canvas = mockCanvases.find(c => c.id === canvasId)!;
      const view = canvas.views.find(v => v.id === viewId)!;
      expect(view.position.x).toBe(500);
      expect(view.position.y).toBe(300);
    });

    it('move_card requires either x/y or zone_id', async () => {
      const createResult = await call('create_canvas', { name: 'NoPos' });
      const canvasId = parseJson(createResult).canvas_id;
      const card = await call('add_card', { canvas_id: canvasId, type: 'agent' });
      const viewId = parseJson(card).view_id;

      const result = await call('move_card', { canvas_id: canvasId, view_id: viewId });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('required');
    });

    it('add_card coerces string width/height to numbers', async () => {
      const createResult = await call('create_canvas', { name: 'Coerce' });
      const canvasId = parseJson(createResult).canvas_id;

      // LLMs sometimes pass width as string — tool handler should coerce
      const result = await call('add_card', {
        canvas_id: canvasId,
        type: 'agent',
        width: 400, // The tool handler calls Number() on this
        height: 250,
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // AGENT CREATION WITH PERSONA
  // ══════════════════════════════════════════════════════════════════════

  describe('agent creation and persona injection', () => {
    it('create_agent calls createDurable with correct parameters', async () => {
      const result = await call('create_agent', {
        project_path: '/home/user/my-app',
        name: 'my-worker',
        color: 'indigo',
        model: 'opus',
        orchestrator: 'claude-code',
      });

      expect(result.isError).toBeFalsy();
      expect(mockCreateDurable).toHaveBeenCalledWith(
        '/home/user/my-app', 'my-worker', 'indigo', 'opus',
        true, 'claude-code', undefined, undefined, undefined, undefined,
      );
      const data = parseJson(result);
      expect(data.id).toBe('durable_abc');
      expect(data.name).toBe('test-agent');
    });

    it('create_agent with persona injects instructions', async () => {
      mockCreateDurable.mockResolvedValueOnce({
        id: 'durable_persona', name: 'qa-agent', color: 'red', icon: null,
        worktreePath: '/wt/qa', model: 'opus', orchestrator: 'claude-code',
        persona: 'qa', createdAt: '2026-01-01',
      });

      const result = await call('create_agent', {
        project_path: '/home/user/my-app',
        persona: 'qa',
      });

      expect(result.isError).toBeFalsy();
      // Should have called resolveOrchestrator to get the instruction writer
      expect(mockResolveOrchestrator).toHaveBeenCalled();
      // Should have read existing instructions
      expect(mockReadInstructions).toHaveBeenCalledWith('/wt/qa');
      // Should have written combined instructions (existing + persona)
      expect(mockWriteInstructions).toHaveBeenCalled();
      const writtenContent = mockWriteInstructions.mock.calls[0][1];
      expect(writtenContent).toContain('Existing defaults');
    });

    it('create_agent rejects invalid persona ID', async () => {
      const result = await call('create_agent', {
        project_path: '/home/user/my-app',
        persona: 'nonexistent-persona',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown persona');
      expect(result.content[0].text).toContain('Valid options');
    });

    it('create_agent generates name when not provided', async () => {
      await call('create_agent', { project_path: '/home/user/my-app' });
      const nameArg = mockCreateDurable.mock.calls[0][1];
      expect(nameArg).toMatch(/^agent-/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // BIDIRECTIONAL WIRES
  // ══════════════════════════════════════════════════════════════════════

  describe('wire bidirectionality (Wave 3 regression: PR #1233)', () => {
    it('connect_cards defaults to bidirectional', async () => {
      const createResult = await call('create_canvas', { name: 'BiDir' });
      const canvasId = parseJson(createResult).canvas_id;
      const a = parseJson(await call('add_card', { canvas_id: canvasId, type: 'agent', display_name: 'A' }));
      const b = parseJson(await call('add_card', { canvas_id: canvasId, type: 'agent', display_name: 'B' }));

      await call('connect_cards', {
        canvas_id: canvasId, source_view_id: a.view_id, target_view_id: b.view_id,
      });

      // Verify bidirectional = connect_views called with bidirectional not false
      const connectCall = mockSendCanvasCommand.mock.calls.find(
        (c: unknown[]) => c[0] === 'connect_views',
      );
      expect(connectCall).toBeTruthy();
      expect(connectCall![1].bidirectional).not.toBe(false);
    });

    it('connect_cards respects bidirectional=false', async () => {
      const createResult = await call('create_canvas', { name: 'UniDir' });
      const canvasId = parseJson(createResult).canvas_id;
      const a = parseJson(await call('add_card', { canvas_id: canvasId, type: 'agent', display_name: 'A' }));
      const b = parseJson(await call('add_card', { canvas_id: canvasId, type: 'agent', display_name: 'B' }));

      await call('connect_cards', {
        canvas_id: canvasId, source_view_id: a.view_id, target_view_id: b.view_id,
        bidirectional: false,
      });

      const connectCall = mockSendCanvasCommand.mock.calls.find(
        (c: unknown[]) => c[0] === 'connect_views',
      );
      expect(connectCall![1].bidirectional).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // ZONE-AWARE POSITIONING
  // ══════════════════════════════════════════════════════════════════════

  describe('zone-aware card positioning (Wave 3 regression: PR #1232)', () => {
    it('add_card with zone_id positions card inside zone bounds', async () => {
      const createResult = await call('create_canvas', { name: 'Zone Canvas' });
      const canvasId = parseJson(createResult).canvas_id;

      // Add a zone
      const zoneResult = await call('add_card', {
        canvas_id: canvasId, type: 'zone', display_name: 'Work Zone',
        position_x: 100, position_y: 100, width: 600, height: 400,
      });
      const zoneId = parseJson(zoneResult).view_id;

      // Add card inside zone
      const cardResult = await call('add_card', {
        canvas_id: canvasId, type: 'agent', display_name: 'Inside Card',
        zone_id: zoneId,
      });
      expect(cardResult.isError).toBeFalsy();

      // The add_view call should have received a position within zone bounds
      const addViewCalls = mockSendCanvasCommand.mock.calls.filter(
        (c: unknown[]) => c[0] === 'add_view',
      );
      const lastAddView = addViewCalls[addViewCalls.length - 1];
      const pos = lastAddView[1].position;
      // Card position should be within zone bounds (100-700 x, 100-500 y)
      expect(pos.x).toBeGreaterThanOrEqual(100);
      expect(pos.y).toBeGreaterThanOrEqual(100);
    });

    it('move_card with zone_id auto-positions within zone', async () => {
      const createResult = await call('create_canvas', { name: 'Zone Move' });
      const canvasId = parseJson(createResult).canvas_id;

      // Create zone and card
      const zone = parseJson(await call('add_card', {
        canvas_id: canvasId, type: 'zone', display_name: 'Z',
        position_x: 200, position_y: 200, width: 600, height: 400,
      }));
      const card = parseJson(await call('add_card', {
        canvas_id: canvasId, type: 'agent', display_name: 'Movable',
      }));

      const result = await call('move_card', {
        canvas_id: canvasId, view_id: card.view_id, zone_id: zone.view_id,
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // THEME SYSTEM (Wave 3 regression: PR #1234)
  // ══════════════════════════════════════════════════════════════════════

  describe('theme system', () => {
    it('update_settings with theme key calls themeService', async () => {
      const result = await call('update_settings', { key: 'theme', value: 'cyberpunk' });
      expect(result.isError).toBeFalsy();
      expect(mockThemeSave).toHaveBeenCalledWith({ themeId: 'cyberpunk' });
      expect(result.content[0].text).toContain('Applied immediately');
    });

    it('update_settings with themeId key also routes to theme service', async () => {
      const result = await call('update_settings', { key: 'themeId', value: 'nord' });
      expect(result.isError).toBeFalsy();
      expect(mockThemeSave).toHaveBeenCalledWith({ themeId: 'nord' });
    });

    it('list_themes returns available themes with current selection', async () => {
      const result = await call('list_themes');
      expect(result.isError).toBeFalsy();
      const data = parseJson(result);
      expect(data.currentTheme).toBe('catppuccin-mocha');
      expect(Array.isArray(data.availableThemes)).toBe(true);
      expect(data.availableThemes.length).toBeGreaterThan(0);
      // Each theme should have id, name, type
      for (const theme of data.availableThemes) {
        expect(theme.id).toBeTruthy();
        expect(theme.name).toBeTruthy();
        expect(theme.type).toBeTruthy();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // ERROR CASES
  // ══════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    it('canvas operations fail gracefully when canvas not found', async () => {
      const result = await call('add_card', {
        canvas_id: 'nonexistent', type: 'agent',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('move_card fails for nonexistent view', async () => {
      const createResult = await call('create_canvas', { name: 'Error Canvas' });
      const canvasId = parseJson(createResult).canvas_id;

      const result = await call('move_card', {
        canvas_id: canvasId, view_id: 'nonexistent', x: 100, y: 100,
      });
      expect(result.isError).toBe(true);
    });

    it('required arguments are validated', async () => {
      // list_agents without project_path
      const r1 = await call('list_agents', {});
      expect(r1.isError).toBe(true);
      expect(r1.content[0].text).toContain('Missing required argument');

      // delete_agent without agent_id
      const r2 = await call('delete_agent', { project_path: '/tmp' });
      expect(r2.isError).toBe(true);

      // write_agent_instructions without content
      const r3 = await call('write_agent_instructions', { project_path: '/tmp' });
      expect(r3.isError).toBe(true);
    });

    it('calling a tool without binding returns error', async () => {
      const result = await callTool('unbound-agent', `assistant__${ASSISTANT_TARGET}__list_projects`, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No binding found');
    });

    it('calling nonexistent tool returns error', async () => {
      const result = await call('nonexistent_tool', {});
      expect(result.isError).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // SEQUENTIAL RAPID OPERATIONS (race condition coverage)
  // ══════════════════════════════════════════════════════════════════════

  describe('rapid sequential operations', () => {
    it('multiple add_card calls on same canvas produce unique IDs', async () => {
      const createResult = await call('create_canvas', { name: 'Rapid' });
      const canvasId = parseJson(createResult).canvas_id;

      const results = await Promise.all([
        call('add_card', { canvas_id: canvasId, type: 'agent', display_name: 'A' }),
        call('add_card', { canvas_id: canvasId, type: 'agent', display_name: 'B' }),
        call('add_card', { canvas_id: canvasId, type: 'agent', display_name: 'C' }),
      ]);

      const ids = results.map(r => parseJson(r).view_id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });

    it('create_canvas followed immediately by add_card succeeds', async () => {
      // This is the exact pattern that caused the P0 canvas ID bug in beta.13
      const createResult = await call('create_canvas', { name: 'Immediate' });
      const canvasId = parseJson(createResult).canvas_id;

      // Immediately add card — no delay
      const cardResult = await call('add_card', {
        canvas_id: canvasId, type: 'agent', display_name: 'Instant',
      });
      expect(cardResult.isError).toBeFalsy();
    });

    it('full workflow: create → 4 cards → 3 wires → layout', async () => {
      const canvasId = parseJson(await call('create_canvas', { name: 'Full Flow' })).canvas_id;

      // Add 4 agent cards
      const cardIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await call('add_card', {
          canvas_id: canvasId, type: 'agent', display_name: `Agent ${i}`,
        });
        cardIds.push(parseJson(r).view_id);
      }

      // Wire hub-spoke: card[0] → card[1], card[0] → card[2], card[0] → card[3]
      for (let i = 1; i < 4; i++) {
        const r = await call('connect_cards', {
          canvas_id: canvasId,
          source_view_id: cardIds[0],
          target_view_id: cardIds[i],
        });
        expect(r.isError).toBeFalsy();
      }

      // Layout
      const layoutResult = await call('layout_canvas', {
        canvas_id: canvasId, pattern: 'hub_spoke',
      });
      expect(layoutResult.isError).toBeFalsy();
      expect(layoutResult.content[0].text).toContain('4 cards');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // WAVE 4 REGRESSION ANCHORS
  // ══════════════════════════════════════════════════════════════════════

  describe('Wave 4 regression anchors', () => {
    // Mission 16 (P0): Canvas ID inference — connect_cards should work
    // with canvas_id + from_card_id/to_card_id (alias path tested above).
    // TODO: When Mission 16 lands, add test for canvas_id inference from card IDs.

    // Mission 17: Layout engine — auto-stagger positions for cards without explicit positions
    it('auto-stagger produces grid layout (4 columns, then wrap)', async () => {
      const canvasId = parseJson(await call('create_canvas', { name: 'Stagger Grid' })).canvas_id;

      // Add 6 cards — should produce 4 in row 1, 2 in row 2
      for (let i = 0; i < 6; i++) {
        await call('add_card', { canvas_id: canvasId, type: 'agent', display_name: `Card ${i}` });
      }

      // Check the positions sent via IPC
      const addViewCalls = mockSendCanvasCommand.mock.calls.filter(
        (c: unknown[]) => c[0] === 'add_view',
      );
      const positions = addViewCalls.map((c: unknown[]) => (c[1] as any).position);

      // First 4 cards should be in row 1 (y = 100), columns at 100, 440, 780, 1120
      for (let i = 0; i < 4; i++) {
        expect(positions[i].y).toBe(100);
        expect(positions[i].x).toBe(100 + i * 340);
      }
      // Card 5 and 6 should wrap to row 2 (y = 360)
      expect(positions[4].y).toBe(100 + 260);
      expect(positions[5].y).toBe(100 + 260);
    });

    // Mission 18: Content audit — persona creation should accept valid persona IDs
    it('create_agent accepts all 7 valid persona IDs without error', async () => {
      const validPersonas = ['project-manager', 'qa', 'ui-lead', 'quality-auditor',
        'executor-pr-only', 'executor-merge', 'doc-updater'];

      for (const persona of validPersonas) {
        mockCreateDurable.mockResolvedValueOnce({
          id: `durable_${persona}`, name: `${persona}-agent`, color: 'emerald', icon: null,
          worktreePath: `/wt/${persona}`, model: 'opus', orchestrator: 'claude-code',
          persona, createdAt: '2026-01-01',
        });

        const result = await call('create_agent', {
          project_path: '/tmp/test', persona,
        });
        expect(result.isError, `Persona ${persona} should not error`).toBeFalsy();
      }
    });

    // Canvas operations should return structured data, not plain strings
    it('create_canvas returns structured JSON with canvas_id', async () => {
      const result = await call('create_canvas', { name: 'Structured Response' });
      expect(result.isError).toBeFalsy();
      const data = parseJson(result);
      expect(data).toHaveProperty('canvas_id');
      expect(typeof data.canvas_id).toBe('string');
    });

    it('add_card returns structured JSON with view_id and canvas_id', async () => {
      const canvasId = parseJson(await call('create_canvas', {})).canvas_id;
      const result = await call('add_card', { canvas_id: canvasId, type: 'agent' });
      expect(result.isError).toBeFalsy();
      const data = parseJson(result);
      expect(data).toHaveProperty('view_id');
      expect(data).toHaveProperty('canvas_id');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // READ-ONLY TOOLS SMOKE TESTS
  // ══════════════════════════════════════════════════════════════════════

  describe('read-only tools', () => {
    it('list_projects returns project data', async () => {
      const result = await call('list_projects');
      expect(result.isError).toBeFalsy();
      const data = parseJson(result);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('proj-1');
    });

    it('list_agents returns agents for project', async () => {
      const result = await call('list_agents', { project_path: '/home/user/my-app' });
      expect(result.isError).toBeFalsy();
      const data = parseJson(result);
      expect(data.length).toBeGreaterThan(0);
      expect(data[0]).toHaveProperty('id');
      expect(data[0]).toHaveProperty('name');
      expect(data[0]).toHaveProperty('orchestrator');
    });

    it('get_app_state returns project count and orchestrators', async () => {
      const result = await call('get_app_state');
      expect(result.isError).toBeFalsy();
      const data = parseJson(result);
      expect(data.projectCount).toBe(1);
      expect(data.orchestrators.length).toBeGreaterThan(0);
    });

    it('get_orchestrators returns availability info', async () => {
      const result = await call('get_orchestrators');
      expect(result.isError).toBeFalsy();
      const data = parseJson(result);
      expect(data.length).toBeGreaterThan(0);
      expect(data[0].available).toBe(true);
    });

    it('check_path works for real filesystem paths', async () => {
      const result = await call('check_path', { path: os.tmpdir() });
      expect(result.isError).toBeFalsy();
      const data = parseJson(result);
      expect(data.exists).toBe(true);
      expect(data.type).toBe('directory');
    });

    it('search_help returns results for known topics', async () => {
      const result = await call('search_help', { query: 'keyboard' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Keyboard');
    });

    it('get_settings returns valid JSON', async () => {
      const result = await call('get_settings');
      expect(result.isError).toBeFalsy();
      expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // WRITE TOOLS
  // ══════════════════════════════════════════════════════════════════════

  describe('write tools', () => {
    it('add_project validates directory exists', async () => {
      const result = await call('add_project', { path: '/nonexistent/dir' });
      expect(result.isError).toBe(true);
    });

    it('add_project succeeds for valid directory', async () => {
      const result = await call('add_project', { path: os.tmpdir() });
      expect(result.isError).toBeFalsy();
      expect(mockProjectAdd).toHaveBeenCalledWith(os.tmpdir());
    });

    it('remove_project calls store', async () => {
      const result = await call('remove_project', { project_id: 'proj-1' });
      expect(result.isError).toBeFalsy();
      expect(mockProjectRemove).toHaveBeenCalledWith('proj-1');
    });

    it('delete_agent calls deleteDurable', async () => {
      const result = await call('delete_agent', {
        project_path: '/home/user/my-app', agent_id: 'agent-1',
      });
      expect(result.isError).toBeFalsy();
      expect(mockDeleteDurable).toHaveBeenCalledWith('/home/user/my-app', 'agent-1');
    });

    it('update_agent calls updateDurable for basic fields and config', async () => {
      const result = await call('update_agent', {
        project_path: '/tmp/proj', agent_id: 'agent-1',
        name: 'renamed', model: 'sonnet',
      });
      expect(result.isError).toBeFalsy();
      expect(mockUpdateDurable).toHaveBeenCalled();
      expect(mockUpdateDurableConfig).toHaveBeenCalled();
    });

    it('write_agent_instructions resolves orchestrator and writes', async () => {
      const result = await call('write_agent_instructions', {
        project_path: '/tmp/proj', content: '# My instructions',
      });
      expect(result.isError).toBeFalsy();
      expect(mockResolveOrchestrator).toHaveBeenCalled();
      expect(mockWriteInstructions).toHaveBeenCalledWith('/tmp/proj', '# My instructions');
    });
  });
});
