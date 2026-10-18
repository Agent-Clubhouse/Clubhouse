/**
 * Recent app events for feedback reports (#2098). Framebriar reports carry up
 * to 40 breadcrumbs `{ kind, atMs, code, value? }`; this keeps the latest of
 * each kind so a report sent after a hang, a failed chat start or a crash
 * shows what led up to it, even with telemetry export off.
 *
 * Codes are fixed strings plus bounded values (a view, a provider id), never
 * user text, paths or messages: anything outside CODE_PATTERN is dropped.
 * Each kind has its own budget so a run of view changes can't push out the
 * error that matters.
 */

export type BreadcrumbKind = 'error' | 'performance' | 'event';

export interface Breadcrumb {
  kind: BreadcrumbKind;
  /** When it happened, in epoch milliseconds (`Date.now()`), so it lines up with log and telemetry timestamps. */
  atMs: number;
  code: string;
  value?: number;
}

/** The SDK's per-report limit. */
export const MAX_BREADCRUMBS = 40;
export const KIND_BUDGET: Record<BreadcrumbKind, number> = { error: 15, performance: 15, event: 20 };
export const CODE_PATTERN = /^[a-z0-9_.:-]{1,60}$/;
const KINDS = new Set<BreadcrumbKind>(['error', 'performance', 'event']);

let clock: () => number = () => Date.now();
const rings: Record<BreadcrumbKind, Breadcrumb[]> = { error: [], performance: [], event: [] };
let lastViewCode: string | null = null;

/** A code segment from a bounded value (a provider or driver id): lower-cased, anything else becomes `_`. */
export function codePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 30) || 'unknown';
}

/** Record one breadcrumb, stamped with the epoch ms now. Returns false (and records nothing) for an unknown kind or a code outside the pattern. */
export function recordBreadcrumb(kind: BreadcrumbKind, code: string, value?: number): boolean {
  if (!KINDS.has(kind) || typeof code !== 'string' || !CODE_PATTERN.test(code)) return false;
  // A view change repeated (a re-render, a second report of the same view) adds nothing.
  if (code.startsWith('view.')) {
    if (code === lastViewCode) return true;
    lastViewCode = code;
  }
  const ring = rings[kind];
  ring.push({ kind, atMs: Math.max(0, clock()), code, ...(typeof value === 'number' && Number.isFinite(value) && { value }) });
  if (ring.length > KIND_BUDGET[kind]) ring.shift();
  return true;
}

/** Validate and record a breadcrumb that arrived as untyped data (a renderer log entry's meta). */
export function recordBreadcrumbFrom(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const { kind, code, value } = raw as { kind?: unknown; code?: unknown; value?: unknown };
  return recordBreadcrumb(kind as BreadcrumbKind, code as string, typeof value === 'number' ? value : undefined);
}

/** The latest breadcrumbs across kinds, newest first, at most MAX_BREADCRUMBS. */
export function recentBreadcrumbs(): Breadcrumb[] {
  return [...rings.error, ...rings.performance, ...rings.event]
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, MAX_BREADCRUMBS)
    .map((b) => ({ ...b }));
}

/** Test hooks. */
export function _resetBreadcrumbsForTests(now?: () => number): void {
  rings.error = [];
  rings.performance = [];
  rings.event = [];
  lastViewCode = null;
  clock = now ?? (() => Date.now());
}
