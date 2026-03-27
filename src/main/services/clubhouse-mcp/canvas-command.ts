/**
 * Canvas Command Dispatcher — bridges main-process MCP tool calls to
 * renderer-side canvas operations.
 *
 * Follows the same request/response pattern as plugin-tool-registry.ts:
 * 1. Main sends CANVAS_CMD.REQUEST to renderer with a unique callId
 * 2. Renderer executes the canvas operation on canvas-store
 * 3. Renderer sends CANVAS_CMD.RESULT back with callId + result
 * 4. Main resolves the pending promise
 */

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { appLog } from '../log-service';

export interface CanvasCommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingCall {
  resolve: (result: CanvasCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingCalls = new Map<string, PendingCall>();
const TIMEOUT_MS = 15_000;
let callIdCounter = 0;
let handlerRegistered = false;

/**
 * Send a canvas command to the renderer and wait for the result.
 */
export async function sendCanvasCommand(
  command: string,
  args: Record<string, unknown>,
): Promise<CanvasCommandResult> {
  const callId = `cc_${++callIdCounter}_${Date.now()}`;

  return new Promise<CanvasCommandResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      resolve({ success: false, error: 'Canvas command timed out' });
    }, TIMEOUT_MS);

    pendingCalls.set(callId, { resolve, timer });

    const { BrowserWindow } = require('electron') as typeof import('electron');
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send(IPC.CANVAS_CMD.REQUEST, { callId, command, args });
    } else {
      pendingCalls.delete(callId);
      clearTimeout(timer);
      resolve({ success: false, error: 'No renderer window available' });
    }
  });
}

/**
 * Register the IPC handler that receives results from the renderer.
 * Call once during MCP initialization.
 */
export function registerCanvasCommandHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;

  ipcMain.on(IPC.CANVAS_CMD.RESULT, (_event, payload: { callId: string; result: CanvasCommandResult }) => {
    const pending = pendingCalls.get(payload.callId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCalls.delete(payload.callId);
      pending.resolve(payload.result);
    }
  });

  appLog('core:mcp', 'info', 'Canvas command handler registered');
}

/** For testing: clear pending calls. */
export function _resetForTesting(): void {
  for (const [, pending] of pendingCalls) {
    clearTimeout(pending.timer);
  }
  pendingCalls.clear();
  callIdCounter = 0;
}
