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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFramebriar, type Framebriar } from '../../vendor/framebriar/adapters/node/index.mjs';
import { asyncOnlySafeStorage, fakeKeychain } from '../../telemetry/__test-utils__/fake-safe-storage';
import type { FeedbackDiagnostics } from '../../../shared/feedback-types';
import { toDiagnosticsV1 } from './feedback-diagnostics-v1';
import { FeedbackService, type FeedbackLog } from './feedback-service';
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

function harness({ reportDiagnosticsField = true, online = false, log }: { reportDiagnosticsField?: boolean; online?: boolean; log?: FeedbackLog } = {}) {
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
    diagnostics: () => AVAILABLE, createExcerptTelemetry: excerpt as never, reportDiagnosticsField, log,
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
      ['connection-uncertain', notJson],
      ['enrollment-response-rejected', () => json({ not: 'a grant' })],
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

  describe('enrollments longer than 30 days (#2787)', () => {
    const longGrant = (h: Harness, days: number) => ({ ...h.grant(FIRST_TOKEN, 'r'), refreshExpiresAt: new Date(h.state.now + days * DAY).toISOString() });

    it('a 180-day enrollment connects, and survives a restart and a refresh', async () => {
      const h = harness();
      const grant = longGrant(h, 180);
      h.access.redeem = () => json(grant);
      h.access.refresh = () => json(grant);
      await expect(h.service.connect(FIRST_INVITE)).resolves.toMatchObject({ connected: true, status: { state: 'connected', notice: null, expiresAt: grant.refreshExpiresAt } });
      const { enrollmentRef } = await h.fb().access.enrollmentState();
      await h.fb().access.refresh();
      expect(h.service.status()).toMatchObject({ connected: true, expiresAt: grant.refreshExpiresAt });
      await h.service.shutdown();

      const after = harness();
      // Well past the old 30-day limit: the deadline still can't move.
      after.state.now += 40 * DAY;
      after.access.refresh = () => json({ ...grant, expiresAt: new Date(after.state.now + HOUR).toISOString() });
      await after.service.start();
      await vi.waitFor(() => expect(after.service.status().connected).toBe(true));
      expect(after.service.status()).toMatchObject({ notice: null, expiresAt: grant.refreshExpiresAt });
      expect((await after.fb().access.enrollmentState()).enrollmentRef).toBe(enrollmentRef);
      const fetched = after.fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname);
      expect(fetched.every((path) => path.endsWith('/v1/access/refresh'))).toBe(true);
    });

    it.each([
      [365, true],
      [366, false],
    ])('%i days: connected is %s', async (days, connected) => {
      const h = harness();
      h.access.redeem = () => json(longGrant(h, days));
      await expect(h.service.connect(FIRST_INVITE)).resolves.toMatchObject({ connected });
      if (!connected) expect(h.fb().access.status()).toMatchObject({ notice: 'enrollment-response-rejected', noticeReason: 'invalid-deadline' });
    });
  });

  describe('a rejected redeem reply (#2787)', () => {
    const NOTICE = 'enrollment-response-rejected';
    const rejectedStatus = { state: NOTICE, notice: NOTICE, connected: false, expiresAt: null };
    /** Fails redeem validation. The token shape proves nothing is kept from a refused reply. */
    const refused = (h: Harness) => { h.access.redeem = () => json({ ...h.grant(SECOND_TOKEN, 's'), gameId: 'other-app' }); };
    const clean = (h: Harness) => { h.access.redeem = () => json(h.grant(SECOND_TOKEN, 's')); };
    const paths = (h: Harness) => h.fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname);

    /** Enrolled with one report saved, then a replacement invitation is refused. */
    async function rejectedAfterEnrolled(h: Harness) {
      await h.service.connect(FIRST_INVITE);
      const before = await h.send((await h.capture()).draftId) as { id: string };
      const { enrollmentRef } = await h.fb().access.enrollmentState();
      refused(h);
      await expect(h.service.connect(SECOND_INVITE)).resolves.toMatchObject({ connected: false, status: rejectedStatus });
      return { before, enrollmentRef };
    }

    describe('never enrolled', () => {
      it.each<[string, (h: Harness) => object]>([
        ['invalid-deadline', (h) => ({ ...h.grant(FIRST_TOKEN, 'r'), refreshExpiresAt: new Date(h.state.now + 366 * DAY).toISOString() })],
        ['invalid-token', (h) => ({ ...h.grant(FIRST_TOKEN, 'r'), token: 'short' })],
        ['wrong-game', (h) => ({ ...h.grant(FIRST_TOKEN, 'r'), gameId: 'other-app' })],
        ['invalid-response', (h) => ({ ...h.grant(FIRST_TOKEN, 'r'), v: 2 })],
      ])('%s: no capture, the code stays out of the status, and goes to the local log only', async (reason, reply) => {
        const log = vi.fn<FeedbackLog>();
        const h = harness({ log });
        h.access.redeem = () => json(reply(h));
        const { status } = await h.service.connect(FIRST_INVITE);
        expect(status).toMatchObject({ ...rejectedStatus, enrolled: false, canCapture: false });
        expect(h.fb().access.status()).toMatchObject({ noticeReason: reason });
        expect(JSON.stringify(h.service.status())).not.toContain(reason);
        await expect(h.capture()).rejects.toMatchObject({ code: 'feedback-unavailable', message: expect.not.stringMatching(/enrollment/i) });
        expect((await h.fb().store.read())).toMatchObject({ session: null, notice: { state: NOTICE, reason } });
        expect(log).toHaveBeenCalledWith('warn', 'Feedback connect failed', expect.objectContaining({ notice: NOTICE, noticeReason: reason }));
        expect(log).toHaveBeenCalledWith('warn', `Feedback access: ${NOTICE}`, expect.objectContaining({ noticeReason: reason }));
        expect(JSON.stringify(log.mock.calls)).not.toContain(FIRST_TOKEN);
      });

      it('survives a restart with no request, and Disconnect clears it', async () => {
        const h = harness();
        refused(h);
        await h.service.connect(FIRST_INVITE);
        await h.service.shutdown();
        const after = harness();
        await after.service.start();
        expect(after.service.status()).toMatchObject({ ...rejectedStatus, enrolled: false, canCapture: false });
        expect(after.fb().access.status().noticeReason).toBe('wrong-game');
        expect(after.fetchImpl).not.toHaveBeenCalled();
        await expect(after.service.disconnect()).resolves.toMatchObject({ forgotten: true, revoked: null, status: { state: 'disconnected', notice: null } });
        expect(after.fetchImpl).not.toHaveBeenCalled();
      });
    });

    it.each<[string, () => Response]>([
      ['not JSON', notJson],
      ['a JSON array', () => json([1])],
      ['JSON null', () => json(null)],
    ])('a 2xx reply that is %s stays connection-uncertain', async (_name, reply) => {
      const h = harness();
      h.access.redeem = reply;
      const { status } = await h.service.connect(FIRST_INVITE);
      expect(status).toMatchObject({ state: 'connection-uncertain', notice: 'connection-uncertain', connected: false });
      expect(h.fb().access.status().noticeReason).toBeNull();
    });

    describe('previously enrolled', () => {
      it('keeps capture on and the old ref inactive, and a new report binds to it with nothing held', async () => {
        const h = harness();
        const { enrollmentRef } = await rejectedAfterEnrolled(h);
        expect(h.service.status()).toMatchObject({ enrolled: true, canCapture: true });
        await expect(h.fb().access.enrollmentState()).resolves.toEqual({ enrollmentRef, active: false });
        expect(await h.fb().access.getToken()).toBeUndefined();

        const saved = await h.send((await h.capture()).draftId) as { id: string };
        expect(saved).toMatchObject({ status: 'saved-local', diagnostics: { status: 'attached' } });
        const binding = readFileSync(join(h.fb().outbox.dir, 'reports', saved.id, 'binding.json'), 'utf-8');
        expect(JSON.parse(binding)).toEqual({ enrollmentRef });
        await vi.waitFor(() => expect(h.service.status().outbox.pending).toBe(2));
        // The count has to come from pending: the SDK reports none of these as held.
        expect(h.service.status().outbox).toMatchObject({ heldForEnrollment: 0, heldBytes: 0, releaseToken: null, blocked: 0 });
      });

      it('a draft opened before the rejection saves under the same old ref', async () => {
        const h = harness();
        await h.service.connect(FIRST_INVITE);
        const draft = await h.capture();
        const { enrollmentRef } = await h.fb().access.enrollmentState();
        refused(h);
        await h.service.connect(SECOND_INVITE);
        const saved = await h.send(draft.draftId) as { id: string };
        expect(JSON.parse(readFileSync(join(h.fb().outbox.dir, 'reports', saved.id, 'binding.json'), 'utf-8'))).toEqual({ enrollmentRef });
      });

      it('nothing is delivered and nothing is requested, through a flush and a restart', async () => {
        const h = harness({ online: true });
        h.state.online = false;
        const { enrollmentRef } = await rejectedAfterEnrolled(h);
        await h.send((await h.capture()).draftId);
        h.state.online = true;
        h.fetchImpl.mockClear();
        await h.fb().outbox.resume();
        await h.fb().outbox.flush();
        expect(h.fetchImpl).not.toHaveBeenCalled();
        expect(h.reports).toEqual([]);
        expect((await h.fb().outbox.list()).every((item) => item.code !== 'permanent')).toBe(true);
        await h.service.shutdown();

        const after = harness({ online: true });
        await after.service.start();
        await vi.waitFor(() => expect(after.service.status().outbox.pending).toBe(2));
        await after.fb().outbox.flush();
        expect(after.fetchImpl).not.toHaveBeenCalled();
        expect(after.reports).toEqual([]);
        expect(after.service.status()).toMatchObject({ ...rejectedStatus, enrolled: true, canCapture: true, outbox: { heldForEnrollment: 0, releaseToken: null } });
        expect(after.fb().access.status().noticeReason).toBe('wrong-game');
        await expect(after.fb().access.enrollmentState()).resolves.toEqual({ enrollmentRef, active: false });
      });

      it('a new clean invitation restores the connection, holds the reports, and only a release sends them', async () => {
        const h = harness({ online: true });
        h.state.online = false;
        const { before } = await rejectedAfterEnrolled(h);
        const during = await h.send((await h.capture()).draftId) as { id: string };
        const bytes = readFileSync(join(h.fb().outbox.dir, 'reports', during.id, 'report.json'));

        clean(h);
        await expect(h.service.connect(SECOND_INVITE)).resolves.toMatchObject({ connected: true, status: { state: 'connected', notice: null } });
        expect(paths(h)).not.toContain('/api/v1/access/disconnect');
        const { releaseToken } = await h.settled(2);

        h.state.online = true;
        await h.fb().outbox.resume();
        await h.fb().outbox.flush();
        expect(h.reports).toEqual([]);

        await expect(h.service.releaseHeldReports(releaseToken as string)).resolves.toMatchObject({ released: 2, remaining: 0, failed: 0 });
        expect(readFileSync(join(h.fb().outbox.dir, 'reports', during.id, 'report.json')).equals(bytes)).toBe(true);
        await vi.waitFor(() => expect(h.reports).toHaveLength(2), { timeout: 10_000 });
        expect(h.reports.map((report) => report.body.id).sort()).toEqual([before.id, during.id].sort());
        expect(h.reports.every((report) => report.authorization === `Bearer ${SECOND_TOKEN}`)).toBe(true);
        // A second release does nothing, and the queue is empty.
        await expect(h.service.releaseHeldReports(releaseToken as string)).resolves.toMatchObject({ released: 0, code: 'stale-release' });
        await vi.waitFor(() => expect(h.service.status().outbox.pending).toBe(0));
      }, 30_000);

      it('after the new connection, Clear is the other way out: nothing is sent', async () => {
        const h = harness({ online: true });
        h.state.online = false;
        await rejectedAfterEnrolled(h);
        clean(h);
        await h.service.connect(SECOND_INVITE);
        await h.settled(1);
        await expect(h.service.clearHeldReports()).resolves.toMatchObject({ cleared: 1, remaining: 0, failed: 0, status: { outbox: { heldForEnrollment: 0, pending: 0, releaseToken: null } } });
        h.state.online = true;
        await h.fb().outbox.resume();
        await h.fb().outbox.flush();
        expect(h.reports).toEqual([]);
      });

      it('with no new invitation, Disconnect clears the state, keeps the reports, and Clear can delete them', async () => {
        const h = harness();
        await rejectedAfterEnrolled(h);
        await h.send((await h.capture()).draftId);
        await expect(h.service.disconnect()).resolves.toMatchObject({ forgotten: true, revoked: null, status: { state: 'disconnected', notice: null, enrolled: false, canCapture: false, expiresAt: null } });
        expect(paths(h)).not.toContain('/api/v1/access/disconnect');
        const outbox = await h.settled(2, false);
        expect(outbox).toMatchObject({ pending: 2, releaseToken: null });
        await expect(h.service.releaseHeldReports('anything')).resolves.toMatchObject({ released: 0, code: 'not-enrolled' });
        await expect(h.service.clearHeldReports()).resolves.toMatchObject({ cleared: 2, remaining: 0, status: { outbox: { pending: 0 } } });
      });

      it('after Disconnect, a clean invitation can still send them', async () => {
        const h = harness();
        await rejectedAfterEnrolled(h);
        await h.service.disconnect();
        await h.settled(1, false);
        clean(h);
        await h.service.connect(SECOND_INVITE);
        const { releaseToken } = await h.settled(1);
        await expect(h.service.releaseHeldReports(releaseToken as string)).resolves.toMatchObject({ released: 1, remaining: 0 });
      });

      it('a second rejection changes nothing, and release and clear do nothing', async () => {
        const h = harness();
        const { enrollmentRef } = await rejectedAfterEnrolled(h);
        await expect(h.service.connect(SECOND_INVITE)).resolves.toMatchObject({ connected: false, status: rejectedStatus });
        await expect(h.fb().access.enrollmentState()).resolves.toEqual({ enrollmentRef, active: false });
        await expect(h.service.releaseHeldReports('anything')).resolves.toMatchObject({ released: 0, remaining: 0, code: 'not-enrolled' });
        await expect(h.service.clearHeldReports()).resolves.toMatchObject({ cleared: 0, remaining: 0 });
        expect(h.service.status().outbox).toMatchObject({ pending: 1, heldForEnrollment: 0, releaseToken: null });
      });

      it('reports already held stay clearable, with no token to send them, until a new connection', async () => {
        const h = harness();
        await h.service.connect(FIRST_INVITE);
        await h.send((await h.capture()).draftId);
        clean(h);
        await h.service.disconnect();
        await h.service.connect(SECOND_INVITE);
        const shown = (await h.settled(1)).releaseToken as string;
        refused(h);
        await h.service.connect(FIRST_INVITE);
        // The SDK's view still has the old token here: it must not reach the renderer as usable.
        expect(h.service.status().outbox).toMatchObject({ heldForEnrollment: 1, releaseToken: null });
        await expect(h.service.releaseHeldReports(shown)).resolves.toMatchObject({ released: 0, remaining: 1, code: 'not-enrolled' });
        h.access.redeem = () => json(h.grant(SECOND_TOKEN, 'v'));
        await h.service.connect(FIRST_INVITE);
        const { releaseToken } = await h.settled(1);
        expect(releaseToken).not.toBe(shown);
        await expect(h.service.releaseHeldReports(releaseToken as string)).resolves.toMatchObject({ released: 1, remaining: 0 });
      });

      it('a full queue says where to go, with none of them held', async () => {
        const h = harness();
        await h.service.connect(FIRST_INVITE);
        for (let i = 0; i < 10; i++) await h.send((await h.capture()).draftId);
        refused(h);
        await h.service.connect(SECOND_INVITE);
        const draft = await h.capture();
        await expect(h.send(draft.draftId)).rejects.toThrow(/10 saved reports take up space\. Settings, Feedback says how to send or clear them\./);
      }, 30_000);
    });
  });

  describe('upgrading from v0.7.0 (#2787)', () => {
    it('keeps the identity and the queue of a store in the v0.7.0 shape', async () => {
      const h = harness();
      await h.service.connect(FIRST_INVITE);
      const saved = await h.send((await h.capture()).draftId) as { id: string };
      const record = await h.fb().store.read();
      // Nothing new is written for a working enrollment, so v0.7.0 can read it and this can read v0.7.0's.
      expect(Object.keys(record).sort()).toEqual(['enrollmentRef', 'notice', 'revision', 'session']);
      expect(record.notice).toBeNull();
      expect(Object.keys(record.session as object).sort()).toEqual(['expiresAt', 'refreshToken']);
      await h.service.shutdown();

      const after = harness();
      await after.service.start();
      await vi.waitFor(() => expect(after.service.status().connected).toBe(true));
      expect((await after.fb().access.enrollmentState()).enrollmentRef).toBe(record.enrollmentRef);
      await vi.waitFor(() => expect(after.service.status().outbox).toMatchObject({ pending: 1, heldForEnrollment: 0 }));
      expect((await after.saved()).map((report) => report.id)).toEqual([saved.id]);
    });

    it.each([false, true])('someone stuck on v0.7.0\'s connection-uncertain, enrolled %s, stays there with no request, and a spent invitation then reads as used up', async (enrolled) => {
      const h = harness();
      await h.service.start();
      const { revision } = await h.fb().store.read();
      // Exactly what v0.7.0 stores, three keys, for a 45-day reply it refused.
      await h.fb().store.replace(revision, { session: null, notice: { state: 'connection-uncertain', expiresAt: null, enrolled }, ...(enrolled && { enrollmentRef: '11111111-1111-4111-8111-111111111111' }) });
      await h.service.shutdown();

      const after = harness();
      await after.service.start();
      expect(after.service.status()).toMatchObject({ state: 'connection-uncertain', notice: 'connection-uncertain', enrolled, canCapture: enrolled, connected: false });
      expect(after.fetchImpl).not.toHaveBeenCalled();
      after.access.redeem = () => json({}, 401);
      await expect(after.service.connect(FIRST_INVITE)).resolves.toMatchObject({ connected: false, status: { state: 'access-required', notice: 'access-required', enrolled } });
    });
  });
});
