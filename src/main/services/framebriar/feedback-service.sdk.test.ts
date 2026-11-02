/**
 * The report field against the real vendored SDK: secure store, access, feedback and outbox on
 * a temp directory. Only safeStorage and the network are fakes; global fetch refuses, so nothing
 * here can reach a server (#2658).
 *
 * How enrollment moves in the SDK (access.mjs): canCapture is optedIn. A notice keeps the optedIn
 * it was raised with, and restores it after a restart, so `expired`, `access-required` and
 * `connection-uncertain` never turn an enrolled install off. Only disconnect turns it off, or
 * finding the stored enrollment gone. An invitation that fails on a fresh install leaves it off.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFramebriar, type Framebriar } from '../../vendor/framebriar/adapters/node/index.mjs';
import { asyncOnlySafeStorage, fakeKeychain } from '../../telemetry/__test-utils__/fake-safe-storage';
import type { FeedbackDiagnostics } from '../../../shared/feedback-types';
import { toDiagnosticsV1 } from './feedback-diagnostics-v1';
import { FeedbackService } from './feedback-service';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fake-image-bytes')]);
const FIRST_INVITE = 'a'.repeat(43);
const SECOND_INVITE = 'b'.repeat(43);
const FIRST_TOKEN = 't'.repeat(43);
const SECOND_TOKEN = 'u'.repeat(43);
const AVAILABLE: FeedbackDiagnostics = {
  status: 'available', windowStart: '2026-11-01T11:30:00.000Z', windowEnd: '2026-11-01T12:00:00.000Z', bytes: 100, dropped: 0,
  lines: [{ at: '2026-11-01T11:59:00.000Z', level: 'warn', ns: 'core:annex', event: 'annex.ws.disconnected', attrs: { closeCode: 1009 } }],
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** Access and outbox calls the shipped typings leave out; both are in the vendored source. */
type RealSdk = Framebriar & {
  access: Framebriar['access'] & { refresh(): Promise<unknown> };
  outbox: Framebriar['outbox'] & { dir: string; list(): Promise<Array<{ id: string; code: string | null }>>; resume(): Promise<void> };
};

const cleanups: Array<() => Promise<void> | void> = [];
let dataDir: string;
let keychain: ReturnType<typeof fakeKeychain>;

function harness({ reportDiagnosticsField = true, online = false }: { reportDiagnosticsField?: boolean; online?: boolean } = {}) {
  const state = { now: NOW, online, statusThrows: false };
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
  const excerpt = vi.fn();
  const service = new FeedbackService({
    safeStorage: asyncOnlySafeStorage(keychain), dataDir, appVersion: '0.42.0', isOnline: () => state.online,
    create: ((opts: Parameters<typeof createFramebriar>[0]) => {
      sdk = createFramebriar({
        ...opts, endpoint: 'https://framebriar.test/api', fetchImpl: fetchImpl as never,
        // access.status() reads the clock, so this makes the SDK's real status() throw.
        now: () => { if (state.statusThrows) throw new Error('clock broke'); return state.now; },
      }) as RealSdk;
      return sdk;
    }) as never,
    now: () => state.now, captureCorrelation: () => ({ data: {} }) as never,
    diagnostics: () => AVAILABLE, createExcerptTelemetry: excerpt as never, reportDiagnosticsField,
  });
  cleanups.push(async () => { state.statusThrows = false; await service.shutdown(); });
  return {
    service, state, access, excerpt, reports, grant,
    fb: () => sdk as RealSdk,
    capture: () => service.captureDraft(async () => PNG),
    send: (draftId: string, includeDiagnostics = true) => service.send({ draftId, notes: 'it broke', includeScreenshot: true, includeDiagnostics }),
    saved: async () => {
      const items = await (sdk as RealSdk).outbox.list();
      return items.map((item) => JSON.parse(readFileSync(join((sdk as RealSdk).outbox.dir, 'reports', item.id, 'report.json'), 'utf-8')).report);
    },
  };
}
type Harness = ReturnType<typeof harness>;

/** Enrolled, with the redeem held open: `release` lets it finish. */
function holdRedeem(h: Harness) {
  let release!: (response: Response) => void;
  h.access.redeem = () => new Promise<Response>((resolve) => { release = resolve; });
  const connecting = h.service.connect(SECOND_INVITE);
  cleanups.unshift(async () => { release?.(json({}, 401)); await connecting; });
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
  ['the connection-uncertain notice', (h) => { h.access.redeem = () => json({ not: 'a grant' }); return h.service.connect(SECOND_INVITE); }, { state: 'connection-uncertain', notice: 'connection-uncertain' }],
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

describe('the report field with the real SDK', () => {
  describe.each([
    ['opened while connected', true],
    ['opened in that state', false],
  ])('enrolled, report %s', (_name, captureFirst) => {
    it.each(ENROLLED_STATES)('%s: saved in the outbox as attached', async (_state, enter, view) => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      const before = captureFirst ? await h.capture() : undefined;
      await enter(h);
      expect(h.fb().access.status()).toMatchObject({ ...view, enrolled: true, canCapture: true });
      const draft = before ?? await h.capture();
      await expect(h.send(draft.draftId)).resolves.toMatchObject({ status: 'saved-local', diagnostics: { status: 'attached', lines: 1 } });
      const [report, ...others] = await h.saved();
      expect(others).toEqual([]);
      expect(report.diagnostics).toMatchObject({ v: 1, state: 'attached', lines: 1, entries: [{ event: 'annex.ws.disconnected', attrs: { closeCode: 1009 } }] });
      expect(JSON.stringify(report.breadcrumbs)).toContain('diagnostics.attached');
      expect(h.excerpt).not.toHaveBeenCalled();
    });
  });

  it.each(NOTICES)('%s leaves an enrolled install enrolled after a restart', async (_name, enter, view) => {
    const before = harness();
    await before.service.connect(FIRST_INVITE);
    await enter(before);
    await before.service.shutdown();
    const after = harness();
    await after.service.start();
    expect(after.fb().access.status()).toMatchObject({ notice: view.notice, enrolled: true, canCapture: true });
    const draft = await after.capture();
    await expect(after.send(draft.draftId)).resolves.toMatchObject({ diagnostics: { status: 'attached', lines: 1 } });
  });

  it('opting out while a notice is up saves left_out with no entries', async () => {
    const h = harness();
    await h.service.connect(FIRST_INVITE);
    const draft = await h.capture();
    h.access.refresh = () => json({}, 401);
    await h.fb().access.refresh();
    await expect(h.send(draft.draftId, false)).resolves.toMatchObject({ diagnostics: { status: 'left_out', reason: 'reporter' } });
    const [report] = await h.saved();
    expect(report.diagnostics).toMatchObject({ state: 'left_out', entries: [] });
    expect(h.excerpt).not.toHaveBeenCalled();
  });

  it('with the field off, the same notice still records not_connected and no field', async () => {
    const h = harness({ reportDiagnosticsField: false });
    await h.service.connect(FIRST_INVITE);
    const draft = await h.capture();
    expect(draft).not.toHaveProperty('diagnosticsInReport');
    h.access.refresh = () => json({}, 401);
    await h.fb().access.refresh();
    await expect(h.send(draft.draftId)).resolves.toMatchObject({ diagnostics: { status: 'none', reason: 'not_connected' } });
    const [report] = await h.saved();
    expect(report).not.toHaveProperty('diagnostics');
    expect(h.excerpt).not.toHaveBeenCalled();
  });

  describe('no save when the SDK refuses', () => {
    it('never enrolled: the report can\'t open', async () => {
      const h = harness();
      await h.service.start();
      expect(h.fb().access.status()).toMatchObject({ state: 'disconnected', enrolled: false, canCapture: false });
      await expect(h.capture()).rejects.toMatchObject({ code: 'feedback-unavailable' });
      expect(await h.saved()).toEqual([]);
    });

    it.each([
      ['access-required', () => json({}, 401)],
      ['connection-uncertain', () => json({ not: 'a grant' })],
    ])('a fresh install whose invitation ended in %s stays unenrolled, across a restart', async (notice, redeem) => {
      const h = harness();
      h.access.redeem = redeem;
      await h.service.connect(FIRST_INVITE);
      expect(h.fb().access.status()).toMatchObject({ notice, enrolled: false, canCapture: false });
      await expect(h.capture()).rejects.toMatchObject({ code: 'feedback-unavailable' });
      await h.service.shutdown();
      const after = harness();
      await after.service.start();
      expect(after.fb().access.status()).toMatchObject({ notice, enrolled: false, canCapture: false });
      await expect(after.capture()).rejects.toMatchObject({ code: 'feedback-unavailable' });
      expect(await after.saved()).toEqual([]);
    });

    it('a fresh install while its first invitation is connecting', async () => {
      const h = harness();
      await h.service.start();
      holdRedeem(h);
      await vi.waitFor(() => expect(h.fb().access.status().state).toBe('connecting'));
      expect(h.fb().access.status()).toMatchObject({ enrolled: false, canCapture: false });
      await expect(h.capture()).rejects.toMatchObject({ code: 'feedback-unavailable' });
    });

    it('disconnected during review: nothing is saved, and the review can be retried after enrolling again', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      const draft = await h.capture();
      await h.service.disconnect();
      expect(h.fb().access.status()).toMatchObject({ state: 'disconnected', notice: null, enrolled: false, canCapture: false });
      await expect(h.send(draft.draftId)).rejects.toMatchObject({ code: 'feedback-unavailable' });
      expect(await h.saved()).toEqual([]);
      await h.service.connect(FIRST_INVITE);
      await expect(h.send(draft.draftId)).resolves.toMatchObject({ diagnostics: { status: 'attached', lines: 1 } });
      expect(await h.saved()).toHaveLength(1);
    });

    it('status() throwing during review: fails closed with nothing saved', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      const draft = await h.capture();
      h.state.statusThrows = true;
      expect(() => h.fb().access.status()).toThrow('clock broke');
      await expect(h.send(draft.draftId)).rejects.toMatchObject({ code: 'feedback-unavailable' });
      h.state.statusThrows = false;
      expect(await h.saved()).toEqual([]);
      expect(h.excerpt).not.toHaveBeenCalled();
    });
  });

  /** submit has no eligibility check of its own, and the outbox has none either. What that does today. */
  describe('enrollment changes between prepare and submit', () => {
    const prepareReport = (h: Harness) => h.fb().feedback.prepare({
      notes: 'it broke', png: null, capturedAt: AVAILABLE.windowEnd,
      diagnostics: toDiagnosticsV1(AVAILABLE, { status: 'attached', lines: 1 }),
    } as never);

    it('submit saves it, delivery waits, and a later enrollment delivers it under its own token', async () => {
      const h = harness({ online: true });
      await h.service.connect(FIRST_INVITE);
      const prepared = await prepareReport(h);
      await h.service.disconnect();
      expect(h.fb().access.status().canCapture).toBe(false);

      const ack = await h.fb().feedback.submit(prepared, { includeDiagnostics: true });
      expect(ack).toMatchObject({ status: 'saved-local', reportDiagnostics: 'attached' });
      expect(await h.saved()).toHaveLength(1);

      // No token, so nothing is sent: it waits five minutes at a time, and isn't blocked.
      await vi.waitFor(async () => expect((await h.fb().outbox.list())[0].code).toBe('access-required'), { timeout: 10_000 });
      expect(h.reports).toEqual([]);

      h.access.redeem = () => json(h.grant(SECOND_TOKEN, 's'));
      await h.service.connect(SECOND_INVITE);
      h.state.now += 6 * 60_000;
      await h.fb().outbox.resume();
      await vi.waitFor(() => expect(h.reports).toHaveLength(1), { timeout: 10_000 });
      expect(h.reports[0].authorization).toBe(`Bearer ${SECOND_TOKEN}`);
      expect(h.reports[0].body.id).toBe(ack.id);
      expect(h.reports[0].body.diagnostics).toMatchObject({ state: 'attached', lines: 1 });
      await vi.waitFor(async () => expect(await h.fb().outbox.list()).toEqual([]), { timeout: 10_000 });
    });

    it('through the service: a retry after a failed save skips the check, because it reuses the prepared report', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      // The outbox holds ten reports, so the eleventh prepares and then fails to save.
      for (let i = 0; i < 10; i++) await h.send((await h.capture()).draftId);
      const draft = await h.capture();
      await expect(h.send(draft.draftId)).rejects.toMatchObject({ code: 'storage-full' });

      await h.service.disconnect();
      expect(h.fb().access.status().canCapture).toBe(false);
      const [oldest] = await h.fb().outbox.list();
      const oldestDir = join(h.fb().outbox.dir, 'reports', oldest.id);
      rmSync(oldestDir, { recursive: true, force: true });
      expect(existsSync(oldestDir)).toBe(false);

      await expect(h.send(draft.draftId)).resolves.toMatchObject({ status: 'saved-local', diagnostics: { status: 'attached', lines: 1 } });
      const saved = await h.saved();
      expect(saved).toHaveLength(10);
      expect(saved.every((report) => (report.diagnostics as { state: string }).state === 'attached')).toBe(true);
      expect(h.excerpt).not.toHaveBeenCalled();
    }, 30_000);
  });
});
