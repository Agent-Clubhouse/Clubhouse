import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const state = vi.hoisted(() => ({
  dir: '',
  destinations: [{ id: 'otlp', kind: 'otlp', backfilledThrough: undefined as number | undefined }],
  sent: [] as Array<{ destination: string; lines: string[]; errorTraceIds?: ReadonlySet<string> }>,
  failOnCall: undefined as number | undefined,
  calls: 0,
  result: { ok: true, spans: 1, logs: 1, metricPoints: 0, filtered: 0, skipped: 0 } as Record<string, unknown>,
}));
vi.mock('./bootstrap', () => ({
  replayToDestination: vi.fn(async (destination: string, lines: string[], opts: { signal?: AbortSignal; errorTraceIds?: ReadonlySet<string> } = {}) => {
    if (opts.signal?.aborted) return { ok: false, reason: 'cancelled', spans: 0, logs: 0, metricPoints: 0, filtered: 0, skipped: 0 };
    if (state.failOnCall !== undefined && state.calls++ === state.failOnCall) return { ok: false, reason: 'export_failed', spans: 0, logs: 0, metricPoints: 0, filtered: 0, skipped: 0 };
    state.sent.push({ destination, lines: [...lines], errorTraceIds: opts.errorTraceIds });
    return { ...state.result };
  }),
}));
vi.mock('./local-control', () => ({ getLogDir: () => state.dir }));
vi.mock('../services/log-settings', () => ({ getSettings: () => ({ retention: 'medium' }) }));
vi.mock('./settings', () => ({
  getTelemetrySettings: () => ({ destinations: state.destinations }),
  updateTelemetrySettings: async (fn: (s: { destinations: typeof state.destinations }) => { destinations: typeof state.destinations }) => {
    state.destinations = fn({ destinations: state.destinations }).destinations;
  },
}));

import { _resetBackfillForTests, cancelBackfill, dismissBackfill, getBackfillOffer, getBackfillStatus, noteDestinationDisabled, noteDestinationEnabled, startBackfill } from './backfill';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const base = (ms: number) => new Date(ms).toISOString().replace(/:/g, '-').replace(/Z$/, '');
const event = (ms: number, name = 'clubhouse.audit.setting') => JSON.stringify({ t: 'event', ts: new Date(ms).toISOString(), name, severity: 'info', attrs: {} });
const session = (ms: number) => JSON.stringify({ t: 'session', v: 4, ts: new Date(ms).toISOString(), scope: 'clubhouse', temporality: 'delta' });

function writeRun(startMs: number, lines: string[], chunk?: number): void {
  const file = path.join(state.dir, `telemetry-${base(startMs)}${chunk ? `.${chunk}` : ''}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const last = Math.max(...lines.map((l) => Date.parse(JSON.parse(l).ts)).filter(Number.isFinite));
  fs.utimesSync(file, last / 1000, last / 1000);
}

const until = (fn: () => boolean) => vi.waitFor(() => { if (!fn()) throw new Error('not yet'); });

beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  state.destinations = [{ id: 'otlp', kind: 'otlp', backfilledThrough: undefined }];
  state.sent = [];
  state.failOnCall = undefined;
  state.calls = 0;
  state.result = { ok: true, spans: 1, logs: 1, metricPoints: 0, filtered: 0, skipped: 0 };
  _resetBackfillForTests();
});
afterEach(() => { fs.rmSync(state.dir, { recursive: true, force: true }); });

describe('backfill on connect (#2920)', () => {
  it('offers nothing unless the user just turned the destination on, and never for the developer destination', async () => {
    writeRun(NOW - 2 * DAY, [session(NOW - 2 * DAY), event(NOW - 2 * DAY + 1000)]);
    expect(await getBackfillOffer('otlp')).toBeNull();
    noteDestinationEnabled('framebriar', 'framebriar', NOW);
    expect(await getBackfillOffer('framebriar')).toBeNull();
    noteDestinationEnabled('otlp', 'otlp', NOW);
    expect(await getBackfillOffer('otlp')).toMatchObject({ destinationId: 'otlp', until: NOW, oldest: NOW - 2 * DAY, days: 2 });
    dismissBackfill('otlp');
    expect(await getBackfillOffer('otlp')).toBeNull();
  });

  it("sends each run's history in the chosen window, keeping session lines, then never offers it again", async () => {
    writeRun(NOW - 10 * DAY, [session(NOW - 10 * DAY), event(NOW - 10 * DAY + 1000)]);
    writeRun(NOW - 2 * DAY, [session(NOW - 2 * DAY), event(NOW - 2 * DAY + 1000), event(NOW + 1000, 'after-enable')]);
    noteDestinationEnabled('otlp', 'otlp', NOW);
    expect(await startBackfill('otlp', 7)).toEqual({ ok: true });
    await until(() => getBackfillStatus('otlp')?.state === 'done');
    // Only the run inside 7 days, with its session line, and nothing from after the destination was turned on.
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].lines).toHaveLength(2);
    expect(state.sent[0].lines[0]).toContain('"t":"session"');
    expect(state.sent[0].lines.join('\n')).not.toContain('after-enable');
    expect(getBackfillStatus('otlp')).toMatchObject({ state: 'done', spans: 1, logs: 1, runsDone: 1, runsTotal: 1 });
    expect(state.destinations[0].backfilledThrough).toBe(NOW);
    // Turned off and on again: what was sent, by backfill or live while it was on, isn't offered again.
    await noteDestinationDisabled('otlp', NOW + 2000);
    expect(state.destinations[0].backfilledThrough).toBe(NOW + 2000);
    noteDestinationEnabled('otlp', 'otlp', NOW + 3000);
    expect(await getBackfillOffer('otlp')).toBeNull();
  });

  it('sends everything kept for "all", oldest run first', async () => {
    writeRun(NOW - 10 * DAY, [session(NOW - 10 * DAY), event(NOW - 10 * DAY + 1000)]);
    writeRun(NOW - 2 * DAY, [session(NOW - 2 * DAY), event(NOW - 2 * DAY + 1000)]);
    noteDestinationEnabled('otlp', 'otlp', NOW);
    await startBackfill('otlp', 'all');
    await until(() => getBackfillStatus('otlp')?.state === 'done');
    expect(state.sent.map((s) => JSON.parse(s.lines[1]).ts)).toEqual([new Date(NOW - 10 * DAY + 1000).toISOString(), new Date(NOW - 2 * DAY + 1000).toISOString()]);
  });

  it('stops on a failure without remembering anything as sent, and needs an offer to start', async () => {
    writeRun(NOW - 2 * DAY, [session(NOW - 2 * DAY), event(NOW - 2 * DAY + 1000)]);
    expect(await startBackfill('otlp', 7)).toEqual({ ok: false, reason: 'no_offer' });
    noteDestinationEnabled('otlp', 'otlp', NOW);
    state.result = { ok: false, reason: 'export_failed', spans: 0, logs: 0, metricPoints: 0, filtered: 0, skipped: 0 };
    await startBackfill('otlp', 7);
    await until(() => getBackfillStatus('otlp')?.state === 'failed');
    expect(getBackfillStatus('otlp')?.reason).toBe('export_failed');
    expect(state.destinations[0].backfilledThrough).toBeUndefined();
  });

  it('can be cancelled between runs', async () => {
    writeRun(NOW - 3 * DAY, [session(NOW - 3 * DAY), event(NOW - 3 * DAY + 1000)]);
    writeRun(NOW - 2 * DAY, [session(NOW - 2 * DAY), event(NOW - 2 * DAY + 1000)]);
    noteDestinationEnabled('otlp', 'otlp', NOW);
    await startBackfill('otlp', 7);
    cancelBackfill('otlp');
    await until(() => ['cancelled', 'done'].includes(getBackfillStatus('otlp')?.state ?? ''));
    if (getBackfillStatus('otlp')?.state === 'cancelled') expect(state.destinations[0].backfilledThrough).toBeUndefined();
  });

  const metric = (ms: number) => JSON.stringify({ t: 'metric', ts: new Date(ms).toISOString(), name: 'clubhouse.app.sessions', kind: 'counter', startMs: ms - 60_000, durationMs: 60_000, attrs: {}, sum: 1 });
  const ts = (line: string) => JSON.parse(line).ts as string;

  it('marks sent only what the destination confirmed, so a send restarted by hand resumes with no repeats and nothing skipped', async () => {
    const t1 = NOW - DAY;
    // Three slices: an event, a metric, an event (one export each).
    writeRun(t1 - 1000, [session(t1 - 1000), event(t1), metric(t1 + 1000), event(t1 + 2000)]);
    noteDestinationEnabled('otlp', 'otlp', NOW);
    state.failOnCall = 1;
    await startBackfill('otlp', 7);
    await until(() => getBackfillStatus('otlp')?.state === 'failed');
    // The first slice was confirmed; the second failed and isn't marked.
    expect(state.sent.map((x) => x.lines.slice(1).map(ts))).toEqual([[new Date(t1).toISOString()]]);
    expect(state.destinations[0].backfilledThrough).toBe(t1);
    // The offer stays, for what's left.
    expect(await getBackfillOffer('otlp')).toMatchObject({ until: NOW });
    state.failOnCall = undefined;
    state.sent = [];
    expect(await startBackfill('otlp', 7)).toEqual({ ok: true });
    await until(() => getBackfillStatus('otlp')?.state === 'done');
    expect(state.sent.map((x) => x.lines.slice(1).map(ts))).toEqual([[new Date(t1 + 1000).toISOString()], [new Date(t1 + 2000).toISOString()]]);
    expect(state.destinations[0].backfilledThrough).toBe(NOW);
    expect(await getBackfillOffer('otlp')).toBeNull();
  });

  it('never splits lines with the same time across slices, and passes the whole run\'s failed traces for the error-tail rule', async () => {
    const t1 = NOW - DAY;
    const same = Array.from({ length: 300 }, () => event(t1));
    const failing = JSON.stringify({ t: 'span', ts: new Date(t1 - 500).toISOString(), name: 'clubhouse.annex.rest', traceId: 'f'.repeat(32), spanId: '1'.repeat(16), startMs: t1 - 600, durationMs: 100, outcome: 'error', attrs: {} });
    writeRun(t1 - 1000, [session(t1 - 1000), failing, ...same]);
    noteDestinationEnabled('otlp', 'otlp', NOW);
    await startBackfill('otlp', 7);
    await until(() => getBackfillStatus('otlp')?.state === 'done');
    expect(state.sent.map((x) => x.lines.length - 1)).toEqual([1, 300]);
    expect([...state.sent[0].errorTraceIds!]).toEqual(['f'.repeat(32)]);
  });

  it('never offers for a destination that came on without the user turning it on here, such as at startup', async () => {
    writeRun(NOW - 2 * DAY, [session(NOW - 2 * DAY), event(NOW - 2 * DAY + 1000)]);
    expect(await getBackfillOffer('otlp')).toBeNull();
    expect(await startBackfill('otlp', 'all')).toEqual({ ok: false, reason: 'no_offer' });
  });

  it('never offers for the developer destination, even when noted', async () => {
    writeRun(NOW - 2 * DAY, [session(NOW - 2 * DAY), event(NOW - 2 * DAY + 1000)]);
    noteDestinationEnabled('framebriar', 'framebriar', NOW);
    expect(await getBackfillOffer('framebriar')).toBeNull();
    expect(await startBackfill('framebriar', 'all')).toEqual({ ok: false, reason: 'no_offer' });
  });
});

