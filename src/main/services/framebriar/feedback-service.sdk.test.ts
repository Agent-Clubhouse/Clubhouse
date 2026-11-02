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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFramebriar, type Framebriar } from '../../vendor/framebriar/adapters/node/index.mjs';
import { asyncOnlySafeStorage, fakeKeychain } from '../../telemetry/__test-utils__/fake-safe-storage';
import type { FeedbackDiagnostics } from '../../../shared/feedback-types';
import { toDiagnosticsV1 } from './feedback-diagnostics-v1';
import { FeedbackService } from './feedback-service';
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

/** Access and outbox calls the shipped typings leave out; both are in the vendored source. */
type RealSdk = Framebriar & {
  access: Framebriar['access'] & { refresh(): Promise<unknown> };
  outbox: Framebriar['outbox'] & { dir: string; list(): Promise<Array<{ id: string; code: string | null }>>; resume(): Promise<void>; flush(): Promise<void> };
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
      sdk = { ...real, feedback: { ...real.feedback, prepare: (input) => { const result = real.feedback.prepare(input); prepared.push(result); return result; } } };
      return sdk;
    }) as never,
    now: () => state.now, captureCorrelation: () => ({ data: {} }) as never,
    diagnostics: () => AVAILABLE, createExcerptTelemetry: excerpt as never, reportDiagnosticsField,
  });
  cleanups.push(async () => { state.statusThrows = false; await service.shutdown(); });
  return {
    service, state, access, excerpt, reports, grant, prepared,
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

    it('disconnected during review: nothing is saved, and enrolling again reopens the review', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      const draft = await h.capture();
      await h.service.disconnect();
      expect(h.fb().access.status()).toMatchObject({ state: 'disconnected', notice: null, enrolled: false, canCapture: false });
      await expect(h.send(draft.draftId)).rejects.toMatchObject({ code: 'feedback-unavailable' });
      expect(await h.saved()).toEqual([]);
      await h.service.connect(FIRST_INVITE);
      // Enrolling again is a new enrollment, even with the same invitation.
      const reopened = await h.send(draft.draftId);
      if (reopened.status !== 'enrollment-changed') throw new Error(`Expected a reopen, got ${reopened.status}`);
      expect(await h.saved()).toEqual([]);
      await expect(h.send(reopened.draft.draftId)).resolves.toMatchObject({ diagnostics: { status: 'attached', lines: 1 } });
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

  /** Bound to an enrollment: the SDK refuses a prepared report under any other (#2697, #2658). */
  describe('enrollment changes between prepare and submit', () => {
    const prepareReport = async (h: Harness) => h.fb().feedback.prepare({
      ...await h.fb().feedback.open(), notes: 'it broke', png: null, capturedAt: AVAILABLE.windowEnd,
      diagnostics: toDiagnosticsV1(AVAILABLE, { status: 'attached', lines: 1 }),
    });

    it('a supplied prepare without the ref is invalid input', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      await expect(h.fb().feedback.prepare({ notes: 'it broke', png: null })).rejects.toMatchObject({ code: 'invalid-input' });
    });

    it('submit refuses it with enrollment-changed and saves nothing, at disconnect and at a later enrollment', async () => {
      const h = harness({ online: true });
      await h.service.connect(FIRST_INVITE);
      const prepared = await prepareReport(h);
      await h.service.disconnect();
      expect(h.fb().access.status().canCapture).toBe(false);
      await expect(h.fb().feedback.submit(prepared, { includeDiagnostics: true })).rejects.toMatchObject({ code: 'enrollment-changed' });

      h.access.redeem = () => json(h.grant(SECOND_TOKEN, 's'));
      await h.service.connect(SECOND_INVITE);
      await expect(h.fb().feedback.submit(prepared, { includeDiagnostics: true })).rejects.toMatchObject({ code: 'enrollment-changed' });
      expect(await h.saved()).toEqual([]);
      expect(h.reports).toEqual([]);
    });

    /** Ten reports fill the outbox, so the next one prepares and then fails to save. */
    async function failedSave(h: Harness, notes = 'it broke') {
      for (let i = 0; i < 10; i++) await h.send((await h.capture()).draftId);
      const draft = await h.capture();
      await expect(h.service.send({ draftId: draft.draftId, notes, includeScreenshot: true, includeDiagnostics: true })).rejects.toMatchObject({ code: 'storage-full' });
      return draft;
    }
    async function makeRoom(h: Harness) {
      const [oldest] = await h.fb().outbox.list();
      const oldestDir = join(h.fb().outbox.dir, 'reports', oldest.id);
      rmSync(oldestDir, { recursive: true, force: true });
      expect(existsSync(oldestDir)).toBe(false);
    }

    it('through the service: a retry under the same enrollment keeps the report id and bytes', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      const before = h.prepared.length;
      const draft = await failedSave(h);
      const first = await h.prepared.at(-1) as { report: { id: string } };
      await makeRoom(h);
      const result = await h.send(draft.draftId);
      expect(result).toMatchObject({ status: 'saved-local', id: first.report.id });
      // Ten reports and the one retried, prepared once.
      expect(h.prepared).toHaveLength(before + 11);
      const saved = (await h.saved()).find((report) => report.id === first.report.id);
      expect(JSON.stringify(saved)).toBe(JSON.stringify(first.report));
    }, 30_000);

    it('through the service: a retry after a change reopens with a new id, and only a new Send saves', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      const draft = await failedSave(h);
      const old = await h.prepared.at(-1) as { report: { id: string; capturedAt: string } };
      await h.service.disconnect();
      await makeRoom(h);

      // Disconnected: nothing can open, the cached report is gone and the draft waits.
      await expect(h.send(draft.draftId)).rejects.toMatchObject({ code: 'feedback-unavailable' });
      h.access.redeem = () => json(h.grant(SECOND_TOKEN, 's'));
      await h.service.connect(SECOND_INVITE);
      h.state.now += 60_000;
      const count = (await h.saved()).length;
      const result = await h.send(draft.draftId);
      expect(result.status).toBe('enrollment-changed');
      const next = (result as Extract<typeof result, { status: 'enrollment-changed' }>).draft;
      expect(next.draftId).not.toBe(draft.draftId);
      expect(await h.saved()).toHaveLength(count);
      await expect(h.send(draft.draftId)).rejects.toMatchObject({ code: 'screenshot-expired' });

      const sent = await h.send(next.draftId);
      expect(sent.status).toBe('saved-local');
      const saved = (await h.saved()).find((report) => report.id === (sent as { id: string }).id);
      expect(saved?.id).not.toBe(old.report.id);
      expect(saved?.capturedAt).not.toBe(old.report.capturedAt);
      expect(await h.saved()).toHaveLength(count + 1);
      expect(h.excerpt).not.toHaveBeenCalled();
    }, 30_000);

    it('reopens at prepare too, carrying only the reviewed drawing', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      const shot = pngOf(4, 3, 'shot');
      const drawn = pngOf(4, 3, 'ink');
      const draft = await h.service.captureDraft([{ label: 'Main window', grab: async () => shot }, { label: 'Pop-out', grab: async () => pngOf(4, 3, 'other') }]);
      expect(draft.shots).toHaveLength(2);
      await h.service.disconnect();
      h.access.redeem = () => json(h.grant(SECOND_TOKEN, 's'));
      await h.service.connect(SECOND_INVITE);
      const result = await h.service.send({ draftId: draft.draftId, notes: 'the note', includeScreenshot: true, shotId: 's0', annotatedPng: drawn.toString('base64') });
      if (result.status !== 'enrollment-changed') throw new Error(`Expected a reopen, got ${result.status}`);
      expect(result.draft.shots.map((s) => [s.shotId, s.label, s.preview])).toEqual([['s0', 'Main window', `data:image/png;base64,${drawn.toString('base64')}`]]);
      expect(JSON.stringify(result.draft)).not.toContain('enrollmentRef');
    });

    it('a Send that left the screenshot out carries no image', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      const draft = await h.capture();
      await h.service.disconnect();
      h.access.redeem = () => json(h.grant(SECOND_TOKEN, 's'));
      await h.service.connect(SECOND_INVITE);
      const result = await h.service.send({ draftId: draft.draftId, notes: 'the note', includeScreenshot: false });
      if (result.status !== 'enrollment-changed') throw new Error(`Expected a reopen, got ${result.status}`);
      expect(result.draft.preview).toBeNull();
      expect(result.draft.shots).toEqual([]);
    });

    it('an edited retry after a change reopens rather than asking for the old text', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      const draft = await failedSave(h);
      await h.service.disconnect();
      h.access.redeem = () => json(h.grant(SECOND_TOKEN, 's'));
      await h.service.connect(SECOND_INVITE);
      await expect(h.service.send({ draftId: draft.draftId, notes: 'edited', includeScreenshot: true, includeDiagnostics: true })).resolves.toMatchObject({ status: 'enrollment-changed' });
    }, 30_000);

    it('an edited retry under the same enrollment is still refused', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      const draft = await failedSave(h);
      await expect(h.service.send({ draftId: draft.draftId, notes: 'edited', includeScreenshot: true, includeDiagnostics: true })).rejects.toMatchObject({ code: 'feedback-review-changed' });
    }, 30_000);
  });

  it('keeps the ref out of the report bytes and the renderer, and beside the report on disk', async () => {
    const h = harness();
    await h.service.connect(FIRST_INVITE);
    const { enrollmentRef } = await h.fb().access.enrollmentState();
    expect(enrollmentRef).toEqual(expect.any(String));
    const draft = await h.capture();
    expect(JSON.stringify(draft)).not.toContain(enrollmentRef);
    const result = await h.send(draft.draftId);
    expect(JSON.stringify(result)).not.toContain(enrollmentRef);
    expect(JSON.stringify(h.service.status())).not.toContain(enrollmentRef);
    const dir = join(h.fb().outbox.dir, 'reports', (result as { id: string }).id);
    expect(readFileSync(join(dir, 'report.json'), 'utf-8')).not.toContain(enrollmentRef);
    expect(JSON.parse(readFileSync(join(dir, 'binding.json'), 'utf-8'))).toEqual({ enrollmentRef });
  });

  describe('held reports', () => {
    /** One report saved under the first enrollment, then a second enrollment. */
    async function heldReport(h: Harness) {
      await h.service.connect(FIRST_INVITE);
      const saved = await h.send((await h.capture()).draftId) as { id: string };
      const bytes = readFileSync(join(h.fb().outbox.dir, 'reports', saved.id, 'report.json'));
      h.access.redeem = () => json(h.grant(SECOND_TOKEN, 's'));
      await h.service.disconnect();
      await h.service.connect(SECOND_INVITE);
      await h.settled(1);
      return { id: saved.id, bytes };
    }

    it('shows up in status, in the fixture shape, and is never delivered on its own', async () => {
      const h = harness({ online: true });
      h.state.online = false;
      await heldReport(h);
      h.state.online = true;
      await h.fb().outbox.resume();
      await h.fb().outbox.flush();
      expect(h.reports).toEqual([]);
      const { outbox } = h.service.status();
      expect(Object.keys(fixture.status.heldWhileEnrolled)).toEqual(expect.arrayContaining(['heldForEnrollment', 'heldBytes', 'releaseToken']));
      expect(outbox).toMatchObject({ pending: 1, blocked: 0, heldForEnrollment: 1, heldBytes: PNG.length, releaseToken: expect.any(String) });
    });

    it('releases with the confirmed token, queued under the new enrollment with the same bytes', async () => {
      const h = harness();
      const { id, bytes } = await heldReport(h);
      const token = h.service.status().outbox.releaseToken as string;
      await expect(h.service.releaseHeldReports(token)).resolves.toMatchObject({ released: 1, remaining: 0, failed: 0, status: { outbox: { heldForEnrollment: 0, releaseToken: null, pending: 1 } } });
      expect(readFileSync(join(h.fb().outbox.dir, 'reports', id, 'report.json')).equals(bytes)).toBe(true);
      expect(h.reports).toEqual([]);
      h.state.online = true;
      await h.fb().outbox.resume();
      await vi.waitFor(() => expect(h.reports).toHaveLength(1), { timeout: 10_000 });
      expect(h.reports[0].authorization).toBe(`Bearer ${SECOND_TOKEN}`);
      expect(h.reports[0].body.id).toBe(id);
    });

    it('a stale token changes nothing, and the refreshed status has the token to ask with', async () => {
      const h = harness();
      await heldReport(h);
      const shown = h.service.status().outbox.releaseToken as string;
      const held = await h.send((await h.capture()).draftId) as { id: string };
      // A third enrollment holds the second report too, so the shown token no longer matches.
      h.access.redeem = () => json(h.grant(SECOND_TOKEN, 'v'));
      await h.service.disconnect();
      await h.service.connect(SECOND_INVITE);
      await h.settled(2);
      expect(held.id).toEqual(expect.any(String));
      const result = await h.service.releaseHeldReports(shown);
      expect(result).toMatchObject({ released: 0, remaining: 2, failed: 0, code: 'stale-release', status: { outbox: { heldForEnrollment: 2 } } });
      expect(result.status.outbox.releaseToken).toEqual(expect.any(String));
      expect(result.status.outbox.releaseToken).not.toBe(shown);
      await expect(h.service.releaseHeldReports(result.status.outbox.releaseToken as string)).resolves.toMatchObject({ released: 2, remaining: 0 });
    });

    it('a second release of the same token is stale', async () => {
      const h = harness();
      await heldReport(h);
      const token = h.service.status().outbox.releaseToken as string;
      await h.service.releaseHeldReports(token);
      await expect(h.service.releaseHeldReports(token)).resolves.toMatchObject(fixture.release.double);
    });

    it('never reads a token of its own: an empty one is stale', async () => {
      const h = harness();
      await heldReport(h);
      await expect(h.service.releaseHeldReports('')).resolves.toMatchObject({ released: 0, remaining: 1, code: 'stale-release' });
    });

    it('a partial release reports released, remaining and failed, with a new token', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      await h.send((await h.capture()).draftId);
      const stuck = await h.send((await h.capture()).draftId) as { id: string };
      h.access.redeem = () => json(h.grant(SECOND_TOKEN, 's'));
      await h.service.disconnect();
      await h.service.connect(SECOND_INVITE);
      const shown = (await h.settled(2)).releaseToken as string;
      const binding = join(h.fb().outbox.dir, 'reports', stuck.id, 'binding.json');
      rmSync(binding);
      mkdirSync(binding);
      const result = await h.service.releaseHeldReports(shown);
      // A directory there reads as unbound, which changes nothing about the held set.
      expect(result).toMatchObject(fixture.release.partial);
      expect(result.status.outbox).toMatchObject({ heldForEnrollment: 1, releaseToken: expect.any(String) });
      expect(result.status.outbox.releaseToken).not.toBe(shown);
    });

    it('while unenrolled: no token, release refuses, and clear works', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      await h.send((await h.capture()).draftId);
      await h.send((await h.capture()).draftId);
      await h.service.disconnect();
      await h.settled(2, false);
      await expect(h.service.releaseHeldReports('anything')).resolves.toMatchObject(fixture.release.notEnrolled);
      await expect(h.service.clearHeldReports()).resolves.toMatchObject({ ...fixture.clear.whileUnenrolled, status: { outbox: { heldForEnrollment: 0, pending: 0 } } });
      expect(await h.saved()).toEqual([]);
      expect(h.reports).toEqual([]);
    });

    it('clear leaves a report of the current enrollment alone', async () => {
      const h = harness();
      await heldReport(h);
      const current = await h.send((await h.capture()).draftId) as { id: string };
      await expect(h.service.clearHeldReports()).resolves.toMatchObject({ cleared: 1, remaining: 0, failed: 0 });
      expect((await h.saved()).map((report) => report.id)).toEqual([current.id]);
    });

    it('a full queue of held reports says where to go', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      for (let i = 0; i < 10; i++) await h.send((await h.capture()).draftId);
      h.access.redeem = () => json(h.grant(SECOND_TOKEN, 's'));
      await h.service.disconnect();
      await h.service.connect(SECOND_INVITE);
      const draft = await h.capture();
      await expect(h.send(draft.draftId)).rejects.toThrow(/10 held reports take up space\. You can send or clear them in Settings, Feedback\./);
    }, 30_000);
  });
});
