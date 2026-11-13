import type { PressureDecision, PressureOutcome } from '../../shared/helper-burn-pressure';
import { readPressure, readPressureOutcome } from '../services/helper-burn-pressure';
/**
 * The join between a helper and the routing decision that started it (#2747).
 *
 * A helper's saved `routing` goes when its model or CLI is changed, and it
 * is written before the helper runs, so it cannot say later which decision a
 * wake, a session or a failure belongs to. This ledger can: helper id to
 * decision id, the run now open, and what actually started. It holds ids,
 * enum codes and the model/effort the decision resolved (kept raw here, on this
 * device, so calibration can tell mapped models apart; telemetry events only
 * ever carry its hash). No prompt, task, path or account detail.
 *
 * Bounds: while the app runs, an entry whose helper has a run open, or whose
 * start has not resolved, is never evicted. A start that has not resolved is
 * kept until a result or a run proves otherwise; past UNRESOLVED_CAP of them
 * the oldest are marked `orphaned` (an explicit unknown that still joins, and
 * is then an ordinary inactive entry). Entries of helpers that are not running
 * are capped by count and by age, oldest first. After a restart no run
 * survives: every entry is inactive, and a start the previous run never
 * resolved is `orphaned`. A helper missing from the ledger (evicted, from
 * before telemetry was on, or from a lost file) is an explicit unknown: its
 * joins say `decision_known=false`, never a guess.
 *
 * Writes are serialized and coalesced (one in flight, one more if anything
 * changed meanwhile), atomic (temp file, rename) and never throw into the
 * caller. A failed write leaves the in-memory ledger intact and is reported once.
 * No timers: a write happens when a change does.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { HELPER_CALIBRATION_IDENTITY_REASONS, HELPER_SPAWN_RESULTS, HELPER_TASK_PROFILES, HELPER_TELEMETRY_LIMITS, type HelperCalibrationIdentity, type HelperCalibrationIdentityReason, type HelperSpawnResult, type HelperTaskProfile } from '../../shared/telemetry/helper-usage-contract';
import { HELPER_DIFFICULTIES, HELPER_ROUTING_MODES, type HelperDifficulty } from '../../shared/helper-routing';
import { readBurnCalibrationIdentity, readBurnForecast, readBurnObservation, readForecastRun, type BurnForecast, type BurnObservation, type ForecastRun } from '../services/helper-auto-forecast';

export const LEDGER_FORMAT_VERSION = 1;

/** Starts with no result yet that are kept as live. Past this the oldest become `orphaned`. */
export const UNRESOLVED_CAP = 200;

/** A start's result, or `orphaned`: the previous run (or the cap) lost track of it, so what became of it is unknown. */
export type LedgerSpawn = HelperSpawnResult | 'orphaned';

export interface LedgerEntry {
  helperId: string;
  decisionId: string;
  decidedAtMs: number;
  mode: 'explicit' | 'preset' | 'auto';
  policyVersion: number;
  /** As the decision resolved them. Raw, local; telemetry sends the model's hash. */
  provider: string | null;
  model: string | null;
  effort: string | null;
  difficulty: HelperDifficulty | null;
  mappingRevision?: string;
  calibration?: HelperCalibrationIdentity;
  calibrationIdentityReason?: HelperCalibrationIdentityReason;
  mappingFingerprint?: string;
  taskProfile?: HelperTaskProfile;
  pressure?: PressureDecision;
  pressureOutcome?: PressureOutcome;
  forecast?: BurnForecast;
  forecastRun?: ForecastRun;
  burnObservation?: BurnObservation;
  /** What the start came to, once known. Absent while the start is unresolved. */
  spawn?: LedgerSpawn;
  /** `spawn` was taken from a run that began, not reported by routing. */
  spawnInferred?: boolean;
  /** When the entry last changed or its helper last ran, for retention. */
  touchedMs: number;
}

/** A helper's run now open (or last open). Never the provider's session id. */
export interface LedgerRun {
  runId: string;
  startedMs: number;
  /** The provider session continued an earlier one (a resume). A flag only; the native id is never kept. */
  nativeResumed: boolean;
  endedMs?: number;
}

interface Stored {
  version: number;
  entries: LedgerEntry[];
}

let file: string | null = null;
let entries = new Map<string, LedgerEntry>();
const runs = new Map<string, LedgerRun>();
let writing: Promise<void> | null = null;
let dirty = false;
let reportedFailure = false;
let writeCount = 0;
let onFailure: (error: unknown) => void = () => undefined;
let now: () => number = Date.now;

const SPAWNS: readonly string[] = [...HELPER_SPAWN_RESULTS, 'orphaned'];
const MAX_FIELD = 200;

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD;
const textOrNull = (v: unknown): v is string | null | undefined => v === null || v === undefined || text(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A persisted entry, field by field: anything off the closed sets or not finite drops the entry. */
function readEntry(v: unknown): LedgerEntry | undefined {
  const e = v as Partial<Record<keyof LedgerEntry, unknown>> | null;
  if (!e || typeof e !== 'object') return undefined;
  if (!text(e.helperId) || !text(e.decisionId) || !time(e.decidedAtMs) || !time(e.touchedMs)) return undefined;
  if (!HELPER_ROUTING_MODES.includes(e.mode as never) || typeof e.policyVersion !== 'number' || !Number.isInteger(e.policyVersion)) return undefined;
  if (!textOrNull(e.provider) || !textOrNull(e.model) || !textOrNull(e.effort)) return undefined;
  if (e.difficulty !== null && e.difficulty !== undefined && !(HELPER_DIFFICULTIES as readonly unknown[]).includes(e.difficulty)) return undefined;
  if (e.spawn !== undefined && !SPAWNS.includes(e.spawn as string)) return undefined;
  if (!textOrNull(e.mappingRevision) || !textOrNull(e.mappingFingerprint)) return undefined;
  const pressure = readPressure(e.pressure);
  const pressureOutcome = readPressureOutcome(e.pressureOutcome);
  const forecast = readBurnForecast(e.forecast);
  const calibration = readBurnCalibrationIdentity(e.calibration);
  const identityReason = HELPER_CALIBRATION_IDENTITY_REASONS.find((reason) => reason === e.calibrationIdentityReason);
  const observation = readBurnObservation(e.burnObservation);
  const forecastRun = readForecastRun(e.forecastRun);
  return {
    helperId: e.helperId, decisionId: e.decisionId, decidedAtMs: e.decidedAtMs, touchedMs: e.touchedMs,
    mode: e.mode as LedgerEntry['mode'], policyVersion: e.policyVersion,
    provider: (e.provider as string | null | undefined) ?? null, model: (e.model as string | null | undefined) ?? null, effort: (e.effort as string | null | undefined) ?? null,
    difficulty: (e.difficulty as HelperDifficulty | null | undefined) ?? null,
    ...(typeof e.mappingRevision === 'string' && { mappingRevision: e.mappingRevision }),
    ...(calibration && { calibration }),
    ...(identityReason && { calibrationIdentityReason: identityReason }),
    ...(typeof e.mappingFingerprint === 'string' && { mappingFingerprint: e.mappingFingerprint }),
    ...(e.spawn !== undefined && { spawn: e.spawn as LedgerSpawn }),
    ...(e.spawnInferred === true && { spawnInferred: true }),
    ...(HELPER_TASK_PROFILES.includes(e.taskProfile as never) && { taskProfile: e.taskProfile as HelperTaskProfile }),
    ...(pressure && { pressure, pressureOutcome: pressureOutcome ?? { atMs: now(), availableAtMs: now(), attribution: 'subscription_group_with_unknown_residual' as const, reason: 'restart' as const, windows: [] } }),
    ...(forecast && { forecast, burnObservation: observation ?? { atMs: now(), attribution: 'whole_login_unknown' as const, reason: 'restart' as const } }),
    ...(forecastRun?.endedMs !== undefined ? { forecastRun }
      : (forecastRun || e.spawn === undefined || e.spawn === 'started' || e.spawn === 'orphaned') ? {
        forecastRun: { startedMs: e.decidedAtMs, endedMs: Math.max(e.decidedAtMs, now()), usageSamples: 0, usable: false },
      } : {}),
  };
}

/**
 * Point the ledger at its file and read what is there. A missing, unreadable or
 * foreign file is an empty ledger (explicit unknown), not an error.
 */
export function configureLedger(options: { file: string; now?: () => number; onFailure?: (error: unknown) => void }): void {
  file = options.file;
  now = options.now ?? Date.now;
  onFailure = options.onFailure ?? (() => undefined);
  entries = new Map();
  runs.clear();
  reportedFailure = false;
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<Stored>;
    if (stored.version === LEDGER_FORMAT_VERSION && Array.isArray(stored.entries)) {
      for (const raw of stored.entries) {
        const e = readEntry(raw);
        if (!e) continue;
        // No run survives a restart: a start the previous run never resolved is now an explicit unknown.
        if (e.spawn === undefined) e.spawn = 'orphaned';
        entries.set(e.helperId, e);
      }
    }
  } catch {
    // Nothing to read, or not ours: start empty.
  }
  prune();
}

/** A run is open, or the start has no result yet. */
function isActive(e: LedgerEntry): boolean {
  const run = runs.get(e.helperId);
  return (!!run && run.endedMs === undefined) || e.spawn === undefined;
}

/**
 * Mark the oldest unresolved starts past the cap as orphaned, then drop inactive
 * entries past retention and the oldest past the cap. A live join is never deleted.
 */
function prune(): void {
  const unresolved = [...entries.values()].filter((e) => e.spawn === undefined && !runs.has(e.helperId)).sort((a, b) => a.decidedAtMs - b.decidedAtMs);
  for (const e of unresolved.slice(0, Math.max(0, unresolved.length - UNRESOLVED_CAP))) e.spawn = 'orphaned';
  const cutoff = now() - HELPER_TELEMETRY_LIMITS.ledgerInactiveRetentionMs;
  const inactive = [...entries.values()].filter((e) => !isActive(e)).sort((a, b) => a.touchedMs - b.touchedMs);
  for (const e of inactive) if (e.touchedMs < cutoff) entries.delete(e.helperId);
  const left = inactive.filter((e) => entries.has(e.helperId));
  for (const e of left.slice(0, Math.max(0, left.length - HELPER_TELEMETRY_LIMITS.maxInactiveLedgerEntries))) entries.delete(e.helperId);
}

function persist(): void {
  if (!file) return;
  dirty = true;
  if (writing) return;
  const write = async (): Promise<void> => {
    try {
      while (dirty && file) {
        dirty = false;
        prune();
        const target = file;
        const body = JSON.stringify({ version: LEDGER_FORMAT_VERSION, entries: [...entries.values()] } satisfies Stored);
        const tmp = `${target}.tmp.${randomUUID().slice(0, 8)}`;
        try {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(tmp, body, 'utf-8');
          await fsp.rename(tmp, target);
          writeCount++;
        } catch (error) {
          await fsp.rm(tmp, { force: true }).catch((): void => undefined);
          if (!reportedFailure) {
            reportedFailure = true;
            try {
              onFailure(error);
            } catch {
              // The callback is not allowed to break the writer.
            }
          }
        }
      }
    } finally {
      // In the same turn as the loop's last check, so a change can't slip in between and go unwritten.
      writing = null;
    }
  };
  // Nothing rejects out of this promise, and nobody on the hot path waits for it.
  writing = write().catch((): void => undefined);
}

/** Resolves when pending writes have settled. For tests and quit. */
export async function flushLedger(): Promise<void> {
  while (writing) await writing;
}

/** A new decision for a helper. A helper has one entry: the decision that started it. */
export function putDecision(entry: Omit<LedgerEntry, 'touchedMs' | 'spawn'>): void {
  entries.set(entry.helperId, { ...entry, touchedMs: now() });
  prune();
  persist();
}

export function getEntry(helperId: string): LedgerEntry | undefined {
  return entries.get(helperId);
}

export function forecastHistory(): readonly LedgerEntry[] {
  return [...entries.values()];
}

export function setPressureOutcome(helperId: string, outcome: PressureOutcome): void {
  const entry = entries.get(helperId);
  if (!entry?.pressure || entry.pressureOutcome) return;
  entry.pressureOutcome = outcome;
  entry.touchedMs = now();
  persist();
}

export function setForecastRun(helperId: string, evidence: ForecastRun): void {
  const entry = entries.get(helperId);
  if (!entry) return;
  entry.forecastRun = { ...evidence };
  persist();
}

export function setBurnObservation(helperId: string, observation: BurnObservation): void {
  const entry = entries.get(helperId);
  if (!entry?.forecast || entry.burnObservation) return;
  entry.burnObservation = observation;
  persist();
}

/** Find the entry a decision id belongs to (a spawn result may arrive before the helper id is known elsewhere). */
export function getEntryByDecision(decisionId: string): LedgerEntry | undefined {
  for (const e of entries.values()) if (e.decisionId === decisionId) return e;
  return undefined;
}

export function setSpawn(helperId: string, spawn: HelperSpawnResult): LedgerEntry | undefined {
  const entry = entries.get(helperId);
  if (!entry) return undefined;
  // A reported result wins over an orphan mark or a start taken from a run: a late finish still joins.
  entry.spawn = spawn;
  delete entry.spawnInferred;
  entry.touchedMs = now();
  persist();
  return entry;
}

/** A run began for this helper: a fresh run id, whether or not the ledger knows the helper. */
export function beginRun(helperId: string, startedMs: number, nativeResumed: boolean): LedgerRun {
  const run: LedgerRun = { runId: randomUUID(), startedMs, nativeResumed };
  runs.set(helperId, run);
  const entry = entries.get(helperId);
  if (entry) {
    // A session that began is evidence the start happened, unless routing already said what became of it.
    if (entry.spawn === undefined || entry.spawn === 'orphaned') {
      entry.spawn = 'started';
      entry.spawnInferred = true;
    }
    entry.touchedMs = now();
    persist();
  }
  return run;
}

export function getRun(helperId: string): LedgerRun | undefined {
  return runs.get(helperId);
}

/** Close the helper's open run. Returns it once; a second close finds nothing. */
export function endRun(helperId: string, endedMs: number): LedgerRun | undefined {
  const run = runs.get(helperId);
  if (!run || run.endedMs !== undefined) return undefined;
  run.endedMs = endedMs;
  const entry = entries.get(helperId);
  if (entry) {
    // A session that began is evidence the start happened, unless routing already said what became of it.
    if (entry.spawn === undefined || entry.spawn === 'orphaned') {
      entry.spawn = 'started';
      entry.spawnInferred = true;
    }
    entry.touchedMs = now();
    persist();
  }
  return run;
}

/** Forget a helper's closed run once its final events are out. */
export function forgetRun(helperId: string): void {
  const run = runs.get(helperId);
  if (run && run.endedMs !== undefined) runs.delete(helperId);
}

/** Forget every run, for telemetry going off: nothing is open any more as far as the ledger can say. */
export function clearRuns(): void {
  for (const helperId of runs.keys()) {
    const entry = entries.get(helperId);
    if (entry?.forecastRun) {
      entry.forecastRun = { ...entry.forecastRun, endedMs: Math.max(entry.forecastRun.startedMs, now()), usable: false };
    }
  }
  // In memory only: turning recording off must not write forecast state.
  runs.clear();
}

export function ledgerSize(): number {
  return entries.size;
}

/** Test-only: completed file writes. */
export function _writeCountForTests(): number {
  return writeCount;
}

/** Test-only reset. */
export function _resetLedgerForTests(): void {
  file = null;
  entries = new Map();
  runs.clear();
  writing = null;
  dirty = false;
  reportedFailure = false;
  writeCount = 0;
  onFailure = () => undefined;
  now = Date.now;
}
