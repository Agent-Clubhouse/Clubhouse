/**
 * Detailed-level IPC latency (spec §3.3, Phase 6b): one `clubhouse.ipc.invoke`
 * span per renderer invoke, named by channel from the fixed IPC constants.
 *
 * Installed once at startup by wrapping `ipcMain.handle`, so every handler
 * registered afterwards is timed. Telemetry's own renderer handlers register
 * just before it and are deliberately left untimed. Below the Detailed level
 * the wrapper is a level check and a direct call. Arguments and results are
 * never recorded.
 *
 * The span is replayed with explicit times rather than run as a flow: a
 * rejected invoke is the handler's answer to the renderer, not an unhandled
 * crash, so it gets an error outcome but no `clubhouse.exception` record, and
 * a long async invoke is never named by the event-loop watchdog as the flow
 * that blocked the main thread.
 *
 * No OpenTelemetry imports: part of the main bundle.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { ATTR } from '../../shared/telemetry/attributes';
import { replaySpan, telemetryLevel } from './facade';
import { errorTypeOf } from './types';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

let installed = false;

function record(attrs: ReturnType<typeof ATTR.ipcChannel>[], startMs: number, error?: unknown, failed = false): void {
  replaySpan({
    name: 'clubhouse.ipc.invoke',
    startMs,
    endMs: Math.max(Date.now(), startMs),
    attrs,
    outcome: failed ? 'error' : 'ok',
    errorType: failed ? errorTypeOf(error) : undefined,
  });
}

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return !!v && typeof (v as { then?: unknown }).then === 'function';
}

/** Wrap a handler so Detailed-level telemetry times each invoke. Exported for tests. */
export function timedHandler(channel: string, listener: Listener): Listener {
  const attrs = [ATTR.ipcChannel(channel)];
  return (event, ...args) => {
    if (telemetryLevel() !== 'detailed') return listener(event, ...args);
    const startMs = Date.now();
    let result: unknown;
    try {
      result = listener(event, ...args);
    } catch (err) {
      record(attrs, startMs, err, true);
      throw err;
    }
    if (isPromiseLike(result)) {
      // Observe without changing what the renderer receives.
      Promise.resolve(result).then(() => record(attrs, startMs), (err) => record(attrs, startMs, err, true));
      return result;
    }
    record(attrs, startMs);
    return result;
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
