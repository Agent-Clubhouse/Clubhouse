/**
 * Renderer hang and lag log (#2126). Always on, whether or not telemetry is.
 *
 * - One `long-animation-frame` observer (falling back to `longtask`). Every
 *   long frame goes to the telemetry aggregate (long-frames.ts, a no-op while
 *   telemetry is off); frames at or over the hang threshold also go to the
 *   local log as `ui:perf` lines and, with telemetry on, as `clubhouse.ui.hang`.
 * - One Event Timing observer for interactions (input to next paint). With
 *   telemetry on each interaction feeds `clubhouse.ui.interaction.duration`;
 *   slow ones are logged locally like hangs and, with telemetry on, sent as
 *   `clubhouse.ui.slow_interaction` (#2307). The target id stays in the local line.
 * - Capture-phase pointerdown / keydown / wheel listeners remember the last
 *   interaction: its type and a stable target id (`data-testid` or
 *   `data-tree-key`), never text. Keys are named only for non-character keys.
 *
 * Bursts coalesce: everything within COALESCE_MS of the first entry becomes
 * one line, and at most MAX_LINES_PER_MINUTE lines are written, the rest
 * counted as `suppressed` on the next one. Each line is one log write, so a
 * storm of frames never becomes a storm of IPC.
 *
 * Idle cost: two PerformanceObservers that only fire for frames of 50 ms and
 * over or interactions of 16 ms and over, and three passive capture listeners
 * that store a small object per input.
 */
import { ATTR } from '../../shared/telemetry/attributes';
import { tel, diag, isTelemetryEnabled } from './facade';
import { recordBreadcrumb } from './breadcrumbs';
import { getTelemetrySurface, getTelemetryView, recordLongFrame, surfaceAttrs, type TelemetrySurface, type TelemetryView } from './long-frames';

export const UI_PERF_NS = 'ui:perf';
export const DEFAULT_HANG_THRESHOLD_MS = 200;
/** Overrides the hang and slow-interaction threshold (ms, 50 or more). */
export const HANG_THRESHOLD_STORAGE_KEY = 'clubhouse.uiPerf.hangMs';
export const COALESCE_MS = 1000;
export const MAX_LINES_PER_MINUTE = 6;
/** An interaction older than this when a burst starts isn't blamed for it. */
export const INTERACTION_WINDOW_MS = 5000;
export const MAX_SCRIPTS = 3;
const MAX_TARGET_CHARS = 80;
/** Event Timing's minimum. Faster interactions aren't reported by the browser. */
const EVENT_DURATION_THRESHOLD_MS = 16;
/** `KeyboardEvent.key` names such as Enter, Escape, ArrowUp, F5; never a typed character. */
const NAMED_KEY = /^[A-Z][A-Za-z0-9]+$/;

export type InteractionType = 'click' | 'keydown' | 'wheel';

export interface LastInteraction {
  type: InteractionType;
  /** `data-testid`, `tree:<data-tree-key>`, or the tag name. Never text. */
  target: string;
  /** Named keys only (Enter, Escape, ArrowUp...), never a character. */
  key?: string;
  at: number;
}

export interface ScriptAttribution {
  invoker?: string;
  invokerType?: string;
  fn?: string;
  /** `scheme:basename`, or `clubhouse-plugin://<id>/…/file` for plugins; never a full path. */
  source?: string;
  ms: number;
}

type ScriptSource = 'app' | 'plugin' | 'extension' | 'none';
type PerfKind = 'long_frame' | 'slow_interaction';

interface Burst {
  kind: PerfKind;
  firstAt: number;
  count: number;
  maxMs: number;
  totalMs: number;
  view: TelemetryView;
  surface: TelemetrySurface | null;
  interaction: LastInteraction | null;
  scripts: ScriptAttribution[];
  scriptSource: ScriptSource;
  /** Slow interactions: the Event Timing type of the slowest one in the burst. */
  interactionType: InteractionType | null;
}

export interface UiPerfLine {
  msg: string;
  meta: Record<string, unknown>;
}

type Sink = (line: UiPerfLine) => void;

// The diag tier (#2302), plus the legacy log for its writer and the feedback breadcrumb tap (#2303).
const defaultSink: Sink = (line) => {
  diag(UI_PERF_NS, 'warn', line.msg, line.meta);
  try {
    window.clubhouse?.log?.write({ ts: new Date().toISOString(), ns: UI_PERF_NS, level: 'warn', msg: line.msg, meta: line.meta });
  } catch {
    // The hang log must never throw into the page.
  }
};

let sink: Sink = defaultSink;
let threshold = DEFAULT_HANG_THRESHOLD_MS;
let lastInteraction: LastInteraction | null = null;
const bursts = new Map<PerfKind, Burst>();
const timers = new Map<PerfKind, ReturnType<typeof setTimeout>>();
let lineTimes: number[] = [];
let suppressed = 0;
let frameObserver: PerformanceObserver | null = null;
let eventObserver: PerformanceObserver | null = null;
let removeListeners: (() => void) | null = null;
/** Interaction ids already measured, so an interaction split across callbacks counts once. */
const seenInteractions: number[] = [];

export function getHangThresholdMs(): number {
  return threshold;
}

function readThreshold(): number {
  try {
    const raw = Number(globalThis.localStorage?.getItem(HANG_THRESHOLD_STORAGE_KEY));
    if (Number.isFinite(raw) && raw >= 50) return raw;
  } catch {
    // No storage: keep the default.
  }
  return DEFAULT_HANG_THRESHOLD_MS;
}

/** A stable id for what was interacted with. Never text content. */
export function targetIdOf(el: Element | null): string {
  if (!el) return 'none';
  const tagged = el.closest?.('[data-testid],[data-tree-key]');
  if (tagged) {
    const testId = tagged.getAttribute('data-testid');
    const id = testId ?? `tree:${tagged.getAttribute('data-tree-key') ?? ''}`;
    return id.slice(0, MAX_TARGET_CHARS);
  }
  return el.tagName ? el.tagName.toLowerCase() : 'none';
}

/** Record an input as the last interaction. Exported for tests. */
export function noteInteraction(type: InteractionType, target: EventTarget | null, key?: string, at = performance.now()): void {
  const el = target instanceof Element ? target : null;
  // A character key (including an emoji) would leak what was typed; only named keys are kept.
  const named = key && NAMED_KEY.test(key) ? key : undefined;
  lastInteraction = { type, target: targetIdOf(el), ...(named && { key: named }), at };
}

export function getLastInteraction(): LastInteraction | null {
  return lastInteraction;
}

/** `scheme:basename` of a script URL; plugins keep their id. Exported for tests. */
export function scrubScriptUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').filter(Boolean).pop() ?? '';
    if (u.protocol === 'clubhouse-plugin:') return `clubhouse-plugin://${u.host}/…/${base}`;
    return `${u.protocol}${base}`;
  } catch {
    return undefined;
  }
}

/** Whose script a URL is, for telemetry. Exported for tests. */
export function scriptSourceOf(url: string | undefined): ScriptSource {
  if (!url) return 'none';
  if (url.startsWith('clubhouse-plugin:') || /[\\/]\.clubhouse[\\/]plugins[\\/]/.test(url)) return 'plugin';
  if (url.startsWith('chrome-extension:') || url.startsWith('devtools:')) return 'extension';
  return 'app';
}

/**
 * For classic-script and module-script entries the LoAF invoker is the
 * script's URL, so it gets the same scrubbing as sourceURL. Exported for tests.
 */
export function scrubInvoker(invoker: string, invokerType?: string): string {
  if (invokerType?.endsWith('-script') || /^[a-z][a-z0-9+.-]*:\/\//i.test(invoker)) {
    return scrubScriptUrl(invoker) ?? 'script';
  }
  return invoker.slice(0, MAX_TARGET_CHARS);
}

interface LoafScript {
  invoker?: string;
  invokerType?: string;
  sourceFunctionName?: string;
  sourceURL?: string;
  duration?: number;
}

/** The LoAF entry's scripts, longest first. Exported for tests. */
export function scriptsOf(entry: { scripts?: readonly LoafScript[] }): { scripts: ScriptAttribution[]; source: ScriptSource } {
  const raw = [...(entry.scripts ?? [])].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
  const scripts = raw.slice(0, MAX_SCRIPTS).map((s) => ({
    ...(s.invoker && { invoker: scrubInvoker(s.invoker, s.invokerType) }),
    ...(s.invokerType && { invokerType: s.invokerType }),
    ...(s.sourceFunctionName && { fn: s.sourceFunctionName.slice(0, MAX_TARGET_CHARS) }),
    ...(scrubScriptUrl(s.sourceURL) && { source: scrubScriptUrl(s.sourceURL) }),
    ms: Math.round(s.duration ?? 0),
  }));
  return { scripts, source: scriptSourceOf(raw[0]?.sourceURL) };
}

function interactionAttr(i: LastInteraction | null) {
  return ATTR.uiInteractionType(i?.type ?? 'none');
}

function flush(kind: PerfKind, now = performance.now()): void {
  timers.delete(kind);
  const b = bursts.get(kind);
  bursts.delete(kind);
  if (!b) return;
  lineTimes = lineTimes.filter((t) => now - t < 60_000);
  // The cap covers clubhouse.ui.hang too: a hang storm sends at most six events a minute.
  if (lineTimes.length >= MAX_LINES_PER_MINUTE) {
    suppressed += b.count;
    return;
  }
  lineTimes.push(now);
  const blame = b.interaction && b.firstAt - b.interaction.at <= INTERACTION_WINDOW_MS && b.firstAt >= b.interaction.at ? b.interaction : null;
  const meta: Record<string, unknown> = {
    kind: b.kind,
    count: b.count,
    maxMs: Math.round(b.maxMs),
    totalMs: Math.round(b.totalMs),
    thresholdMs: threshold,
    view: b.view,
    ...(b.surface && { surface: b.surface }),
    ...(blame && {
      interaction: { type: blame.type, target: blame.target, ...(blame.key && { key: blame.key }), msBefore: Math.round(b.firstAt - blame.at) },
    }),
    ...(b.scripts.length > 0 && { scripts: b.scripts }),
    ...(suppressed > 0 && { suppressed }),
  };
  suppressed = 0;
  const what = b.kind === 'long_frame' ? (b.count === 1 ? 'Long frame' : 'Long frames') : (b.count === 1 ? 'Slow interaction' : 'Slow interactions');
  sink({ msg: `${what}: ${Math.round(b.maxMs)}ms in ${b.view}${b.surface ? `/${b.surface}` : ''}`, meta });
  recordBreadcrumb('performance', `ui.${b.kind}`, Math.round(b.maxMs));
  if (b.kind === 'long_frame') {
    tel.event('clubhouse.ui.hang', [
      ATTR.view(b.view),
      ...surfaceAttrs(b.surface),
      ATTR.uiHangDurationMs(b.maxMs),
      ATTR.uiHangFrames(b.count),
      ATTR.uiHangScriptSource(b.scriptSource),
      interactionAttr(blame),
    ]);
  } else {
    tel.event('clubhouse.ui.slow_interaction', [
      ATTR.view(b.view),
      ...surfaceAttrs(b.surface),
      ATTR.uiSlowInteractionDurationMs(b.maxMs),
      ATTR.uiSlowInteractionCount(b.count),
      ATTR.uiInteractionType(b.interactionType ?? blame?.type ?? 'none'),
    ]);
  }
}

function note(
  kind: PerfKind,
  ms: number,
  extra: { scripts?: ScriptAttribution[]; source?: ScriptSource; type?: InteractionType } = {},
  now = performance.now(),
): void {
  let b = bursts.get(kind);
  if (!b) {
    b = {
      kind, firstAt: now, count: 0, maxMs: 0, totalMs: 0,
      view: getTelemetryView(), surface: getTelemetrySurface(), interaction: lastInteraction,
      scripts: [], scriptSource: 'none', interactionType: null,
    };
    bursts.set(kind, b);
    timers.set(kind, setTimeout(() => flush(kind), COALESCE_MS));
  }
  b.count++;
  b.totalMs += ms;
  if (ms > b.maxMs) {
    b.maxMs = ms;
    if (extra.source) b.scriptSource = extra.source;
    if (extra.type) b.interactionType = extra.type;
  }
  if (extra.scripts?.length) {
    b.scripts = [...b.scripts, ...extra.scripts].sort((x, y) => y.ms - x.ms).slice(0, MAX_SCRIPTS);
  }
}

/** One long frame from the observer. Exported for tests. */
export function handleLongFrame(entry: { duration: number; scripts?: readonly LoafScript[] }): void {
  recordLongFrame(entry.duration);
  if (entry.duration < threshold) return;
  const { scripts, source } = scriptsOf(entry);
  note('long_frame', entry.duration, { scripts, source });
}

function interactionTypeOf(name: string): InteractionType | null {
  if (name.startsWith('key')) return 'keydown';
  if (name === 'wheel') return 'wheel';
  if (name === 'click' || name.startsWith('pointer') || name.startsWith('mouse')) return 'click';
  return null;
}

/** Event Timing entries from one observer callback. Exported for tests. */
export function handleEventEntries(entries: ReadonlyArray<{ name: string; duration: number; interactionId?: number }>): void {
  const byId = new Map<number, { name: string; duration: number }>();
  for (const e of entries) {
    if (!e.interactionId || seenInteractions.includes(e.interactionId)) continue;
    const prev = byId.get(e.interactionId);
    if (!prev || e.duration > prev.duration) byId.set(e.interactionId, { name: e.name, duration: e.duration });
  }
  for (const [id, { name, duration }] of byId) {
    seenInteractions.push(id);
    if (seenInteractions.length > 50) seenInteractions.shift();
    const type = interactionTypeOf(name);
    if (!type) continue;
    if (isTelemetryEnabled()) {
      tel.count('clubhouse.ui.interaction.duration', duration / 1000, [ATTR.view(getTelemetryView()), ...surfaceAttrs(), ATTR.uiInteractionType(type)]);
    }
    if (duration >= threshold) note('slow_interaction', duration, { type });
  }
}

function observe(type: string, cb: (list: PerformanceObserverEntryList) => void, extra: Record<string, unknown> = {}): PerformanceObserver | null {
  try {
    const o = new PerformanceObserver(cb);
    o.observe({ type, buffered: false, ...extra } as PerformanceObserverInit);
    return o;
  } catch {
    return null;
  }
}

/** Start the observers and listeners. Safe to call more than once. */
export function startUiPerf(): void {
  if (removeListeners) return;
  threshold = readThreshold();

  const onPointer = (e: Event) => noteInteraction('click', e.target);
  const onKey = (e: Event) => noteInteraction('keydown', e.target, (e as KeyboardEvent).key);
  const onWheel = (e: Event) => noteInteraction('wheel', e.target);
  const opts = { capture: true, passive: true } as const;
  window.addEventListener('pointerdown', onPointer, opts);
  window.addEventListener('keydown', onKey, opts);
  window.addEventListener('wheel', onWheel, opts);
  removeListeners = () => {
    window.removeEventListener('pointerdown', onPointer, opts);
    window.removeEventListener('keydown', onKey, opts);
    window.removeEventListener('wheel', onWheel, opts);
  };

  if (typeof PerformanceObserver === 'undefined') return;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  const frameType = supported.includes('long-animation-frame') ? 'long-animation-frame' : supported.includes('longtask') ? 'longtask' : null;
  if (frameType) {
    frameObserver = observe(frameType, (list) => {
      for (const entry of list.getEntries()) handleLongFrame(entry as PerformanceEntry & { scripts?: LoafScript[] });
    });
  }
  if (supported.includes('event')) {
    eventObserver = observe('event', (list) => {
      handleEventEntries(list.getEntries() as unknown as Array<{ name: string; duration: number; interactionId?: number }>);
    }, { durationThreshold: EVENT_DURATION_THRESHOLD_MS });
  }
}

/** True while the long-frame observer is installed. Exported for tests. */
export function isObservingFrames(): boolean {
  return frameObserver !== null;
}

/** Test hooks. */
export function _setUiPerfSinkForTests(next: Sink | null): void {
  sink = next ?? defaultSink;
}

export function _flushUiPerfForTests(now?: number): void {
  for (const kind of [...bursts.keys()]) {
    const t = timers.get(kind);
    if (t) clearTimeout(t);
    flush(kind, now);
  }
}

export function _resetUiPerfForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  bursts.clear();
  removeListeners?.();
  removeListeners = null;
  frameObserver?.disconnect();
  frameObserver = null;
  eventObserver?.disconnect();
  eventObserver = null;
  lastInteraction = null;
  lineTimes = [];
  suppressed = 0;
  seenInteractions.length = 0;
  threshold = DEFAULT_HANG_THRESHOLD_MS;
  sink = defaultSink;
}
