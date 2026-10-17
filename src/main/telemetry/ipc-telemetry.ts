/**
 * Detailed-level IPC latency (spec §3.3, Phase 6b): one `clubhouse.ipc.invoke`
 * span per renderer invoke, named by channel from the fixed IPC constants.
 *
 * Installed once, before any handler registers, by wrapping `ipcMain.handle`.
 * Below the Detailed level the wrapper is a level check and a direct call.
 * Arguments and results are never recorded.
 *
 * No OpenTelemetry imports: part of the main bundle.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { ATTR } from '../../shared/telemetry/attributes';
import { tel, telemetryLevel } from './facade';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

let installed = false;

/** Wrap a handler so Detailed-level telemetry times each invoke. Exported for tests. */
export function timedHandler(channel: string, listener: Listener): Listener {
  const attrs = [ATTR.ipcChannel(channel)];
  return (event, ...args) => {
    if (telemetryLevel() !== 'detailed') return listener(event, ...args);
    return tel.flow('clubhouse.ipc.invoke', { attrs }, () => listener(event, ...args));
  };
}

/** Wrap `ipc.handle` so every handler registered afterwards is timed. Call once at startup. */
export function installIpcTelemetry(ipc: Pick<IpcMain, 'handle'>): void {
  if (installed) return;
  installed = true;
  const original = ipc.handle.bind(ipc);
  ipc.handle = (channel: string, listener: Listener) => original(channel, timedHandler(channel, listener));
}

/** Test-only reset. */
export function _resetIpcTelemetryForTests(): void {
  installed = false;
}
