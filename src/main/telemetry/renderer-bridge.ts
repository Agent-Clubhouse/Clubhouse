/**
 * Main-process end of renderer telemetry (spec §6.2).
 *
 * - `telemetry:emit`: batches from renderer facades. Every item is re-parsed
 *   against the attribute registry (renderer-protocol.ts) and tagged with the
 *   sending window's kind by main, never by the renderer. `diag` items
 *   (local-only diagnostic lines, #2299) go to diag.ts, never the facade,
 *   and are rate-limited per window.
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
  parseRendererReadyMarks,
  type RendererReadyMarks,
  type RendererItem,
  type TelemetryState,
} from '../../shared/telemetry/renderer-protocol';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { diagFromRenderer, isDiagActive, noteDiagDropped, onDiagSinkChange } from './diag';
import { exportsWithoutLocalRecording, getLocalSink, getRuntime, isPending, onRuntimeChange, replaySpan, tel } from './facade';
import { ForwardedError } from './types';

export type WindowKind = 'main' | 'popout';

/** Renderer diag items accepted per window per rate window; the rest are dropped and counted. */
export const DIAG_RATE_MAX = 500;
export const DIAG_RATE_WINDOW_MS = 10_000;

export interface RendererBridgeDeps {
  /** webContents id of the main window, if it exists. */
  getMainWebContentsId: () => number | undefined;
  /** Configured level while the SDK is still loading (no runtime yet). */
  getConfiguredLevel: () => TelemetryState['level'];
}

let deps: RendererBridgeDeps | null = null;
let registered = false;
let rendererReadyAt: number | null = null;
let rendererReadyMarks: RendererReadyMarks = {};
const readyListeners = new Set<(atMs: number, marks: RendererReadyMarks) => void>();
/** Per webContents id: the current rate window's start and the diag items taken in it. */
const diagRates = new Map<number, { start: number; count: number }>();

export function windowKindFor(sender: Pick<WebContents, 'id'>): WindowKind {
  return deps && sender.id === deps.getMainWebContentsId() ? 'main' : 'popout';
}

/**
 * What renderers record (spec §6.12 parity). With local recording on,
 * renderers produce at its level whatever the export state; each exporter
 * filters down. With it off, producers stay off, and `tel.*` calls go to a
 * running exporter at its level only when the policy allows it.
 */
export function getTelemetryState(): TelemetryState {
  const state = signalState();
  return isDiagActive() ? { ...state, diag: true } : state;
}

function signalState(): TelemetryState {
  const local = getLocalSink();
  if (local) return { enabled: true, level: local.level, producers: true };
  if (!exportsWithoutLocalRecording()) return DISABLED_STATE;
  const rt = getRuntime();
  const level = rt ? rt.level : isPending() ? deps?.getConfiguredLevel() ?? null : null;
  return level ? { enabled: true, level, producers: false } : DISABLED_STATE;
}

export function broadcastTelemetryState(): void {
  broadcastToAllWindows(IPC.TELEMETRY.STATE_CHANGED, getTelemetryState());
}

/** Take up to `n` diag items from this window's rate budget; returns how many may pass. */
function takeDiagRate(senderId: number, n: number, nowMs = Date.now()): number {
  let rate = diagRates.get(senderId);
  if (!rate || nowMs - rate.start >= DIAG_RATE_WINDOW_MS) {
    if (diagRates.size >= 64) {
      for (const [id, r] of diagRates) if (nowMs - r.start >= DIAG_RATE_WINDOW_MS) diagRates.delete(id);
    }
    rate = { start: nowMs, count: 0 };
    diagRates.set(senderId, rate);
  }
  const take = Math.max(0, Math.min(n, DIAG_RATE_MAX - rate.count));
  rate.count += take;
  return take;
}

/**
 * Feed parsed renderer items into the facade, and diag items into diag.ts
 * (local only). Signal items pass only while `signals` is on. Exported for tests.
 */
export function dispatchRendererItems(items: RendererItem[], kind: WindowKind, signals = true): void {
  const tag: TelAttr[] = [ATTR.process('renderer'), ATTR.windowKind(kind)];
  for (const item of items) {
    try {
      if (item.t === 'diag') {
        diagFromRenderer({ ns: item.ns, level: item.level, msg: item.msg, meta: item.meta }, kind);
        continue;
      }
      if (!signals) continue;
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
export function onRendererReady(listener: (atMs: number, marks: RendererReadyMarks) => void): () => void {
  if (rendererReadyAt !== null) listener(rendererReadyAt, rendererReadyMarks);
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

export function getRendererReadyAt(): number | null {
  return rendererReadyAt;
}

/** Handle one `telemetry:emit` batch from a renderer. */
export function handleRendererEmit(sender: Pick<WebContents, 'id'>, raw: unknown): void {
  // Cheap exit while disabled: renderers shouldn't send, but never trust that.
  const state = getTelemetryState();
  if (!state.enabled && !state.diag) return;
  let items = parseRendererBatch(raw);
  if (items.some((i) => i.t === 'diag')) {
    const diagCount = state.diag ? items.filter((i) => i.t === 'diag').length : 0;
    let allowed = takeDiagRate(sender.id, diagCount);
    noteDiagDropped(diagCount - allowed);
    // Keep the first `allowed` diag items; drop every diag item while diag is off.
    items = items.filter((i) => i.t !== 'diag' || allowed-- > 0);
  }
  dispatchRendererItems(items, windowKindFor(sender), state.enabled);
}

/** Handle `telemetry:renderer-ready`: main window only, first one wins. */
export function handleRendererReady(sender: Pick<WebContents, 'id'>, rawMarks?: unknown): void {
  if (windowKindFor(sender) !== 'main' || rendererReadyAt !== null) return;
  rendererReadyAt = Date.now();
  rendererReadyMarks = parseRendererReadyMarks(rawMarks);
  for (const l of readyListeners) {
    try {
      l(rendererReadyAt, rendererReadyMarks);
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
  onDiagSinkChange(broadcastTelemetryState);
}

/** Test-only reset. */
export function _resetRendererBridgeForTests(): void {
  deps = null;
  registered = false;
  rendererReadyAt = null;
  rendererReadyMarks = {};
  readyListeners.clear();
  diagRates.clear();
}
