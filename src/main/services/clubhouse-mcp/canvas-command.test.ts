import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ---- Electron mocks ---- */
const mockSend = vi.fn();
const mockOn = vi.fn();
let mockWindows: unknown[] = [{ webContents: { send: mockSend } }];

vi.mock('electron', () => ({
  ipcMain: { on: (...args: unknown[]) => mockOn(...args) },
  BrowserWindow: {
    getAllWindows: () => mockWindows,
  },
}));

vi.mock('../log-service', () => ({
  appLog: vi.fn(),
}));

import { sendCanvasCommand, registerCanvasCommandHandler, _resetForTesting } from './canvas-command';
import { commandRegistry } from '../../../shared/command-registry';

// Register once — bridge handler is a singleton
let resultListener: ((event: unknown, payload: any) => void) | null = null;

describe('canvas-command (with CommandRegistry)', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockWindows = [{ webContents: { send: mockSend } }];
    commandRegistry.clear();
    _resetForTesting();

    // Ensure handler is registered and capture the IPC listener
    if (!resultListener) {
      registerCanvasCommandHandler();
      const call = mockOn.mock.calls.find(([channel]: unknown[]) => channel === 'canvas-cmd:result');
      if (call) resultListener = call[1];
    }
  });

  afterEach(() => {
    commandRegistry.clear();
  });

  describe('registerCanvasCommandHandler', () => {
    it('registers all 16 canvas commands in the registry', () => {
      registerCanvasCommandHandler();
      const canvasCommands = commandRegistry.list({ category: 'canvas' });
      expect(canvasCommands).toHaveLength(16);
    });

    it('registers commands with canvas.* IDs', () => {
      registerCanvasCommandHandler();
      const expectedIds = [
        'canvas.find_canvas_for_view', 'canvas.add_canvas', 'canvas.list_canvases',
        'canvas.add_view', 'canvas.move_view', 'canvas.resize_view',
        'canvas.remove_view', 'canvas.rename_view', 'canvas.query_views',
        'canvas.query_wires', 'canvas.connect_views', 'canvas.disconnect_views',
        'canvas.navigate_to_canvas', 'canvas.create_from_blueprint',
        'canvas.export_blueprint', 'canvas.import_blueprint',
      ];
      for (const id of expectedIds) {
        expect(commandRegistry.get(id), `Missing command: ${id}`).toBeDefined();
      }
    });

    it('all canvas commands are marked as renderer process', () => {
      registerCanvasCommandHandler();
      const commands = commandRegistry.list({ category: 'canvas' });
      for (const cmd of commands) {
        expect(cmd.process).toBe('renderer');
      }
    });

    it('all canvas commands have mcp scoping = binding', () => {
      registerCanvasCommandHandler();
      const commands = commandRegistry.list({ category: 'canvas' });
      for (const cmd of commands) {
        expect(cmd.mcp).toEqual({ scoping: 'binding' });
      }
    });

    it('is idempotent — calling twice does not double-register', () => {
      registerCanvasCommandHandler();
      registerCanvasCommandHandler();
      expect(commandRegistry.list({ category: 'canvas' })).toHaveLength(16);
    });
  });

  describe('sendCanvasCommand', () => {
    it('routes through the CommandRegistry and sends IPC request', async () => {
      registerCanvasCommandHandler();

      const promise = sendCanvasCommand('add_canvas', { name: 'Test' });

      // The handler should have sent an IPC request via the bridge
      expect(mockSend).toHaveBeenCalledTimes(1);
      const [channel, payload] = mockSend.mock.calls[0];
      expect(channel).toBe('canvas-cmd:request');
      expect(payload.command).toBe('add_canvas');
      expect(payload.args).toEqual({ name: 'Test' });

      // Simulate renderer response
      resultListener!(null, {
        callId: payload.callId,
        result: { success: true, data: { canvas_id: 'c1' } },
      });

      const result = await promise;
      expect(result).toEqual({ success: true, data: { canvas_id: 'c1' } });
    });

    it('falls back to direct bridge call for unregistered commands', async () => {
      // Register handler but don't register the custom command
      registerCanvasCommandHandler();

      const promise = sendCanvasCommand('custom_command', { foo: 'bar' });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const [, payload] = mockSend.mock.calls[0];
      expect(payload.command).toBe('custom_command');

      // Resolve via IPC
      resultListener!(null, {
        callId: payload.callId,
        result: { success: true },
      });

      const result = await promise;
      expect(result.success).toBe(true);
    });
  });

  describe('command metadata', () => {
    it('visible commands have palette keywords', () => {
      registerCanvasCommandHandler();
      const addCanvas = commandRegistry.get('canvas.add_canvas')!;
      expect(addCanvas.palette?.keywords).toContain('create');

      const connect = commandRegistry.get('canvas.connect_views')!;
      expect(connect.palette?.keywords).toContain('wire');
    });

    it('internal commands are hidden from palette', () => {
      registerCanvasCommandHandler();
      const findView = commandRegistry.get('canvas.find_canvas_for_view')!;
      expect(findView.palette?.hidden).toBe(true);

      const moveView = commandRegistry.get('canvas.move_view')!;
      expect(moveView.palette?.hidden).toBe(true);
    });

    it('commands have descriptive labels and descriptions', () => {
      registerCanvasCommandHandler();
      const cmd = commandRegistry.get('canvas.add_canvas')!;
      expect(cmd.label).toBe('Create Canvas');
      expect(cmd.description).toBeTruthy();
      expect(cmd.category).toBe('canvas');
    });
  });
});
