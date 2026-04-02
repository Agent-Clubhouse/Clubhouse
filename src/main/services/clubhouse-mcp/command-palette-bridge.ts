/**
 * Command Palette Bridge — bridges main-process MCP tool calls to
 * renderer-side command palette operations.
 *
 * Same request/response pattern as canvas-command.ts:
 * 1. Main sends CMD_PALETTE.REQUEST to renderer with a unique callId
 * 2. Renderer executes the command palette operation
 * 3. Renderer sends CMD_PALETTE.RESULT back with callId + result
 * 4. Main resolves the pending promise
 */

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { appLog } from '../log-service';

export interface CommandPaletteResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingCall {
  resolve: (result: CommandPaletteResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingCalls = new Map<string, PendingCall>();
const TIMEOUT_MS = 10_000;
let callIdCounter = 0;
let handlerRegistered = false;

/**
 * Send a command palette operation to the renderer and wait for the result.
 */
export async function sendCommandPaletteRequest(
  operation: string,
  args: Record<string, unknown>,
): Promise<CommandPaletteResult> {
  const callId = `cp_${++callIdCounter}_${Date.now()}`;

  return new Promise<CommandPaletteResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      resolve({ success: false, error: 'Command palette operation timed out' });
    }, TIMEOUT_MS);

    pendingCalls.set(callId, { resolve, timer });

    const { BrowserWindow } = require('electron') as typeof import('electron');
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send(IPC.CMD_PALETTE.REQUEST, { callId, operation, args });
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
export function registerCommandPaletteHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;

  ipcMain.on(IPC.CMD_PALETTE.RESULT, (_event, payload: { callId: string; result: CommandPaletteResult }) => {
    const pending = pendingCalls.get(payload.callId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCalls.delete(payload.callId);
      pending.resolve(payload.result);
    }
  });

  appLog('core:mcp', 'info', 'Command palette bridge registered');
}

/** For testing: reset state. */
export function _resetForTesting(): void {
  for (const [, pending] of pendingCalls) {
    clearTimeout(pending.timer);
  }
  pendingCalls.clear();
  callIdCounter = 0;
}
