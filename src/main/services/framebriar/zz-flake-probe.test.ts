/**
 * The report field against the real vendored SDK: secure store, access, feedback and outbox on
 * a temp directory. Only safeStorage and the network are fakes; global fetch refuses, so nothing
 * here can reach a server (#2658).
 *
 * How enrollment moves in the SDK (access.mjs): canCapture is optedIn. A notice keeps the optedIn
 * it was raised with, and restores it after a restart, so `expired`, `access-required` and
 * `connection-uncertain` and `enrollment-response-rejected` never turn an enrolled install off. Only disconnect turns it off, or
 * finding the stored enrollment gone. An invitation that fails on a fresh install leaves it off.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Passthrough instrumentation only: every fs call still runs for real, and nothing is emulated.
const fsProbe = vi.hoisted(() => ({
  t0: 0, trace: [] as string[], inflightReads: new Map<string, number>(), errors: [] as Array<Record<string, unknown>>,
  syncMs: 0, syncs: 0, renameMs: 0, renames: 0, readMs: 0, reads: 0, step: 'setup',
}));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  const short = (p: unknown) => String(p).replace(/\\/g, '/').split('/').slice(-2).join('/')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, 'ID');
  const note = (s: string) => { if (fsProbe.trace.length < 4000) fsProbe.trace.push(`${Math.round(performance.now() - fsProbe.t0)}ms [${fsProbe.step}] ${s}`); };
  const fail = (syscall: string, p: unknown, e: unknown, extra: object = {}) => {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'EEXIST') {
      fsProbe.errors.push({ step: fsProbe.step, syscall, file: short(p), code, ...extra });
      note(`ERR ${syscall} ${short(p)} ${code} ${JSON.stringify(extra)}`);
    }
  };
  const patched = {
    ...real,
    readFile: async (p: never, o?: never) => {
      const key = String(p), t = performance.now();
      const interesting = key.includes('reports');
      fsProbe.inflightReads.set(key, (fsProbe.inflightReads.get(key) ?? 0) + 1);
      if (interesting) note(`read> ${short(p)}`);
      try { return await real.readFile(p, o); }
      catch (e) { fail('readFile', p, e); throw e; }
      finally {
        fsProbe.inflightReads.set(key, (fsProbe.inflightReads.get(key) ?? 1) - 1);
        fsProbe.readMs += performance.now() - t; fsProbe.reads++;
        if (interesting) note(`read< ${short(p)}`);
      }
    },
    rename: async (a: never, b: never) => {
      const key = String(b), t = performance.now();
      const readersAtStart = fsProbe.inflightReads.get(key) ?? 0;
      note(`rename> ${short(b)} readers=${readersAtStart}`);
      try { const r = await real.rename(a, b); note(`rename< ${short(b)}`); return r; }
      catch (e) { fail('rename', b, e, { readersAtStart, readersAtEnd: fsProbe.inflightReads.get(key) ?? 0 }); throw e; }
      finally { fsProbe.renameMs += performance.now() - t; fsProbe.renames++; }
    },
    open: async (p: never, f: never, m?: never) => {
      let h;
      try { h = await real.open(p, f, m); }
      catch (e) { fail('open', p, e, { flags: String(f) }); throw e; }
      const sync = h.sync.bind(h);
      h.sync = async () => { const t = performance.now(); try { return await sync(); } finally { fsProbe.syncMs += performance.now() - t; fsProbe.syncs++; } };
      return h;
    },
    unlink: async (p: never) => { try { return await real.unlink(p); } catch (e) { fail('unlink', p, e); throw e; } },
  };
  return { ...patched, default: patched };
});

import { createFramebriar, type Framebriar } from '../../vendor/framebriar/adapters/node/index.mjs';
import { asyncOnlySafeStorage, fakeKeychain } from '../../telemetry/__test-utils__/fake-safe-storage';
import type { FeedbackDiagnostics, FeedbackSendInput, FeedbackSendResult } from '../../../shared/feedback-types';
import type { FeedbackCorrelationSnapshot } from '../../telemetry/feedback-incident';
import { toDiagnosticsV1 } from './feedback-diagnostics-v1';
import { FeedbackService, fitsSource, type FeedbackBreadcrumb, type FeedbackLog } from './feedback-service';
import fixture from './fixtures/held-reports-v1.json';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fake-image-bytes')]);
/** A PNG with a real IHDR chunk, so a drawing can be checked against its size. */
function pngOf(width: number, height: number, body: string): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([PNG.subarray(0, 8), ihdr, Buffer.from(body)]);
}
const FIRST_INVITE = 'a'.repeat(43);
const SECOND_INVITE = 'b'.repeat(43);
const FIRST_TOKEN = 't'.repeat(43);
const SECOND_TOKEN = 'u'.repeat(43);
const AVAILABLE: FeedbackDiagnostics = {
  status: 'available', windowStart: '2026-11-01T11:30:00.000Z', windowEnd: '2026-11-01T12:00:00.000Z', bytes: 100, dropped: 0,
  lines: [{ at: '2026-11-01T11:59:00.000Z', level: 'warn', ns: 'core:annex', event: 'annex.ws.disconnected', attrs: { closeCode: 1009 } }],
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
/** A 2xx that a proxy could produce: never evidence of what the service did. */
const notJson = () => new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });

/** Access and outbox calls the shipped typings leave out; both are in the vendored source. */
type RealSdk = Framebriar & {
  access: Framebriar['access'] & { refresh(): Promise<unknown> };
  outbox: Framebriar['outbox'] & { dir: string; list(): Promise<Array<{ id: string; code: string | null }>>; resume(): Promise<void>; flush(): Promise<void> };
};

const cleanups: Array<() => Promise<void> | void> = [];
let dataDir: string;
let keychain: ReturnType<typeof fakeKeychain>;

function harness({ reportDiagnosticsField = true, online = false, log, breadcrumbs, captureCorrelation, diagnostics = () => AVAILABLE }: {
  reportDiagnosticsField?: boolean; online?: boolean; log?: FeedbackLog; breadcrumbs?: () => FeedbackBreadcrumb[];
  captureCorrelation?: () => FeedbackCorrelationSnapshot; diagnostics?: () => FeedbackDiagnostics;
} = {}) {
  /** submitFails: what the next submit throws, `saved` first if the report really reached the outbox. */
  const state = { now: NOW, online, statusThrows: false, submitFails: null as { code: string; saved: boolean } | null, holdSubmit: null as Promise<void> | null };
  const reports: Array<{ authorization: string; body: { id: string; diagnostics?: unknown } }> = [];
  /** Set by a test to answer the next access calls; the default grants the first enrollment. */
  const access: { redeem: () => Response | Promise<Response>; refresh: () => Response } = {
    redeem: () => json(grant(FIRST_TOKEN, 'r')),
    refresh: () => json(grant(FIRST_TOKEN, 'r')),
  };
  function grant(token: string, refresh: string) {
    return {
      v: 1, gameId: 'clubhouse', scopeVersion: 2, token, refreshToken: refresh.repeat(43),
      expiresAt: new Date(state.now + HOUR).toISOString(), refreshExpiresAt: new Date(state.now + 30 * DAY).toISOString(),
    };
  }
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/v1/access/redeem')) return access.redeem();
    if (path.endsWith('/v1/access/refresh')) return access.refresh();
    if (path.endsWith('/v1/access/disconnect')) return json({ v: 1, disconnected: true });
    if (path.endsWith('/v1/reports')) {
      const body = JSON.parse(String(init?.body));
      reports.push({ authorization: new Headers(init?.headers).get('authorization') ?? '', body });
      return json({ id: body.id, status: 'ready', gameId: 'clubhouse' });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  let sdk: RealSdk | undefined;
  const prepared: Array<Promise<unknown>> = [];
  const excerpt = vi.fn();
  const service = new FeedbackService({
    safeStorage: asyncOnlySafeStorage(keychain), dataDir, appVersion: '0.42.0', isOnline: () => state.online,
    create: ((opts: Parameters<typeof createFramebriar>[0]) => {
      const real = createFramebriar({
        ...opts, endpoint: 'https://framebriar.test/api', fetchImpl: fetchImpl as never,
        // access.status() reads the clock, so this makes the SDK's real status() throw.
        now: () => { if (state.statusThrows) throw new Error('clock broke'); return state.now; },
      }) as RealSdk;
      // The SDK's objects are frozen, so this records through a copy.
      sdk = { ...real, feedback: { ...real.feedback,
        prepare: (input) => { const result = real.feedback.prepare(input); prepared.push(result); return result; },
        submit: async (value, options) => {
          await state.holdSubmit;
          const fails = state.submitFails;
          state.submitFails = null;
          if (fails && !fails.saved) throw Object.assign(new Error('Local feedback storage failed'), { code: fails.code });
          const ack = await real.feedback.submit(value, options);
          if (fails) throw Object.assign(new Error('Local feedback storage failed'), { code: fails.code });
          return ack;
        },
      } };
      return sdk;
    }) as never,
    now: () => state.now, captureCorrelation: captureCorrelation ?? (() => ({ data: {} }) as never), breadcrumbs,
    diagnostics, createExcerptTelemetry: excerpt as never, reportDiagnosticsField, log,
  });
  cleanups.push(async () => { state.statusThrows = false; await service.shutdown(); });
  return {
    service, state, access, excerpt, reports, grant, prepared, fetchImpl,
    /** Status once the SDK's own refresh after an enrollment change has landed. */
    settled: async (held: number, enrolled = true) => {
      await vi.waitFor(() => {
        const { heldForEnrollment, releaseToken } = service.status().outbox;
        expect([heldForEnrollment, releaseToken !== null]).toEqual([held, enrolled]);
      }, { timeout: 5_000 });
      return service.status().outbox;
    },
    fb: () => sdk as RealSdk,
    capture: () => service.captureDraft(async () => PNG),
    send: (draftId: string, includeDiagnostics = true) => service.send({ draftId, notes: 'it broke', includeScreenshot: true, includeDiagnostics }),
    saved: async () => {
      const items = await (sdk as RealSdk).outbox.list();
      return items.map((item) => JSON.parse(readFileSync(join((sdk as RealSdk).outbox.dir, 'reports', item.id, 'report.json'), 'utf-8')).report);
    },
    /** The image bytes a saved report would deliver. */
    media: (id: string) => readFileSync(join((sdk as RealSdk).outbox.dir, 'reports', id, 'media.png')),
    binding: (id: string) => JSON.parse(readFileSync(join((sdk as RealSdk).outbox.dir, 'reports', id, 'binding.json'), 'utf-8')).enrollmentRef,
  };
}
type Harness = ReturnType<typeof harness>;

/** Enrolled, with the redeem held open: `release` lets it finish. */
function holdRedeem(h: Harness) {
  let release: ((response: Response) => void) | undefined;
  let finished = false;
  // The state says connecting before the request goes out, so a test can finish first.
  h.access.redeem = () => finished ? json({}, 401) : new Promise<Response>((resolve) => { release = resolve; });
  const connecting = h.service.connect(SECOND_INVITE);
  cleanups.unshift(async () => { finished = true; release?.(json({}, 401)); await connecting; });
}

/** Each way an enrolled install can stop being connected, and what the SDK shows for it. */
const ENROLLED_STATES: Array<[string, (h: Harness) => Promise<unknown> | void, { state: string; notice: string | null }]> = [
  ['connecting', async (h) => {
    holdRedeem(h);
    await vi.waitFor(() => expect(h.fb().access.status().state).toBe('connecting'));
  }, { state: 'connecting', notice: null }],
  ['offline', (h) => { h.access.refresh = () => json({}, 503); return h.fb().access.refresh(); }, { state: 'offline', notice: null }],
  ['the expired notice', (h) => { h.state.now += 31 * DAY; return h.fb().access.refresh(); }, { state: 'expired', notice: 'expired' }],
  ['the access-required notice', (h) => { h.access.refresh = () => json({}, 401); return h.fb().access.refresh(); }, { state: 'access-required', notice: 'access-required' }],
  ['the connection-uncertain notice', (h) => { h.access.redeem = notJson; return h.service.connect(SECOND_INVITE); }, { state: 'connection-uncertain', notice: 'connection-uncertain' }],
  ['the enrollment-response-rejected notice', (h) => { h.access.redeem = () => json({ not: 'a grant' }); return h.service.connect(SECOND_INVITE); }, { state: 'enrollment-response-rejected', notice: 'enrollment-response-rejected' }],
];
const NOTICES = ENROLLED_STATES.filter(([, , view]) => view.notice !== null);

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'clubhouse-feedback-sdk-'));
  keychain = fakeKeychain();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('This test must not reach the network'); }));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});


import { appendFileSync } from 'fs';
const refused = (h: Harness) => { h.access.redeem = () => json({ ...h.grant(SECOND_TOKEN, 's'), gameId: 'other-app' }); };
const clean = (h: Harness) => { h.access.redeem = () => json(h.grant(SECOND_TOKEN, 's')); };
const N = Number(process.env.PROBE_N ?? 100);
const MODE = process.env.PROBE_MODE ?? 'settled';
const OUT = process.env.PROBE_OUT ?? 'probe-results.jsonl';
const tok = (t: string | null | undefined) => (t ? t.slice(0, 8) : null);
const tokenFor = (ref: string, ids: string[]) => createHash('sha256').update(['framebriar-release-v1', ref, ...[...ids].sort()].join('\n')).digest('hex');
let keptSuccessTrace = false;

describe('windows probe', () => {
  it.each(Array.from({ length: N }, (_, i) => i))(`${MODE} %i`, async (i) => {
    Object.assign(fsProbe, { t0: performance.now(), trace: [], errors: [], syncMs: 0, syncs: 0, renameMs: 0, renames: 0, readMs: 0, reads: 0, step: 'setup' });
    fsProbe.inflightReads.clear();
    const h = harness();
    const steps: Record<string, number> = {};
    const step = async <T>(name: string, fn: () => Promise<T>) => {
      fsProbe.step = name;
      const t = performance.now();
      try { return await fn(); } finally { steps[name] = Math.round(performance.now() - t); }
    };
    const row: Record<string, unknown> = { mode: MODE, i };
    try {
      await step('connect1', () => h.service.connect(FIRST_INVITE));
      const views: string[] = [];
      h.fb().outbox.subscribe((v) => { views.push(`${Math.round(performance.now() - fsProbe.t0)}ms held=${v.heldForEnrollment} token=${tok(v.releaseToken)} state=${v.state}`); fsProbe.trace.push(`view held=${v.heldForEnrollment} token=${tok(v.releaseToken)}`); });
      h.fb().access.subscribe((v) => { fsProbe.trace.push(`access ${v.state}`); });
      const draft = await step('capture', () => h.capture());
      await step('send', () => h.send(draft.draftId));
      refused(h);
      await step('refusedConnect', () => h.service.connect(SECOND_INVITE));
      await step('disconnect', () => h.service.disconnect());
      await step('settledUnenrolled', () => h.settled(1, false));
      clean(h);
      await step('connect2', () => h.service.connect(SECOND_INVITE));
      const shown = await step('settledEnrolled', () => h.settled(1));
      if (MODE === 'host') await step('personConfirms', () => new Promise((r) => setTimeout(r, 400)));
      const r = await step('release', () => h.service.releaseHeldReports(shown.releaseToken as string));
      fsProbe.step = 'after';
      Object.assign(row, { released: r.released, remaining: r.remaining, failed: r.failed, code: r.code ?? null, shownToken: tok(shown.releaseToken), shownHeld: shown.heldForEnrollment, afterToken: tok(r.status.outbox.releaseToken), afterHeld: r.status.outbox.heldForEnrollment });
      const snap = await h.fb().access.enrollmentState();
      const ids = (await h.fb().outbox.list()).map((x) => x.id);
      row.enrollment = { active: snap.active, hasRef: !!snap.enrollmentRef };
      row.shownTokenWasCurrent = shown.releaseToken === tokenFor(snap.enrollmentRef as string, ids);
      if (r.failed > 0) {
        // Does Send work again, as the dialog leaves it enabled?
        const again = await h.service.releaseHeldReports(r.status.outbox.releaseToken as string);
        row.retry = { released: again.released, remaining: again.remaining, failed: again.failed, code: again.code ?? null };
      }
      row.views = views.length;
    } catch (e) {
      row.threw = String((e as Error).message).slice(0, 160);
      row.statusAtThrow = { held: h.service.status().outbox.heldForEnrollment, tokenShown: h.service.status().outbox.releaseToken !== null, state: h.service.status().state };
    }
    Object.assign(row, { steps, totalMs: Math.round(performance.now() - fsProbe.t0), syncMs: Math.round(fsProbe.syncMs), syncs: fsProbe.syncs, renameMs: Math.round(fsProbe.renameMs), renames: fsProbe.renames, readMs: Math.round(fsProbe.readMs), reads: fsProbe.reads, errors: fsProbe.errors.slice(0, 20) });
    const failedRun = row.threw || row.code || (row.failed as number) > 0;
    if (failedRun || !keptSuccessTrace) { row.trace = fsProbe.trace.slice(-160); if (!failedRun) keptSuccessTrace = true; }
    appendFileSync(OUT, JSON.stringify(row) + '\n');
  }, 30_000);
});
