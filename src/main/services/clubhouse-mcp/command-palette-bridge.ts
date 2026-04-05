/**
 * Command Palette Bridge — bridges main-process MCP tool calls to
 * renderer-side command palette operations.
 *
 * Uses the shared ProcessBridge for IPC.
 *
 * Same request/response pattern as canvas-command.ts:
 * 1. Main sends CMD_PALETTE.REQUEST to renderer with a unique callId
 * 2. Renderer executes the command palette operation
 * 3. Renderer sends CMD_PALETTE.RESULT back with callId + result
 * 4. Main resolves the pending promise
 */

import { IPC } from '../../../shared/ipc-channels';
import { ProcessBridge } from './process-bridge';

export interface CommandPaletteResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

const bridge = new ProcessBridge({
  requestChannel: IPC.CMD_PALETTE.REQUEST,
  resultChannel: IPC.CMD_PALETTE.RESULT,
  callIdPrefix: 'cp',
  timeoutMs: 10_000,
  logTag: 'cmd-palette',
});

/**
 * Send a command palette operation to the renderer and wait for the result.
 */
export async function sendCommandPaletteRequest(
  operation: string,
  args: Record<string, unknown>,
): Promise<CommandPaletteResult> {
  return bridge.send({ operation, args });
}

/**
 * Register the IPC handler that receives results from the renderer.
 * Call once during MCP initialization.
 */
export function registerCommandPaletteHandler(): void {
  bridge.registerHandler();
}

/** For testing: reset state. */
export function _resetForTesting(): void {
  bridge._resetForTesting();
}
