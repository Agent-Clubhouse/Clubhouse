import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFeedback, createTelemetry, type Framebriar } from '../../vendor/framebriar/adapters/node/index.mjs';
import incidentFixture from './fixtures/incident-report-v1.json';
import { asyncOnlySafeStorage, fakeKeychain } from '../../telemetry/__test-utils__/fake-safe-storage';
import type { FeedbackDiagnostics } from '../../../shared/feedback-types';
import { FeedbackService, type FeedbackServiceDeps } from './feedback-service';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fake-image-bytes')]);
const REPORT_ID = '0b5c6a2e-1f3d-4c8e-9a7b-2d4e6f8a0c1e';
const SESSION = 'session-1';
const WINDOW = { windowStart: '2026-11-01T11:30:00.000Z', windowEnd: '2026-11-01T12:00:00.000Z' };
const AVAILABLE: FeedbackDiagnostics = {
  status: 'available', ...WINDOW, bytes: 100, dropped: 0,
  lines: [{ at: '2026-11-01T11:59:00.000Z', level: 'warn', ns: 'core:annex', event: 'annex.ws.disconnected', attrs: { closeCode: 1009 } }],
};

function fakeSdk(submit?: () => Promise<unknown>) {
  let access = { state: 'connected', connected: true, enrolled: true, canCapture: true, notice: null as string | null, expiresAt: null };
  const fb = {
    store: { probeAsync: async () => ({ available: true }) },
    access: { endpoint: 'https://fb.example', gameId: 'clubhouse', status: () => access, subscribe: () => () => {}, getToken: async () => 'upload-credential' },
    outbox: { status: () => ({ state: 'available', items: 0, bytes: 0, maxItems: 10, maxBytes: 1, blocked: 0, retention: 'until-delivered-or-cleared' }) },
    feedback: {
      sessionId: SESSION,
      open: vi.fn(async () => ({ capturedAt: WINDOW.windowEnd })),
      prepare: vi.fn(async (input: Record<string, unknown>) => ({ report: { id: REPORT_ID }, png: input.png, input })),
      submit: vi.fn(submit ?? (async () => ({ id: REPORT_ID, status: 'saved-local' }))),
    },
    start: async () => {},
    shutdown: async () => {},
  };
  return { fb, setAccess: (over: Partial<typeof access>) => { access = { ...access, ...over }; } };
}

function fakeExcerpt(stats: Partial<{ sent: number; dropped: number; buffered: number; forbidden: boolean }> = {}) {
  const telemetry = {
    log: vi.fn(),
    feedbackSubmitted: vi.fn(async () => ({ marked: true, excerpt: 1 })),
    stats: vi.fn(() => ({ sent: 2, dropped: 0, buffered: 0, forbidden: false, ...stats })),
    dispose: vi.fn(),
  };
  return telemetry;
}

function serviceWith(fb: unknown, deps: Partial<FeedbackServiceDeps> = {}) {
  const log = vi.fn();
  const s = new FeedbackService({
    safeStorage: asyncOnlySafeStorage(fakeKeychain()), dataDir: '/data', appVersion: '0.42.0', isOnline: () => true,
    create: (() => fb as Framebriar) as never, now: () => NOW, log, captureCorrelation: () => ({ data: {} }) as never,
    diagnostics: () => AVAILABLE, ...deps,
  });
  return { s, log };
}

const capture = (s: FeedbackService) => s.captureDraft(async () => PNG);
const crumbs = (fb: ReturnType<typeof fakeSdk>['fb']) => (fb.feedback.prepare.mock.lastCall![0] as { context: { breadcrumbs: Array<{ code: string; value?: number }> } }).context.breadcrumbs;

afterEach(() => vi.restoreAllMocks());

describe('FeedbackService diagnostics', () => {
  it('shows the lines at review and sends exactly those after the report is saved', async () => {
    const { fb } = fakeSdk();
    const excerpt = fakeExcerpt();
    const create = vi.fn(() => excerpt) as never;
    const { s, log } = serviceWith(fb, { createExcerptTelemetry: create, buildSha: 'abc1234' });
    const draft = await capture(s);
    expect(draft.diagnostics).toEqual(AVAILABLE);
    expect(create).not.toHaveBeenCalled();
    const result = await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true });
    expect(result.diagnostics).toEqual({ status: 'queued', lines: 1 });
    expect(crumbs(fb)[0]).toMatchObject({ code: 'diagnostics.queued', value: 1 });
    expect(fb.feedback.submit.mock.lastCall).toEqual([expect.anything(), { includeDiagnostics: false }]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'excerpt-only', sessionId: SESSION, buildSha: 'abc1234' }));
    expect(excerpt.log).toHaveBeenCalledTimes(1);
    expect(excerpt.log).toHaveBeenCalledWith('warn', 'annex.ws.disconnected', { 'clubhouse.ns': 'core:annex', 'clubhouse.closeCode': 1009 }, { time: Date.parse(AVAILABLE.lines[0].at), parent: null });
    expect(excerpt.feedbackSubmitted).toHaveBeenCalledWith({ reportId: REPORT_ID, includeDiagnostics: true });
    await vi.waitFor(() => expect(excerpt.dispose).toHaveBeenCalled());
    expect(log).toHaveBeenCalledWith('info', 'Feedback diagnostics sent', { id: REPORT_ID, lines: 1 });
    expect(log).toHaveBeenCalledWith('info', 'Feedback saved for delivery', expect.objectContaining({ id: REPORT_ID, diagnostics: 'diagnostics.queued' }));
  });

  it('freezes the lines when feedback opens: later logs are not added', async () => {
    const { fb } = fakeSdk();
    const excerpt = fakeExcerpt();
    const diagnostics = vi.fn(() => AVAILABLE);
    const { s } = serviceWith(fb, { diagnostics, createExcerptTelemetry: (() => excerpt) as never });
    const draft = await capture(s);
    await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true });
    expect(diagnostics).toHaveBeenCalledTimes(1);
  });

  it.each([[false], [undefined]])('leaves them out when includeDiagnostics is %s, and sends nothing', async (includeDiagnostics) => {
    const { fb } = fakeSdk();
    const create = vi.fn() as never;
    const { s } = serviceWith(fb, { createExcerptTelemetry: create });
    const draft = await capture(s);
    const result = await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics });
    expect(result.diagnostics).toEqual({ status: 'left_out', reason: 'reporter' });
    expect(crumbs(fb)[0].code).toBe('diagnostics.left_out.reporter');
    expect(create).not.toHaveBeenCalled();
  });

  it('says none are available when there are no lines', async () => {
    const { fb } = fakeSdk();
    const { s } = serviceWith(fb, { diagnostics: () => ({ status: 'none', reason: 'no_lines', ...WINDOW, lines: [], bytes: 0, dropped: 0 }) });
    const draft = await capture(s);
    const result = await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true });
    expect(result.diagnostics).toEqual({ status: 'none', reason: 'no_lines' });
    expect(crumbs(fb)[0].code).toBe('diagnostics.none.no_lines');
  });

  it('records no_review for a report with no draft: nothing unreviewed is ever sent', async () => {
    const { fb } = fakeSdk();
    const create = vi.fn() as never;
    const { s } = serviceWith(fb, { createExcerptTelemetry: create });
    const result = await s.send({ notes: 'text only', includeScreenshot: false, includeDiagnostics: true });
    expect(result.diagnostics).toEqual({ status: 'none', reason: 'no_review' });
    expect(create).not.toHaveBeenCalled();
  });

  it('records not_connected instead of claiming the lines are queued', async () => {
    const { fb, setAccess } = fakeSdk();
    const create = vi.fn() as never;
    const { s } = serviceWith(fb, { createExcerptTelemetry: create });
    const draft = await capture(s);
    setAccess({ notice: 'expired' });
    const result = await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true });
    expect(result.diagnostics).toEqual({ status: 'none', reason: 'not_connected' });
    expect(create).not.toHaveBeenCalled();
  });

  describe('report.diagnostics gate', () => {
    const preparedInput = (fb: ReturnType<typeof fakeSdk>['fb']) => fb.feedback.prepare.mock.lastCall![0] as Record<string, unknown>;

    it('is off by default: the report carries no diagnostics field, whatever the reporter chose', async () => {
      for (const includeDiagnostics of [true, false]) {
        const { fb } = fakeSdk();
        const { s } = serviceWith(fb, { createExcerptTelemetry: (() => fakeExcerpt()) as never });
        const draft = await capture(s);
        await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics });
        expect(preparedInput(fb)).not.toHaveProperty('diagnostics');
        expect(JSON.stringify(preparedInput(fb).context)).not.toContain('annex.ws.disconnected');
      }
    });

    it('is not turned on by the app wiring', () => {
      expect(readFileSync(join(__dirname, 'index.ts'), 'utf-8')).not.toContain('reportDiagnosticsField');
    });

    it('fills the frozen v1 shape only when explicitly on', async () => {
      const { fb } = fakeSdk();
      const { s } = serviceWith(fb, { reportDiagnosticsField: true, createExcerptTelemetry: (() => fakeExcerpt()) as never });
      const draft = await capture(s);
      await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true });
      expect(preparedInput(fb).diagnostics).toMatchObject({ state: 'attached', lines: 1, entries: [{ event: 'annex.ws.disconnected', attrs: { closeCode: 1009 } }], delivery: { queued: 0 } });
    });

    it('omits the outbox count when it can\'t be read at capture', async () => {
      const { fb } = fakeSdk();
      const status = vi.spyOn(fb.outbox, 'status');
      // Starting reads the status too, so only break the read that follows open().
      fb.feedback.open.mockImplementationOnce(async () => { status.mockImplementationOnce(() => { throw new Error('outbox broke'); }); return { capturedAt: WINDOW.windowEnd }; });
      const { s } = serviceWith(fb, { reportDiagnosticsField: true, createExcerptTelemetry: (() => fakeExcerpt()) as never });
      const draft = await capture(s);
      await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true });
      expect(preparedInput(fb).diagnostics).not.toHaveProperty('delivery');
    });

    it('counts the outbox at capture, not at send', async () => {
      const { fb } = fakeSdk();
      const status = fb.outbox.status();
      const items = vi.spyOn(fb.outbox, 'status').mockReturnValue({ ...status, items: 4 });
      const { s } = serviceWith(fb, { reportDiagnosticsField: true, createExcerptTelemetry: (() => fakeExcerpt()) as never });
      const draft = await capture(s);
      items.mockReturnValue({ ...status, items: 9 });
      await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true });
      expect((preparedInput(fb).diagnostics as { delivery: unknown }).delivery).toEqual({ queued: 4 });
    });
  });

  it('keeps the status within the 40 breadcrumb cap', async () => {
    const { fb } = fakeSdk();
    const many = Array.from({ length: 45 }, (_, i) => ({ kind: 'event' as const, atMs: i, code: 'view.agent' }));
    const { s } = serviceWith(fb, { breadcrumbs: () => many });
    await s.send({ notes: 'x', includeScreenshot: false });
    expect(crumbs(fb)).toHaveLength(40);
    expect(crumbs(fb)[0].code).toBe('diagnostics.none.no_review');
  });

  describe('delivery when collection or sending fails', () => {
    it('still opens and delivers when collection throws, and says why', async () => {
      const { fb } = fakeSdk();
      const { s, log } = serviceWith(fb, { diagnostics: () => { throw new Error('ring broke'); } });
      const draft = await capture(s);
      expect(draft.diagnostics).toMatchObject({ status: 'none', reason: 'collection_failed', lines: [] });
      const result = await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true });
      expect(result).toMatchObject({ id: REPORT_ID, status: 'saved-local', diagnostics: { status: 'none', reason: 'collection_failed' } });
      expect(crumbs(fb)[0].code).toBe('diagnostics.none.collection_failed');
      expect(fb.feedback.submit).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('warn', 'Feedback diagnostics could not be read', expect.anything());
    });

    it('still delivers when the excerpt sender can\'t be created', async () => {
      const { fb } = fakeSdk();
      const { s, log } = serviceWith(fb, { createExcerptTelemetry: (() => { throw new Error('no telemetry'); }) as never });
      const draft = await capture(s);
      await expect(s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true })).resolves.toMatchObject({ id: REPORT_ID, status: 'saved-local' });
      expect(log).toHaveBeenCalledWith('warn', 'Feedback diagnostics could not be sent', expect.objectContaining({ id: REPORT_ID }));
    });

    it('still delivers when logging a line throws or sending rejects', async () => {
      for (const excerpt of [
        { ...fakeExcerpt(), log: vi.fn(() => { throw new Error('bad line'); }) },
        { ...fakeExcerpt(), feedbackSubmitted: vi.fn(async () => { throw new Error('network'); }) },
      ]) {
        const { fb } = fakeSdk();
        const { s } = serviceWith(fb, { createExcerptTelemetry: (() => excerpt) as never });
        const draft = await capture(s);
        await expect(s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true })).resolves.toMatchObject({ status: 'saved-local' });
        await vi.waitFor(() => expect(excerpt.dispose).toHaveBeenCalled());
      }
    });

    it('sends nothing when the report could not be saved, and a retry sends once', async () => {
      let fail = true;
      const { fb } = fakeSdk(async () => {
        if (fail) throw Object.assign(new Error('full'), { code: 'storage-full' });
        return { id: REPORT_ID, status: 'saved-local' };
      });
      const excerpt = fakeExcerpt();
      const create = vi.fn(() => excerpt) as never;
      const { s } = serviceWith(fb, { createExcerptTelemetry: create });
      const draft = await capture(s);
      const input = { draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true };
      await expect(s.send(input)).rejects.toThrow('full');
      expect(create).not.toHaveBeenCalled();
      fail = false;
      await s.send(input);
      expect(create).toHaveBeenCalledTimes(1);
      expect(fb.feedback.prepare).toHaveBeenCalledTimes(1);
    });

    it('refuses a retry that changes the choice: the saved report may already say otherwise', async () => {
      const { fb } = fakeSdk(async () => { throw new Error('uncertain'); });
      const { s } = serviceWith(fb);
      const draft = await capture(s);
      await expect(s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true })).rejects.toThrow('uncertain');
      await expect(s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: false })).rejects.toMatchObject({ code: 'feedback-review-changed' });
    });
  });

  it('logs a refusal from the server, and stops', async () => {
    const { fb } = fakeSdk();
    const excerpt = fakeExcerpt({ forbidden: true, sent: 0 });
    const { s, log } = serviceWith(fb, { createExcerptTelemetry: (() => excerpt) as never });
    const draft = await capture(s);
    await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('warn', 'Feedback diagnostics refused by the server', { id: REPORT_ID, lines: 1 }));
    expect(excerpt.dispose).toHaveBeenCalled();
  });

  it('keeps retrying while lines are buffered, drops them at shutdown', async () => {
    const { fb } = fakeSdk();
    const excerpt = fakeExcerpt({ buffered: 1, sent: 0 });
    const { s } = serviceWith(fb, { createExcerptTelemetry: (() => excerpt) as never });
    const draft = await capture(s);
    await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true });
    await vi.waitFor(() => expect(excerpt.stats).toHaveBeenCalled());
    expect(excerpt.dispose).not.toHaveBeenCalled();
    await s.shutdown();
    expect(excerpt.dispose).toHaveBeenCalledTimes(1);
  });

  it('puts the reviewed lines on the wire with the real SDK, tagged with the report id', async () => {
    const { fb } = fakeSdk();
    const bodies: Array<Record<string, any>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return new Response('{}', { status: 202 }); });
    const { s, log } = serviceWith(fb, {
      createExcerptTelemetry: ((opts: Parameters<typeof createTelemetry>[0]) => createTelemetry({ ...opts, fetchImpl: fetchImpl as never })) as never,
      buildSha: 'abc1234',
    });
    const draft = await capture(s);
    await s.send({ draftId: draft.draftId, notes: '', includeScreenshot: true, includeDiagnostics: true });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('info', 'Feedback diagnostics sent', expect.anything()));
    expect(fetchImpl.mock.lastCall![0]).toBe('https://fb.example/v1/telemetry');
    const body = bodies[0];
    expect(body).toMatchObject({ gameId: 'clubhouse', buildSha: 'abc1234', sessionId: SESSION });
    expect(body.metrics).toBeUndefined();
    const records = body.logs.resourceLogs[0].scopeLogs[0].logRecords as Array<{ body: { stringValue: string }; attributes: Array<{ key: string; value: Record<string, unknown> }> }>;
    expect(records.map((r) => r.body.stringValue)).toEqual(['annex.ws.disconnected', 'feedback.submitted']);
    const attrs = Object.fromEntries(records[0].attributes.map((a) => [a.key, Object.values(a.value)[0]]));
    expect(attrs).toMatchObject({ 'clubhouse.ns': 'core:annex', 'feedback.report.id': REPORT_ID, 'feedback.excerpt': true });
    expect(Number(attrs['clubhouse.closeCode'])).toBe(1009);
  });

  /** The real SDK from prepare to the wire: only the outbox and the network are fakes. */
  describe('what leaves the computer matches the choices (serialized bytes)', () => {
    const { traceId, spanId, incident } = incidentFixture;
    const REFS = [traceId, spanId, incident.id, incident.phoneInstanceId, incident.hostInstanceIds[0], incident.connectionIds[0]];

    async function sendWith(choice: { includeDiagnostics?: boolean; includeCorrelation?: boolean; reportDiagnosticsField?: boolean }) {
      const { fb } = fakeSdk();
      const reportBytes: string[] = [];
      const wireBytes: string[] = [];
      const outbox = { enqueue: vi.fn(async ({ report }: { report: { id: string } }) => { reportBytes.push(JSON.stringify(report)); return { id: report.id, status: 'saved-local' }; }) };
      const access = { ...fb.access, status: () => ({ ...fb.access.status(), canCapture: true }) };
      const feedback = createFeedback({ access, outbox, sessionId: SESSION } as never);
      const sdk = { ...fb, access, feedback };
      const fetchImpl = async (_url: unknown, init: { body: string }) => { wireBytes.push(init.body); return new Response('{}', { status: 202 }); };
      const { s, log } = serviceWith(sdk, {
        captureCorrelation: () => ({ data: { capturedAt: incident.capturedAt, traceId, spanId, incident: structuredClone(incident) as never } }),
        createExcerptTelemetry: ((opts: Parameters<typeof createTelemetry>[0]) => createTelemetry({ ...opts, fetchImpl: fetchImpl as never })) as never,
        reportDiagnosticsField: choice.reportDiagnosticsField,
      });
      const draft = await s.captureDraft(async () => PNG);
      await s.send({ draftId: draft.draftId, notes: 'it broke', includeScreenshot: true, includeDiagnostics: choice.includeDiagnostics, includeCorrelation: choice.includeCorrelation });
      if (choice.includeDiagnostics) await vi.waitFor(() => expect(log).toHaveBeenCalledWith('info', 'Feedback diagnostics sent', expect.anything()));
      return { report: reportBytes.join('\n'), wire: wireBytes.join('\n') };
    }

    it('both on: the lines go by excerpt, the refs by report, and the report field stays out', async () => {
      const { report, wire } = await sendWith({ includeDiagnostics: true, includeCorrelation: true });
      expect(wire).toContain('annex.ws.disconnected');
      expect(wire).toContain('feedback.report.id');
      for (const ref of REFS) expect(report).toContain(ref);
      expect(report).not.toContain('annex.ws.disconnected');
      expect(report).not.toContain('"diagnostics"');
      expect(report).toContain('diagnostics.queued');
    });

    it('diagnostics left out: nothing goes on the wire and no line is in the report', async () => {
      const { report, wire } = await sendWith({ includeDiagnostics: false, includeCorrelation: true });
      expect(wire).toBe('');
      expect(report).not.toContain('annex.ws.disconnected');
      expect(report).not.toContain('closeCode');
      expect(report).toContain('diagnostics.left_out.reporter');
      // Tracing references have their own checkbox, which is still on here.
      for (const ref of REFS) expect(report).toContain(ref);
    });

    it('tracing references removed: no ref in the report or the excerpt', async () => {
      const { report, wire } = await sendWith({ includeDiagnostics: true, includeCorrelation: false });
      expect(wire).toContain('annex.ws.disconnected');
      for (const ref of REFS) {
        expect(report).not.toContain(ref);
        expect(wire).not.toContain(ref);
      }
      expect(report).not.toContain('"incident"');
    });

    it('both off: no lines and no refs leave at all', async () => {
      const { report, wire } = await sendWith({ includeDiagnostics: false, includeCorrelation: false });
      expect(wire).toBe('');
      for (const ref of REFS) expect(report).not.toContain(ref);
      expect(report).not.toContain('"incident"');
      expect(report).not.toContain('annex.ws.disconnected');
    });

    it('the pinned SDK would strip the field even if the gate were on, so the gate is what must hold', async () => {
      const { report } = await sendWith({ includeDiagnostics: true, includeCorrelation: true, reportDiagnosticsField: true });
      expect(report).not.toContain('"entries"');
    });
  });
});
