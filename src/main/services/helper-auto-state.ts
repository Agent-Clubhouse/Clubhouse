/**
 * What Auto keeps between decisions (#2887): a reservation per decision until
 * its start settles, and the rotation cursor for each set of tied providers.
 * Every change here happens under start_helper's start lock, so two decisions
 * never see each other half done.
 *
 * Reservations are in memory and counted once: a reservation counts as load
 * only while its helper isn't already counted live. They don't expire. One is
 * released when its start reaches an end (refused, cancelled, failed, left
 * asleep), and a started one when the next count has seen it. A restart loses
 * them, which is safe: a quit interrupts every creation and start, live helpers
 * are counted again from their rows, and an interrupted creation is marked failed
 * at launch (agent-config's recovery), so nothing is counted twice.
 *
 * The cursor is saved so a restart doesn't hand the next tie to the first
 * provider again. It moves only when a decision commits, that is once the helper
 * exists, so a refused start doesn't take a provider's turn. If the save fails
 * this run keeps rotating from memory; after a restart the cursor is the last
 * one saved, and at most one turn repeats per tie set.
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

/** Tie sets are a handful of providers under a handful of profiles. This only bounds a file nobody prunes. */
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
export function rotationCursors(): Record<string, string> {
  return Object.fromEntries(Object.entries(rotationStore.get().cursors).map(([set, { key }]) => [set, key]));
}

function commitRotation(cursorKey: string, key: string, now: number): void {
  const cursors = { ...rotationStore.get().cursors, [cursorKey]: { key, at: now } };
  const kept = Object.entries(cursors).sort((a, b) => b[1].at - a[1].at).slice(0, AUTO_MAX_ROTATION_CURSORS);
  // In memory at once; the write is queued. A failed write leaves this run's value in place.
  rotationStore.save({ version: 1, cursors: Object.fromEntries(kept) }).catch((err: unknown) => {
    // telemetry-exempt: logged; the cost is at most one repeated turn after a restart
    appLog('core:mcp', 'warn', 'Auto: could not save the rotation', { meta: { error: err instanceof Error ? err.name : 'unknown' } });
  });
}

// ── Reservations ─────────────────────────────────────────────────────────

interface Reservation {
  provider: string;
  /** Provider and profile: see AutoCandidate.key. */
  key: string;
  at: number;
  helperId?: string;
  /** The rotation this decision takes, saved when it commits. */
  rotation?: { cursorKey: string; key: string };
  /** It started: dropped at the next count, which sees it live or not running. */
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
 * is released at once. Each decision settles once; a second call does nothing.
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

/**
 * Reservations per provider, leaving out any whose helper is in `liveIds`,
 * since that one is already counted. A started reservation is dropped here, once
 * this count has it either way.
 */
export function reservedLoad(liveIds: ReadonlySet<string>): Record<string, number> {
  const load: Record<string, number> = {};
  for (const [decisionId, reservation] of reservations) {
    const live = !!reservation.helperId && liveIds.has(reservation.helperId);
    if (reservation.started) reservations.delete(decisionId);
    if (live || reservation.started) continue;
    load[reservation.provider] = (load[reservation.provider] ?? 0) + 1;
  }
  return load;
}

/** How many reservations are held, and the oldest one's age, for a decision's record. Never dropped by age. */
export function reservationSummary(now = Date.now()): { held: number; oldestAgeMs?: number } {
  const held = [...reservations.values()].filter((r) => !r.started);
  return { held: held.length, ...(held.length > 0 && { oldestAgeMs: now - Math.min(...held.map((r) => r.at)) }) };
}

/** For testing. */
export function _resetHelperAutoStateForTesting(): void {
  reservations.clear();
  void rotationStore.save({ version: 1, cursors: {} });
}
