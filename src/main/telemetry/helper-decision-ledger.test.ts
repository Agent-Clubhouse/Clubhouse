import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HELPER_TELEMETRY_LIMITS } from '../../shared/telemetry/helper-usage-contract';
import * as ledger from './helper-decision-ledger';
import { predictHelperBurn } from '../services/helper-auto-forecast';

let dir: string;
let file: string;
let clock = 1_000_000;

const entry = (helperId: string, decidedAtMs = clock) => ({
  helperId, decisionId: `d-${helperId}`, decidedAtMs, mode: 'auto' as const, policyVersion: 1,
  provider: 'claude-code', model: 'sonnet', effort: 'medium', difficulty: 'medium' as const,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-ledger-'));
  file = path.join(dir, 'ledger.json');
  clock = 1_000_000;
  ledger.configureLedger({ file, now: () => clock });
});

afterEach(async () => {
  await ledger.flushLedger();
  ledger._resetLedgerForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('join ledger', () => {
  it('preserves closed cell/canonical identities and empirical bands on restart while legacy records remain cold', async () => {
    const calibration = { revision: '11111111-1111-4111-8111-111111111111', model: 'claude-sonnet-5-5' };
    const e = { ...entry('calibrated'), calibration };
    const forecast = predictHelperBurn(e, [], clock);
    forecast.weekly = {
      samples: 5, effectiveSamples: 4.9, expectedBp: 100,
      interval: { method: 'weighted_empirical', nominalCoverageBp: 8000, lowerBp: 0, upperBp: 200 },
    };
    ledger.putDecision({ ...e, calibrationIdentityReason: 'cached_catalog', forecast });
    ledger.putDecision(entry('legacy'));
    await ledger.flushLedger();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.entries[0].calibration.prompt = 'never retain content';
    raw.entries[0].forecast.weekly.interval.path = '/private/path';
    fs.writeFileSync(file, JSON.stringify(raw));
    ledger.configureLedger({ file, now: () => clock + 1 });
    expect(ledger.getEntry('calibrated')).toMatchObject({ calibration, calibrationIdentityReason: 'cached_catalog', forecast });
    expect(ledger.getEntry('calibrated')?.calibration).toEqual(calibration);
    expect(ledger.getEntry('calibrated')?.forecast?.weekly.interval).toEqual(forecast.weekly.interval);
    expect(predictHelperBurn(ledger.getEntry('legacy')!, ledger.forecastHistory(), clock + 1).weekly)
      .toEqual({ samples: 0, unavailableReason: 'missing_calibration_identity' });
    expect(JSON.stringify(ledger.forecastHistory())).not.toContain('never retain content');
    expect(JSON.stringify(ledger.forecastHistory())).not.toContain('/private/path');
  });

  it('keeps old entries readable and preserves completed forecast history without evaluating interrupted intervals after restart', async () => {
    const e = { ...entry('shadow'), mappingRevision: 'r1.0' };
    const forecast = predictHelperBurn(e, [], clock);
    ledger.putDecision({ ...e, forecast });
    ledger.beginRun('shadow', clock, false);
    ledger.setForecastRun('shadow', { startedMs: clock, usageSamples: 0, usable: true });
    await ledger.flushLedger();
    ledger.configureLedger({ file, now: () => clock + 1 });
    expect(ledger.getEntry('shadow')).toMatchObject({
      forecast,
      burnObservation: { reason: 'restart', attribution: 'whole_login_unknown' },
      forecastRun: { usable: false, endedMs: clock + 1 },
    });
  });

  it('does not leave an interrupted unresolved start overlapping every future calibration interval', async () => {
    ledger.putDecision(entry('pending'));
    await ledger.flushLedger();
    ledger.configureLedger({ file, now: () => clock + 1 });
    expect(ledger.getEntry('pending')).toMatchObject({
      spawn: 'orphaned', forecastRun: { startedMs: clock, endedMs: clock + 1, usable: false },
    });
  });

  it('joins a helper to the decision that started it, and survives a restart', async () => {
    ledger.putDecision(entry('h1'));
    ledger.setSpawn('h1', 'started');
    await ledger.flushLedger();
    ledger.configureLedger({ file, now: () => clock });
    expect(ledger.getEntry('h1')).toMatchObject({ decisionId: 'd-h1', spawn: 'started', model: 'sonnet' });
  });

  it('a helper the ledger does not know stays unknown, never guessed', () => {
    expect(ledger.getEntry('nobody')).toBeUndefined();
    expect(ledger.getEntryByDecision('nope')).toBeUndefined();
  });

  it('starts empty from a missing, corrupt or foreign file', async () => {
    fs.writeFileSync(file, '{not json');
    ledger.configureLedger({ file, now: () => clock });
    expect(ledger.ledgerSize()).toBe(0);
    fs.writeFileSync(file, JSON.stringify({ version: 99, entries: [entry('x')] }));
    ledger.configureLedger({ file, now: () => clock });
    expect(ledger.ledgerSize()).toBe(0);
  });

  it('keeps no prompt, task, path or native session id', async () => {
    ledger.putDecision(entry('h1'));
    ledger.beginRun('h1', clock, true);
    await ledger.flushLedger();
    const text = fs.readFileSync(file, 'utf-8');
    expect(Object.keys(JSON.parse(text).entries[0]).sort()).toEqual([
      'decidedAtMs', 'decisionId', 'difficulty', 'effort', 'helperId', 'mode', 'model', 'policyVersion', 'provider', 'spawn', 'spawnInferred', 'touchedMs',
    ]);
  });
});

describe('runs', () => {
  it('mints a run id per actual run, distinct from any provider session id', () => {
    ledger.putDecision(entry('h1'));
    const first = ledger.beginRun('h1', 1, false);
    ledger.endRun('h1', 2);
    const second = ledger.beginRun('h1', 3, true);
    expect(first.runId).not.toBe(second.runId);
    expect(second.nativeResumed).toBe(true);
  });

  it('closes a run once', () => {
    ledger.beginRun('h1', 1, false);
    expect(ledger.endRun('h1', 5)).toMatchObject({ endedMs: 5 });
    expect(ledger.endRun('h1', 6)).toBeUndefined();
  });

  it('works for a helper the ledger has no decision for', () => {
    const run = ledger.beginRun('stranger', 1, false);
    expect(run.runId).toBeTruthy();
    expect(ledger.getEntry('stranger')).toBeUndefined();
  });
});

describe('bounds', () => {
  it('never evicts a running helper at the cap', () => {
    const cap = HELPER_TELEMETRY_LIMITS.maxInactiveLedgerEntries;
    ledger.putDecision(entry('running', 1));
    ledger.setSpawn('running', 'started');
    ledger.beginRun('running', 1, false);
    for (let i = 0; i < cap + 20; i++) {
      clock += 1;
      ledger.putDecision(entry(`idle-${i}`, clock));
      ledger.setSpawn(`idle-${i}`, 'left_asleep');
    }
    ledger.putDecision(entry('trigger', clock)); // any change prunes
    expect(ledger.getEntry('running')).toBeDefined();
    expect(ledger.ledgerSize()).toBeLessThanOrEqual(cap + 2);
    // The oldest inactive entries went first.
    expect(ledger.getEntry('idle-0')).toBeUndefined();
    expect(ledger.getEntry(`idle-${cap + 19}`)).toBeDefined();
  });

  it('keeps an unresolved start however long it has been, until a result, a run or the cap settles it', () => {
    ledger.putDecision(entry('unresolved', clock));
    clock += HELPER_TELEMETRY_LIMITS.ledgerInactiveRetentionMs + 2 * 60 * 60_000;
    ledger.putDecision(entry('later', clock));
    expect(ledger.getEntry('unresolved')).toMatchObject({ decisionId: 'd-unresolved' });
    expect(ledger.getEntry('unresolved')!.spawn).toBeUndefined();
    ledger.setSpawn('unresolved', 'left_asleep');
    clock += HELPER_TELEMETRY_LIMITS.ledgerInactiveRetentionMs + 1;
    ledger.putDecision(entry('after', clock));
    expect(ledger.getEntry('unresolved')).toBeUndefined();
  });

  it('past the unresolved cap the oldest become orphaned: still joined, no longer protected', () => {
    for (let i = 0; i < ledger.UNRESOLVED_CAP + 5; i++) {
      clock += 1;
      ledger.putDecision(entry(`u${i}`, clock));
    }
    expect(ledger.getEntry('u0')!.spawn).toBe('orphaned');
    expect(ledger.getEntry('u4')!.spawn).toBe('orphaned');
    expect(ledger.getEntry('u5')!.spawn).toBeUndefined();
    expect(ledger.getEntry('u0')!.decisionId).toBe('d-u0');
  });

  it('a late finish still joins an orphaned start, and routing\'s result replaces the mark', () => {
    for (let i = 0; i < ledger.UNRESOLVED_CAP + 1; i++) {
      clock += 1;
      ledger.putDecision(entry(`u${i}`, clock));
    }
    expect(ledger.getEntry('u0')!.spawn).toBe('orphaned');
    ledger.setSpawn('u0', 'started');
    expect(ledger.getEntry('u0')).toMatchObject({ spawn: 'started', decisionId: 'd-u0' });
  });

  it('a run that began is evidence the start happened, unless routing already said', () => {
    ledger.putDecision(entry('a', clock));
    ledger.beginRun('a', clock, false);
    expect(ledger.getEntry('a')).toMatchObject({ spawn: 'started', spawnInferred: true });
    ledger.setSpawn('a', 'started');
    expect(ledger.getEntry('a')!.spawnInferred).toBeUndefined();
    ledger.putDecision(entry('b', clock));
    ledger.setSpawn('b', 'spawn_failed');
    ledger.beginRun('b', clock, false);
    expect(ledger.getEntry('b')).toMatchObject({ spawn: 'spawn_failed' });
  });

  it('after a restart no run survives: unresolved starts are orphaned, everything else inactive and still joined', async () => {
    ledger.putDecision(entry('unresolved', clock));
    ledger.putDecision(entry('asleep', clock));
    ledger.setSpawn('asleep', 'left_asleep');
    ledger.putDecision(entry('running', clock));
    ledger.setSpawn('running', 'started');
    ledger.beginRun('running', clock, false);
    await ledger.flushLedger();
    ledger.configureLedger({ file, now: () => clock });
    expect(ledger.getEntry('unresolved')).toMatchObject({ spawn: 'orphaned', decisionId: 'd-unresolved' });
    expect(ledger.getEntry('asleep')!.spawn).toBe('left_asleep');
    expect(ledger.getRun('running')).toBeUndefined();
    expect(ledger.getEntry('running')).toBeDefined();
  });

  it('forgets every run when told, and keeps the decisions', () => {
    ledger.putDecision(entry('a', clock));
    ledger.beginRun('a', clock, false);
    ledger.clearRuns();
    expect(ledger.getRun('a')).toBeUndefined();
    expect(ledger.getEntry('a')).toBeDefined();
  });

  it('drops inactive entries past retention', () => {
    ledger.putDecision(entry('old', clock));
    ledger.setSpawn('old', 'left_asleep');
    clock += HELPER_TELEMETRY_LIMITS.ledgerInactiveRetentionMs + 1;
    ledger.putDecision(entry('new', clock));
    expect(ledger.getEntry('old')).toBeUndefined();
    expect(ledger.getEntry('new')).toBeDefined();
  });

  it('keeps a closed run until it is forgotten, so final events can still join', () => {
    ledger.putDecision(entry('h', clock));
    ledger.beginRun('h', 1, false);
    const run = ledger.endRun('h', 2)!;
    expect(ledger.getRun('h')).toBe(run);
    ledger.forgetRun('h');
    expect(ledger.getRun('h')).toBeUndefined();
  });
});

describe('reading a persisted file', () => {
  const stored = (over: Record<string, unknown>) => ({ ...entry('x'), touchedMs: clock, spawn: 'started', ...over });
  const load = (entries: unknown[]) => {
    fs.writeFileSync(file, JSON.stringify({ version: ledger.LEDGER_FORMAT_VERSION, entries }));
    ledger.configureLedger({ file, now: () => clock });
  };

  it('drops entries with anything off the closed sets or not finite, and keeps the good ones', () => {
    load([
      stored({ helperId: 'good' }),
      stored({ helperId: 'badmode', mode: 'turbo' }),
      stored({ helperId: 'badspawn', spawn: 'exploded' }),
      stored({ helperId: 'baddiff', difficulty: 'impossible' }),
      stored({ helperId: 'badtime', decidedAtMs: Number.POSITIVE_INFINITY }),
      stored({ helperId: 'negtime', touchedMs: -1 }),
      stored({ helperId: 'badpolicy', policyVersion: 1.5 }),
      stored({ helperId: 'badmodel', model: { raw: 1 } }),
      stored({ helperId: 'long', decisionId: 'd'.repeat(500) }),
      stored({ helperId: '' }),
      null,
      'string',
    ]);
    expect(ledger.ledgerSize()).toBe(1);
    expect(ledger.getEntry('good')).toBeDefined();
  });

  it('keeps only the known fields of an entry it reads', () => {
    load([stored({ helperId: 'x', prompt: 'do the secret thing', nativeSessionId: 'native-1' })]);
    expect(Object.keys(ledger.getEntry('x')!)).not.toContain('prompt');
    expect(Object.keys(ledger.getEntry('x')!)).not.toContain('nativeSessionId');
  });
});

describe('writes', () => {
  it('a failure callback that throws neither breaks the writer nor rejects', async () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    ledger.configureLedger({ file: path.join(blocker, 'ledger.json'), now: () => clock, onFailure: () => { throw new Error('callback broke'); } });
    ledger.putDecision(entry('a'));
    await ledger.flushLedger();
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    expect(ledger.getEntry('a')).toBeDefined();
  });


  it('coalesces a burst into few atomic writes and leaves no temp files', async () => {
    for (let i = 0; i < 50; i++) ledger.putDecision(entry(`h${i}`));
    await ledger.flushLedger();
    expect(ledger._writeCountForTests()).toBeLessThanOrEqual(2);
    expect(fs.readdirSync(dir)).toEqual(['ledger.json']);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).entries).toHaveLength(50);
  });

  it('a failed write keeps the in-memory ledger, reports once, and recovers', async () => {
    // The folder it would write into is a plain file, so every write fails.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const failures: unknown[] = [];
    const target = path.join(blocker, 'ledger.json');
    ledger.configureLedger({ file: target, now: () => clock, onFailure: (e) => failures.push(e) });
    ledger.putDecision(entry('a'));
    await ledger.flushLedger();
    ledger.putDecision(entry('b'));
    await ledger.flushLedger();
    expect(failures).toHaveLength(1);
    expect(ledger.getEntry('a')).toBeDefined();
    expect(fs.readdirSync(dir)).toEqual(['blocker']);
    // The obstacle goes; the next change writes everything held.
    fs.rmSync(blocker);
    ledger.putDecision(entry('c'));
    await ledger.flushLedger();
    expect(JSON.parse(fs.readFileSync(target, 'utf-8')).entries.map((e: { helperId: string }) => e.helperId).sort()).toEqual(['a', 'b', 'c']);
  });
});
