/**
 * Main-process end of renderer telemetry (spec §6.2).
 *
 * - `telemetry:emit`: batches from renderer facades. Every item is re-parsed
 *   against the attribute registry (renderer-protocol.ts) and tagged with the
 *   sending window's kind by main, never by the renderer.
 * - `telemetry:get-state` / `telemetry:state-changed`: tell renderers whether
 *   to record anything at all, so a disabled build pays no IPC cost.
 * - `telemetry:renderer-ready`: the main window's initApp() finished. Phase 3b
 *   ends the startup span on it; other code can subscribe with onRendererReady.
 *
 * No OpenTelemetry imports: this file is part of the main bundle.
 */
import type { WebContents } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { ATTR, type TelAttr } from '../../shared/telemetry/attributes';
import {
  DISABLED_STATE,
  parseRendererBatch,
  type RendererItem,
  type TelemetryState,
} from '../../shared/telemetry/renderer-protocol';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { getRuntime, isPending, onRuntimeChange, replaySpan, tel } from './facade';
import { ForwardedError } from './types';

export type WindowKind = 'main' | 'popout';

export interface RendererBridgeDeps {
  /** webContents id of the main window, if it exists. */
  getMainWebContentsId: () => number | undefined;
  /** Configured level while the SDK is still loading (no runtime yet). */
  getConfiguredLevel: () => TelemetryState['level'];
}

let deps: RendererBridgeDeps | null = null;
let registered = false;
let rendererReadyAt: number | null = null;
const readyListeners = new Set<(atMs: number) => void>();

export function windowKindFor(sender: Pick<WebContents, 'id'>): WindowKind {
  return deps && sender.id === deps.getMainWebContentsId() ? 'main' : 'popout';
}

export function getTelemetryState(): TelemetryState {
  const rt = getRuntime();
  if (rt) return { enabled: true, level: rt.level };
  if (isPending()) {
    const level = deps?.getConfiguredLevel() ?? null;
    return level ? { enabled: true, level } : DISABLED_STATE;
  }
  return DISABLED_STATE;
}

export function broadcastTelemetryState(): void {
  broadcastToAllWindows(IPC.TELEMETRY.STATE_CHANGED, getTelemetryState());
}

/** Feed parsed renderer items into the facade. Exported for tests. */
export function dispatchRendererItems(items: RendererItem[], kind: WindowKind): void {
  const tag: TelAttr[] = [ATTR.process('renderer'), ATTR.windowKind(kind)];
  for (const item of items) {
    try {
      switch (item.t) {
        case 'span':
          replaySpan({
            name: item.name,
            startMs: item.startMs,
            endMs: item.endMs,
            attrs: [...item.attrs, ...tag],
            outcome: item.outcome,
            errorType: item.errorType,
          });
          break;
        case 'count':
          // Metric dimensions are restricted by the registry; the window kind
          // is only kept where the metric declares it.
          tel.count(item.name, item.value, [...item.attrs, ATTR.windowKind(kind)]);
          break;
        case 'event':
          tel.event(item.name, [...item.attrs, ...tag]);
          break;
        case 'exception':
          tel.exception(new ForwardedError(item.errorType, item.stack), {
            origin: item.origin,
            handled: item.handled,
            attrs: [...item.attrs, ...tag],
          });
          break;
      }
    } catch {
      // A malformed item must never break the IPC handler.
    }
  }
}

/** Called once the main window's renderer finished initApp(). */
export function onRendererReady(listener: (atMs: number) => void): () => void {
  if (rendererReadyAt !== null) listener(rendererReadyAt);
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

export function getRendererReadyAt(): number | null {
  return rendererReadyAt;
}

/** Handle one `telemetry:emit` batch from a renderer. */
export function handleRendererEmit(sender: Pick<WebContents, 'id'>, raw: unknown): void {
  // Cheap exit while disabled: renderers shouldn't send, but never trust that.
  if (!getRuntime() && !isPending()) return;
  dispatchRendererItems(parseRendererBatch(raw), windowKindFor(sender));
}

/** Handle `telemetry:renderer-ready`: main window only, first one wins. */
export function handleRendererReady(sender: Pick<WebContents, 'id'>): void {
  if (windowKindFor(sender) !== 'main' || rendererReadyAt !== null) return;
  rendererReadyAt = Date.now();
  for (const l of readyListeners) {
    try {
      l(rendererReadyAt);
    } catch {
      // Listeners must not break the handler.
    }
  }
}

/**
 * Wire the bridge's dependencies and start broadcasting state changes. The
 * IPC registrations themselves live in src/main/ipc/telemetry-renderer-handlers.ts.
 */
export function initRendererBridge(bridgeDeps: RendererBridgeDeps): void {
  deps = bridgeDeps;
  if (registered) return;
  registered = true;
  onRuntimeChange(broadcastTelemetryState);
}

/** Test-only reset. */
export function _resetRendererBridgeForTests(): void {
  deps = null;
  registered = false;
  rendererReadyAt = null;
  readyListeners.clear();
}
