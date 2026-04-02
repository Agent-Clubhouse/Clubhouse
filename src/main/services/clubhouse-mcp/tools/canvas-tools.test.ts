import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

const mockSendCanvasCommand = vi.fn();
vi.mock('../canvas-command', () => ({
  sendCanvasCommand: (...args: unknown[]) => mockSendCanvasCommand(...args),
}));

import { registerCanvasTools } from './canvas-tools';
import { getScopedToolList, callTool, _resetForTesting as resetToolRegistry } from '../tool-registry';
import { bindingManager } from '../binding-manager';

describe('CanvasTools (global)', () => {
  beforeEach(() => {
    resetToolRegistry();
    bindingManager._resetForTesting();
    mockSendCanvasCommand.mockReset();
    registerCanvasTools();
  });

  describe('tool registration', () => {
    it('registers 5 global canvas tools', () => {
      // Global tools appear even for agents with no bindings
      const tools = getScopedToolList('any-agent-id');
      const canvasTools = tools.filter((t) => t.name.startsWith('canvas__'));
      expect(canvasTools).toHaveLength(5);
    });

    it('exposes the correct tool names', () => {
      const tools = getScopedToolList('any-agent-id');
      const names = tools.map((t) => t.name);
      expect(names).toContain('canvas__create_canvas');
      expect(names).toContain('canvas__list_canvases');
      expect(names).toContain('canvas__open_canvas');
      expect(names).toContain('canvas__add_card_to_canvas');
      expect(names).toContain('canvas__connect_cards');
    });

    it('canvas tools are available alongside binding-scoped tools', () => {
      // Create a binding-scoped tool (agent tool would need registerAgentTools,
      // but we can verify canvas tools still appear with an empty binding set)
      const tools = getScopedToolList('agent-with-no-bindings');
      const canvasTools = tools.filter((t) => t.name.startsWith('canvas__'));
      expect(canvasTools).toHaveLength(5);
    });
  });

  describe('create_canvas', () => {
    it('sends add_canvas command and returns result', async () => {
      mockSendCanvasCommand.mockResolvedValue({
        success: true,
        data: { canvas_id: 'c_123' },
      });

      const result = await callTool('agent-1', 'canvas__create_canvas', {
        name: 'My Canvas',
      });

      expect(mockSendCanvasCommand).toHaveBeenCalledWith('add_canvas', {
        name: 'My Canvas',
        project_id: undefined,
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('c_123');
    });

    it('passes project_id when provided', async () => {
      mockSendCanvasCommand.mockResolvedValue({
        success: true,
        data: { canvas_id: 'c_456' },
      });

      await callTool('agent-1', 'canvas__create_canvas', {
        name: 'Project Canvas',
        project_id: 'proj_1',
      });

      expect(mockSendCanvasCommand).toHaveBeenCalledWith('add_canvas', {
        name: 'Project Canvas',
        project_id: 'proj_1',
      });
    });

    it('returns error on failure', async () => {
      mockSendCanvasCommand.mockResolvedValue({
        success: false,
        error: 'No renderer window available',
      });

      const result = await callTool('agent-1', 'canvas__create_canvas', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No renderer window available');
    });
  });

  describe('list_canvases', () => {
    it('returns canvas list', async () => {
      const canvasList = [
        { id: 'c_1', name: 'Canvas One', cardCount: 3 },
        { id: 'c_2', name: 'Canvas Two', cardCount: 0 },
      ];
      mockSendCanvasCommand.mockResolvedValue({
        success: true,
        data: canvasList,
      });

      const result = await callTool('agent-1', 'canvas__list_canvases', {});

      expect(mockSendCanvasCommand).toHaveBeenCalledWith('list_canvases', {
        project_id: undefined,
      });
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe('Canvas One');
    });
  });

  describe('open_canvas', () => {
    it('sends navigate_to_canvas command', async () => {
      mockSendCanvasCommand.mockResolvedValue({
        success: true,
        data: { canvas_id: 'c_1', project_id: 'proj_1', name: 'My Canvas' },
      });

      const result = await callTool('agent-1', 'canvas__open_canvas', {
        canvas_id: 'c_1',
        project_id: 'proj_1',
      });

      expect(mockSendCanvasCommand).toHaveBeenCalledWith('navigate_to_canvas', {
        canvas_id: 'c_1',
        project_id: 'proj_1',
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.canvas_id).toBe('c_1');
    });

    it('requires canvas_id', async () => {
      const result = await callTool('agent-1', 'canvas__open_canvas', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required argument: canvas_id');
    });

    it('returns error when canvas not found', async () => {
      mockSendCanvasCommand.mockResolvedValue({
        success: false,
        error: 'Canvas not found: c_nonexistent',
      });

      const result = await callTool('agent-1', 'canvas__open_canvas', {
        canvas_id: 'c_nonexistent',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Canvas not found');
    });
  });

  describe('add_card_to_canvas', () => {
    it('sends add_view command with all params', async () => {
      mockSendCanvasCommand.mockResolvedValue({
        success: true,
        data: { view_id: 'v_1', canvas_id: 'c_1', agent_bound: true },
      });

      const result = await callTool('agent-1', 'canvas__add_card_to_canvas', {
        canvas_id: 'c_1',
        type: 'agent',
        display_name: 'My Agent',
        position: { x: 200, y: 300 },
        agent_id: 'durable_123',
      });

      expect(mockSendCanvasCommand).toHaveBeenCalledWith('add_view', expect.objectContaining({
        canvas_id: 'c_1',
        type: 'agent',
        display_name: 'My Agent',
        agent_id: 'durable_123',
      }));
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.view_id).toBe('v_1');
    });

    it('requires canvas_id and type', async () => {
      const result1 = await callTool('agent-1', 'canvas__add_card_to_canvas', {
        type: 'agent',
      });
      expect(result1.isError).toBe(true);
      expect(result1.content[0].text).toContain('canvas_id');

      const result2 = await callTool('agent-1', 'canvas__add_card_to_canvas', {
        canvas_id: 'c_1',
      });
      expect(result2.isError).toBe(true);
      expect(result2.content[0].text).toContain('type');
    });

    it('supports sticky-note with content and color', async () => {
      mockSendCanvasCommand.mockResolvedValue({
        success: true,
        data: { view_id: 'v_2', canvas_id: 'c_1' },
      });

      await callTool('agent-1', 'canvas__add_card_to_canvas', {
        canvas_id: 'c_1',
        type: 'sticky-note',
        content: 'Hello world',
        color: 'blue',
      });

      expect(mockSendCanvasCommand).toHaveBeenCalledWith('add_view', expect.objectContaining({
        type: 'sticky-note',
        content: 'Hello world',
        color: 'blue',
      }));
    });
  });

  describe('connect_cards', () => {
    it('sends connect_views command', async () => {
      mockSendCanvasCommand.mockResolvedValue({
        success: true,
        data: {
          canvas_id: 'c_1',
          sourceAgentId: 'durable_1',
          targetId: 'durable_2',
          targetKind: 'agent',
          bindingCreated: true,
          bidirectional: true,
          reverseBindingCreated: true,
        },
      });

      const result = await callTool('agent-1', 'canvas__connect_cards', {
        canvas_id: 'c_1',
        source_view_id: 'v_1',
        target_view_id: 'v_2',
      });

      expect(mockSendCanvasCommand).toHaveBeenCalledWith('connect_views', {
        canvas_id: 'c_1',
        source_view_id: 'v_1',
        target_view_id: 'v_2',
        bidirectional: undefined,
        project_id: undefined,
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.bidirectional).toBe(true);
    });

    it('requires canvas_id, source_view_id, and target_view_id', async () => {
      const result = await callTool('agent-1', 'canvas__connect_cards', {
        canvas_id: 'c_1',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('source_view_id');
    });

    it('passes bidirectional flag when specified', async () => {
      mockSendCanvasCommand.mockResolvedValue({
        success: true,
        data: { bidirectional: false },
      });

      await callTool('agent-1', 'canvas__connect_cards', {
        canvas_id: 'c_1',
        source_view_id: 'v_1',
        target_view_id: 'v_2',
        bidirectional: false,
      });

      expect(mockSendCanvasCommand).toHaveBeenCalledWith('connect_views', expect.objectContaining({
        bidirectional: false,
      }));
    });
  });

  describe('integration: create → navigate flow', () => {
    it('create a canvas then open it', async () => {
      // Step 1: Create canvas
      mockSendCanvasCommand.mockResolvedValueOnce({
        success: true,
        data: { canvas_id: 'c_new' },
      });

      const createResult = await callTool('agent-1', 'canvas__create_canvas', {
        name: 'Test Canvas',
      });
      const created = JSON.parse(createResult.content[0].text!);
      expect(created.canvas_id).toBe('c_new');

      // Step 2: Navigate to the created canvas
      mockSendCanvasCommand.mockResolvedValueOnce({
        success: true,
        data: { canvas_id: 'c_new', project_id: null, name: 'Test Canvas' },
      });

      const openResult = await callTool('agent-1', 'canvas__open_canvas', {
        canvas_id: created.canvas_id,
      });
      const opened = JSON.parse(openResult.content[0].text!);
      expect(opened.canvas_id).toBe('c_new');
      expect(opened.name).toBe('Test Canvas');

      // Verify command sequence
      expect(mockSendCanvasCommand).toHaveBeenCalledTimes(2);
      expect(mockSendCanvasCommand.mock.calls[0][0]).toBe('add_canvas');
      expect(mockSendCanvasCommand.mock.calls[1][0]).toBe('navigate_to_canvas');
    });
  });
});
