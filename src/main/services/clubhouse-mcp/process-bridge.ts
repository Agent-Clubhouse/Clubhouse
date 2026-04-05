/**
 * Generic Process Bridge — unifies the callId + timeout + pending-map
 * pattern used by canvas-command.ts and command-palette-bridge.ts.
 *
 * Bridges main→renderer IPC requests with correlated responses.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { appLog } from '../log-service';

export interface BridgeResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingCall {
  resolve: (result: BridgeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ProcessBridgeOptions {
  /** IPC channel for main→renderer requests */
  requestChannel: string;
  /** IPC channel for renderer→main results */
  resultChannel: string;
  /** Prefix for unique call IDs (e.g. "cc", "cp") */
  callIdPrefix: string;
  /** Timeout in ms (default 15000) */
  timeoutMs?: number;
  /** Log tag for appLog (e.g. "canvas-cmd") */
  logTag?: string;
}

export class ProcessBridge {
  private readonly pendingCalls = new Map<string, PendingCall>();
  private callIdCounter = 0;
  private handlerRegistered = false;
  private readonly opts: Required<Pick<ProcessBridgeOptions, 'timeoutMs' | 'logTag'>> & ProcessBridgeOptions;

  constructor(options: ProcessBridgeOptions) {
    this.opts = {
      timeoutMs: 15_000,
      logTag: options.callIdPrefix,
      ...options,
    };
  }

  /**
   * Send a request to the renderer and wait for the correlated response.
   * The payload is sent as `{ callId, ...payload }`.
   */
  send(payload: Record<string, unknown>): Promise<BridgeResult> {
    const callId = `${this.opts.callIdPrefix}_${++this.callIdCounter}_${Date.now()}`;

    return new Promise<BridgeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId);
        resolve({ success: false, error: `${this.opts.logTag} request timed out` });
      }, this.opts.timeoutMs);

      this.pendingCalls.set(callId, { resolve, timer });

      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].webContents.send(this.opts.requestChannel, { callId, ...payload });
      } else {
        this.pendingCalls.delete(callId);
        clearTimeout(timer);
        resolve({ success: false, error: 'No renderer window available' });
      }
    });
  }

  /**
   * Register the IPC handler that receives results from the renderer.
   * Call once during initialization. Idempotent.
   */
  registerHandler(): void {
    if (this.handlerRegistered) return;
    this.handlerRegistered = true;

    ipcMain.on(this.opts.resultChannel, (_event, payload: { callId: string; result: BridgeResult }) => {
      const pending = this.pendingCalls.get(payload.callId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCalls.delete(payload.callId);
        pending.resolve(payload.result);
      }
    });

    appLog('core:mcp', 'info', `Process bridge registered: ${this.opts.logTag}`);
  }

  /** For testing: clear all pending calls and reset counter. */
  _resetForTesting(): void {
    for (const [, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
    }
    this.pendingCalls.clear();
    this.callIdCounter = 0;
  }
}
