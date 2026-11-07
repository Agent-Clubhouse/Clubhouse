/**
 * What Auto keeps between decisions (#2887): a reservation per decision until
 * its start settles, and the rotation cursor for each set of tied providers.
 * Every function here is synchronous, so none is ever seen half done. Reserve
 * and commit run under start_helper's start lock. Settle runs when a background
 * start ends, outside the lock, as its own turn of the event loop. A count reads
 * the helpers' statuses and then the reservations in one synchronous pass after
 * its last await, so a settle lands wholly before that pass or wholly after it:
 * see {@link reservedLoad} for why both orders count a helper exactly once.
 *
 * Reservations are in memory and don't expire. One counts as load until it is
 * reconciled: its helper seen live in a count, after which the row counts it, or
 * an outcome confirming it isn't running (refused, cancelled, failed, left
 * asleep, seen not running), or agent-config accepting a change that ends it as
 * a helper (disposed, deleted, removed from the list, released) into its config
 * cache, whichever surface asked. That is the cached change, not a finished disk
 * write. A count that doesn't see the helper's row at all keeps counting the
 * reservation: a missing row proves nothing. A restart loses them, which is safe:
 * a quit interrupts every creation and start, live helpers are counted again
 * from their rows, and an interrupted creation is marked failed at launch
 * (agent-config's recovery), so nothing is counted twice.
 *
 * The rotation is saved so a restart doesn't hand the next tie to the first
 * provider. It moves only when a decision commits, once the helper exists, so a
 * refused start doesn't take a provider's turn. Within a run it is exact, from
 * memory, whatever the disk does. Across restarts it is best-effort history: a
 * failed or unflushed write, an evicted set or an unreadable file brings back an
 * older cursor or none. Within a run, decisions the rotation alone settled for
 * one tie set (every member tied on load too) are a round robin from wherever it
 * started, so their counts differ by at most one. Across R restarts, whatever
 * each restored, by at most R + 1.
 */

import type { HelperSpawnResult } from '../../shared/telemetry/helper-usage-contract';
import { appLog } from './log-service';
import { createSettingsStore } from './settings-store';

// ── Rotation ─────────────────────────────────────────────────────────────

interface RotationFile {
  version: 1;
  /** By tie set key: the key chosen last, and when. */
  cursors: Record<string, { key: string; at: number }>;
}

/** Tie sets are a handful of providers. This only bounds a file nobody prunes. */
export const AUTO_MAX_ROTATION_CURSORS = 64;

const rotationStore = createSettingsStore<RotationFile>('helper-auto-rotation.json', { version: 1, cursors: {} }, (raw) => {
  const cursors: RotationFile['cursors'] = {};
  const stored = raw.cursors;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [set, value] of Object.entries(stored as Record<string, unknown>)) {
      const { key, at } = (value ?? {}) as { key?: unknown; at?: unknown };
      if (typeof key === 'string' && typeof at === 'number' && Number.isFinite(at)) cursors[set] = { key, at };
    }
  }
  return { version: 1, cursors };
});

/** The last key chosen for each tie set. */
/** This run's rotation: what was saved, read once, then kept here. The saved file only carries it across a restart. */
let rotation: RotationFile['cursors'] | null = null;

function currentRotation(): RotationFile['cursors'] {
  return (rotation ??= { ...rotationStore.get().cursors });
}

export function rotationCursors(): Record<string, string> {
  return Object.fromEntries(Object.entries(currentRotation()).map(([set, { key }]) => [set, key]));
}

function commitRotation(cursorKey: string, key: string, now: number): void {
  const cursors = { ...currentRotation(), [cursorKey]: { key, at: now } };
  rotation = Object.fromEntries(Object.entries(cursors).sort((a, b) => b[1].at - a[1].at).slice(0, AUTO_MAX_ROTATION_CURSORS));
  // This run's value is set above; the write is queued, and a failed one leaves it in place. Every save's failure is handled here.
  rotationStore.save({ version: 1, cursors: rotation }).catch((err: unknown) => {
    // telemetry-exempt: logged; this run is unaffected, and a restart reads older history (see the header)
    appLog('core:mcp', 'warn', 'Auto: could not save the rotation', { meta: { error: err instanceof Error ? err.name : 'unknown' } });
  });
}

// ── Reservations ─────────────────────────────────────────────────────────

interface Reservation {
  provider: string;
  /** Provider: see AutoCandidate.key. */
  key: string;
  at: number;
  helperId?: string;
  /** The rotation this decision takes, saved when it commits. */
  rotation?: { cursorKey: string; key: string };
  /** It started: kept, and counted, until a count sees it live or not running. */
  started?: true;
}

const reservations = new Map<string, Reservation>();

/** Hold a provider for a decision, before its helper exists. */
export function reserveAutoDecision(decisionId: string, reservation: { provider: string; key: string; rotation?: { cursorKey: string; key: string } }, now = Date.now()): void {
  reservations.set(decisionId, { ...reservation, at: now });
}

/** The helper exists: the decision commits, and its rotation is saved. */
export function commitAutoDecision(decisionId: string, helperId: string, now = Date.now()): void {
  const reservation = reservations.get(decisionId);
  if (!reservation || reservation.helperId) return;
  reservation.helperId = helperId;
  if (reservation.rotation) commitRotation(reservation.rotation.cursorKey, reservation.rotation.key, now);
}

/**
 * A start reached its end. `started` is kept until a count has seen the helper,
 * so there's no moment it's counted neither as live nor reserved. Anything else
 * confirms it isn't running, and is released at once. A second call does nothing
 * to a released one.
 */
export function settleAutoDecision(decisionId: string, result: HelperSpawnResult): void {
  const reservation = reservations.get(decisionId);
  if (!reservation) return;
  if (result === 'started' && reservation.helperId) reservation.started = true;
  else reservations.delete(decisionId);
}

/** The decision a helper's reservation belongs to, if it has one still held. */
export function autoDecisionFor(helperId: string): string | undefined {
  for (const [decisionId, reservation] of reservations) if (reservation.helperId === helperId) return decisionId;
  return undefined;
}

/** A helper agent-config has just written as no longer a live helper: whatever it held is released. */
export function forgetAutoHelper(helperId: string): void {
  for (const [decisionId, reservation] of reservations) if (reservation.helperId === helperId) reservations.delete(decisionId);
}

/** What one count saw: helpers it counted live, and helpers whose rows it saw not running. */
export interface HelperSnapshot {
  live: ReadonlySet<string>;
  notRunning: ReadonlySet<string>;
}

/**
 * Reservations per provider that the snapshot doesn't already count. Call it in
 * the same synchronous pass that read the statuses. Each reservation is:
 * - seen live: the row counts it, so it doesn't. A started one is reconciled and
 *   released here.
 * - seen not running: a started one is released, since it ran and stopped. One
 *   still starting counts, because its start hasn't ended.
 * - not seen at all, or not yet a helper: it counts.
 *
 * A settle after the pass finds the reservation counted or skipped by the rule
 * above; a settle before it has either released it (an end that isn't running)
 * or marked it started, which the pass reconciles. Either way, once.
 */
export function reservedLoad(snapshot: HelperSnapshot): Record<string, number> {
  const load: Record<string, number> = {};
  for (const [decisionId, reservation] of reservations) {
    const id = reservation.helperId;
    if (id && snapshot.live.has(id)) {
      if (reservation.started) reservations.delete(decisionId);
      continue;
    }
    if (id && reservation.started && snapshot.notRunning.has(id)) {
      reservations.delete(decisionId);
      continue;
    }
    load[reservation.provider] = (load[reservation.provider] ?? 0) + 1;
  }
  return load;
}

/** Reservations held, those started and not yet reconciled, and the oldest one's age, for a decision's record. Never dropped by age. */
export function reservationSummary(now = Date.now()): { held: number; startedPending: number; oldestAgeMs?: number } {
  const held = [...reservations.values()];
  return {
    held: held.length,
    startedPending: held.filter((r) => r.started).length,
    ...(held.length > 0 && { oldestAgeMs: now - Math.min(...held.map((r) => r.at)) }),
  };
}

/** For testing. */
export function _resetHelperAutoStateForTesting(): void {
  reservations.clear();
  // In memory only: a test reset writes nothing, so it leaves no save to settle or fail.
  rotation = {};
}
