import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFramebriar } from '../../vendor/framebriar/adapters/node/index.mjs';
import type { Framebriar, FramebriarAccessView, FramebriarOutboxView } from '../../vendor/framebriar/adapters/node/index.mjs';
import { ATTR } from '../../../shared/telemetry/attributes';
import { setProducingRuntime } from '../../telemetry/__test-utils__/producing-runtime';
import type { TelemetryRuntime } from '../../telemetry/types';
import { createDiagRedactor } from '../../telemetry/diag-redaction';
import { connectFailureClass, connectFailureReason, FeedbackService, pngSize, sdkVersion, toFeedbackStatus } from './feedback-service';

const ACCESS: FramebriarAccessView = { state: 'connected', connected: true, enrolled: true, canCapture: true, notice: null, expiresAt: '2026-11-15T00:00:00.000Z' };
const OUTBOX: FramebriarOutboxView = { state: 'available', items: 2, bytes: 1234, maxItems: 10, maxBytes: 33554432, blocked: 1, retention: 'until-delivered-or-cleared' };
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fake-image-bytes')]);

/** A PNG header with a real IHDR chunk (the body is never decoded). */
function pngOf(width: number, height: number, body = 'pixels'): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ihdr, Buffer.from(body)]);
}

describe('pngSize', () => {
  it('reads width and height from IHDR', () => {
    expect(pngSize(pngOf(2880, 1800))).toEqual({ width: 2880, height: 1800 });
  });
  it('returns null for anything that is not a PNG with an IHDR', () => {
    expect(pngSize(Buffer.from('GIF89a-not-a-png-at-all-really'))).toBeNull();
    expect(pngSize(PNG)).toBeNull();
    expect(pngSize(Buffer.alloc(0))).toBeNull();
  });
});

/** In-memory safeStorage, like Electron's (Linux reports a real keyring backend). */
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  getSelectedStorageBackend: () => 'gnome_libsecret',
};

describe('toFeedbackStatus', () => {
  it('maps access and outbox views', () => {
    expect(toFeedbackStatus(true, { available: true }, ACCESS, OUTBOX, ['r2', 'r1'])).toEqual({
      started: true,
      state: 'connected',
      connected: true,
      enrolled: true,
      canCapture: true,
      notice: null,
      expiresAt: '2026-11-15T00:00:00.000Z',
      storage: { available: true },
      outbox: { state: 'available', pending: 2, blocked: 1, bytes: 1234, maxItems: 10, maxBytes: 33554432 },
      received: ['r2', 'r1'],
    });
  });

  it('never allows capture when secure storage is unavailable', () => {
    const s = toFeedbackStatus(true, { available: false, reason: 'plaintext-backend' }, ACCESS, OUTBOX, []);
    expect(s.canCapture).toBe(false);
    expect(s.storage).toEqual({ available: false, reason: 'plaintext-backend' });
    const viaAccess = toFeedbackStatus(true, { available: true }, { ...ACCESS, state: 'storage-unavailable' }, OUTBOX, []);
    expect(viaAccess).toMatchObject({ canCapture: false, storage: { available: false, reason: 'storage-unavailable' } });
  });

  it('keeps notices and expiry for a lapsed enrollment', () => {
    const s = toFeedbackStatus(true, { available: true }, { state: 'expired', connected: false, enrolled: true, canCapture: true, notice: 'expired', expiresAt: null }, OUTBOX, []);
    expect(s).toMatchObject({ connected: false, canCapture: true, notice: 'expired' });
  });

  it('passes only SDK-safe versions', () => {
    expect(sdkVersion('0.42.0-beta.1')).toBe('0.42.0-beta.1');
    expect(sdkVersion('0.42.0 beta')).toBeUndefined();
  });
});

describe('FeedbackService (fake SDK)', () => {
  function fakeSdk() {
    let access = { ...ACCESS };
    const calls: Array<[string, unknown?]> = [];
    let options: Parameters<typeof createFramebriar>[0] | undefined;
    const fb = {
      store: { probe: () => ({ available: true }) },
      access: {
        endpoint: 'https://fb.example', gameId: 'clubhouse',
        status: () => access,
        connect: vi.fn(async (inv: string) => { calls.push(['connect', inv]); access = { ...ACCESS }; return true; }),
        disconnect: vi.fn(async () => { access = { ...ACCESS, state: 'disconnected', connected: false, enrolled: false, canCapture: false }; return { forgotten: true, revoked: true }; }),
      },
      outbox: { status: () => OUTBOX },
      feedback: {
        open: vi.fn(async () => ({ png: (await options!.capture!()) as Buffer | null, capturedAt: '2026-10-17T10:00:00.000Z' })),
        prepare: vi.fn(async (input: Record<string, unknown>) => ({ report: { id: 'rep-1' }, png: (input.png as Buffer | null) ?? null, input })),
        submit: vi.fn(async () => ({ id: 'rep-1', gameId: 'clubhouse', status: 'saved-local' as const, sent: false as const, diagnostics: 'unavailable' as const })),
      },
      start: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const create = vi.fn((opts: Parameters<typeof createFramebriar>[0]) => { options = opts; return fb as unknown as Framebriar; });
    return { fb, create, calls, opts: () => options! };
  }

  function service(create: ReturnType<typeof fakeSdk>['create']) {
    return new FeedbackService({ safeStorage, dataDir: '/data', appVersion: '0.42.0-beta.1', isOnline: () => true, create: create as never });
  }

  it('starts once with the app id, version, window capture and telemetry off', async () => {
    const { create, fb, opts } = fakeSdk();
    const s = service(create);
    await Promise.all([s.start(), s.start()]);
    await s.start();
    expect(create).toHaveBeenCalledTimes(1);
    expect(fb.start).toHaveBeenCalledTimes(1);
    expect(opts()).toMatchObject({ appId: 'clubhouse', appVersion: '0.42.0-beta.1', dataDir: '/data', telemetry: 'off' });
    expect(s.status().started).toBe(true);
  });

  it('passes the build commit to the SDK, and null when there is none (#2098)', async () => {
    const withSha = fakeSdk();
    await new FeedbackService({ safeStorage, dataDir: '/data', appVersion: '0.42.0-beta.1', buildSha: '71b4bc9d', isOnline: () => true, create: withSha.create as never }).start();
    expect(withSha.opts()).toMatchObject({ buildSha: '71b4bc9d' });
    const without = fakeSdk();
    await service(without.create).start();
    expect(without.opts()).toMatchObject({ buildSha: null });
  });

  it('sends the recent breadcrumbs with the report, at most 40 (#2098)', async () => {
    const { create, fb } = fakeSdk();
    const crumbs = Array.from({ length: 45 }, (_, i) => ({ kind: 'event' as const, atMs: 1_000 - i, code: 'view.agent' }));
    const s = new FeedbackService({ safeStorage, dataDir: '/data', appVersion: '0.42.0-beta.1', isOnline: () => true, create: create as never, breadcrumbs: () => crumbs });
    await s.send({ notes: 'it froze', includeScreenshot: false, scene: 'agents' });
    const context = (fb.feedback.prepare.mock.lastCall![0] as { context: { breadcrumbs: unknown[] } }).context;
    expect(context.breadcrumbs).toHaveLength(40);
    expect(context.breadcrumbs[0]).toEqual({ kind: 'event', atMs: 1_000, code: 'view.agent' });
  });

  it('reports a stopped status before start', () => {
    const { create } = fakeSdk();
    expect(service(create).status()).toMatchObject({ started: false, canCapture: false, state: 'disconnected' });
  });

  it('connects with a trimmed invitation and disconnects', async () => {
    const { create, calls } = fakeSdk();
    const s = service(create);
    expect(await s.connect('  invite-token  ')).toMatchObject({ connected: true, status: { connected: true } });
    expect(calls).toEqual([['connect', 'invite-token']]);
    expect(await s.disconnect()).toMatchObject({ forgotten: true, revoked: true, status: { connected: false, canCapture: false } });
  });

  it('captures through the given window grab and returns a data URL preview', async () => {
    const { create, fb, opts } = fakeSdk();
    const s = service(create);
    const grab = vi.fn(async () => PNG);
    const draft = await s.captureDraft(grab);
    expect(grab).toHaveBeenCalledTimes(1);
    expect(fb.feedback.open).toHaveBeenCalledTimes(1);
    expect(draft.preview).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(draft.draftId).toMatch(/^[0-9a-f-]{36}$/);
    // The SDK never captures on its own: the caller's window is the only source.
    expect(await opts().capture!()).toBeNull();
  });

  it('keeps concurrent captures from different windows apart', async () => {
    const { create, fb } = fakeSdk();
    const s = service(create);
    const other = Buffer.concat([PNG, Buffer.from('other-window')]);
    const [a, b] = await Promise.all([s.captureDraft(async () => PNG), s.captureDraft(async () => other)]);
    await s.send({ draftId: b.draftId, notes: '', includeScreenshot: true });
    expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ png: other }));
    await s.send({ draftId: a.draftId, notes: '', includeScreenshot: true });
    expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ png: PNG }));
  });

  it('rejects a failed, oversized or non-PNG capture', async () => {
    const { create } = fakeSdk();
    const s = service(create);
    await expect(s.captureDraft(async () => { throw new Error('gpu'); })).rejects.toThrow('Screenshot capture failed');
    await expect(s.captureDraft(async () => Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]))).rejects.toThrow(/too large/);
    await expect(s.captureDraft(async () => Buffer.from('not a png at all'))).rejects.toThrow(/not a PNG/);
    expect((await s.captureDraft(async () => null)).preview).toBeNull();
  });

  it('keeps at most five open drafts, dropping the oldest', async () => {
    const { create } = fakeSdk();
    const s = service(create);
    const drafts = [];
    for (let i = 0; i < 6; i++) drafts.push(await s.captureDraft(async () => PNG));
    await expect(s.send({ draftId: drafts[0].draftId, notes: 'n', includeScreenshot: true })).rejects.toThrow(/expired/);
    await expect(s.send({ draftId: drafts[5].draftId, notes: 'n', includeScreenshot: true })).resolves.toMatchObject({ status: 'saved-local' });
  });

  it('freezes the app trace at capture, including text-only review and failed-submit retry', async () => {
    const facade = await import('../../telemetry/facade');
    const trace = vi.spyOn(facade, 'currentTraceparent');
    const original = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    trace.mockReturnValue(original);
    const { fb, create } = fakeSdk();
    const svc = service(create);
    try {
      const draft = await svc.captureDraft(async () => PNG);
      trace.mockReturnValue('00-abcdef0123456789abcdef0123456789-abcdef0123456789-01');
      fb.feedback.submit.mockRejectedValueOnce(new Error('outbox unavailable'));
      await expect(svc.send({ draftId: draft.draftId, notes: 'reviewed', includeScreenshot: false })).rejects.toThrow();
      await svc.send({ draftId: draft.draftId, notes: 'reviewed', includeScreenshot: false });
      for (const [input] of fb.feedback.prepare.mock.calls) expect(input).toMatchObject({
        traceId: original.slice(3, 35), spanId: original.slice(36, 52), png: null,
      });
    } finally { trace.mockRestore(); await svc.shutdown(); }
  });

  it('sends with the captured screenshot, or text-only without it', async () => {
    const { create, fb } = fakeSdk();
    const s = service(create);
    const draft = await s.captureDraft(async () => PNG);
    await s.send({ draftId: draft.draftId, notes: 'broken', includeScreenshot: true, scene: 'agents' });
    expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ notes: 'broken', png: PNG, context: { scene: 'agents', breadcrumbs: [] } }));
    expect(fb.feedback.submit).toHaveBeenLastCalledWith(expect.anything(), { includeDiagnostics: false });

    const second = await s.captureDraft(async () => PNG);
    await s.send({ draftId: second.draftId, notes: 'just text', includeScreenshot: false, scene: 'Not A Code!' });
    expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ png: null, capturedAt: '2026-10-17T10:00:00.000Z', context: { scene: 'app', breadcrumbs: [] } }));

    await s.send({ notes: 'no capture at all', includeScreenshot: false });
    expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ png: null }));
  });

  describe('several windows (#2100)', () => {
    const main = pngOf(2880, 1800, 'main');
    const popout = pngOf(1600, 1000, 'popout');

    it('captures each window with its label, the starting window first', async () => {
      const { create } = fakeSdk();
      const s = service(create);
      const draft = await s.captureDraft([
        { label: 'Agent: faithful-urchin', grab: async () => popout },
        { label: 'Main window', grab: async () => main },
      ]);
      expect(draft.shots.map((x) => [x.shotId, x.label])).toEqual([['s0', 'Agent: faithful-urchin'], ['s1', 'Main window']]);
      expect(draft.preview).toBe(draft.shots[0].preview);
      expect(draft.shots[1].preview).toBe(`data:image/png;base64,${main.toString('base64')}`);
    });

    it('leaves out other windows that fail or are not PNGs, but fails when the starting window does', async () => {
      const { create } = fakeSdk();
      const s = service(create);
      const draft = await s.captureDraft([
        { label: 'Main window', grab: async () => main },
        { label: 'Broken', grab: async () => { throw new Error('gone'); } },
        { label: 'Not a PNG', grab: async () => Buffer.from('nope') },
        { label: 'Blank', grab: async () => null },
        { label: 'Pop-out', grab: async () => popout },
      ]);
      expect(draft.shots.map((x) => x.label)).toEqual(['Main window', 'Pop-out']);
      expect(draft.shots.map((x) => x.shotId)).toEqual(['s0', 's4']);
      await expect(s.captureDraft([{ label: 'Main window', grab: async () => { throw new Error('gone'); } }, { label: 'Pop-out', grab: async () => popout }])).rejects.toThrow(/capture failed/);
    });

    it('sends the chosen window, and the annotated check uses that window', async () => {
      const { create, fb } = fakeSdk();
      const s = service(create);
      const draft = await s.captureDraft([{ label: 'Main window', grab: async () => main }, { label: 'Pop-out', grab: async () => popout }]);
      await expect(s.send({ draftId: draft.draftId, notes: 'n', includeScreenshot: true, shotId: 's1', annotatedPng: pngOf(2880, 1800).toString('base64') })).rejects.toThrow(/doesn't match/);
      const drawn = pngOf(1600, 1000, 'popout-ink');
      await s.send({ draftId: draft.draftId, notes: 'n', includeScreenshot: true, shotId: 's1', annotatedPng: drawn.toString('base64') });
      expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ png: drawn }));
    });

    it('sends the starting window without a shotId, and refuses an unknown one', async () => {
      const { create, fb } = fakeSdk();
      const s = service(create);
      const draft = await s.captureDraft([{ label: 'Main window', grab: async () => main }, { label: 'Pop-out', grab: async () => popout }]);
      await expect(s.send({ draftId: draft.draftId, notes: 'n', includeScreenshot: true, shotId: 's9' })).rejects.toThrow(/no longer available/);
      await s.send({ draftId: draft.draftId, notes: 'n', includeScreenshot: true });
      expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ png: main }));
    });
  });

  describe('a screenshot with the user\'s drawing (#2099)', () => {
    const captured = pngOf(2880, 1800, 'captured');
    const drawn = pngOf(2880, 1800, 'captured-with-ink');

    it('uploads the annotated PNG in place of the capture', async () => {
      const { create, fb } = fakeSdk();
      const s = service(create);
      const draft = await s.captureDraft(async () => captured);
      await s.send({ draftId: draft.draftId, notes: 'see the circle', includeScreenshot: true, annotatedPng: drawn.toString('base64') });
      expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ png: drawn, capturedAt: '2026-10-17T10:00:00.000Z' }));
    });

    it('ignores the drawing on a text-only send', async () => {
      const { create, fb } = fakeSdk();
      const s = service(create);
      const draft = await s.captureDraft(async () => captured);
      await s.send({ draftId: draft.draftId, notes: 'text only', includeScreenshot: false, annotatedPng: drawn.toString('base64') });
      expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ png: null }));
    });

    it.each([
      ['a different size', pngOf(1440, 900).toString('base64'), /doesn't match/],
      ['not a PNG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'), /not a PNG/],
      ['over the decoded size cap', Buffer.concat([pngOf(2880, 1800), Buffer.alloc(8 * 1024 * 1024)]).toString('base64'), /too large/],
    ])('refuses a drawing that is %s and keeps the draft for a retry', async (_label, annotatedPng, error) => {
      const { create, fb } = fakeSdk();
      const s = service(create);
      const draft = await s.captureDraft(async () => captured);
      await expect(s.send({ draftId: draft.draftId, notes: 'n', includeScreenshot: true, annotatedPng })).rejects.toThrow(error);
      expect(fb.feedback.prepare).not.toHaveBeenCalled();
      await s.send({ draftId: draft.draftId, notes: 'n', includeScreenshot: true });
      expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ png: captured }));
    });
  });

  it('refuses a screenshot send without a draft, and text-only without notes', async () => {
    const { create } = fakeSdk();
    const s = service(create);
    await expect(s.send({ draftId: '00000000-0000-4000-8000-000000000000', notes: 'x', includeScreenshot: true })).rejects.toThrow(/expired/);
    await expect(s.send({ notes: '   ', includeScreenshot: false })).rejects.toThrow(/Add a note/);
  });

  it('keeps the reviewed draft when saving fails, so the user can retry', async () => {
    const { create, fb } = fakeSdk();
    const s = service(create);
    const draft = await s.captureDraft(async () => PNG);
    fb.feedback.submit.mockRejectedValueOnce(Object.assign(new Error('Local feedback storage is full'), { code: 'storage-full' }));
    await expect(s.send({ draftId: draft.draftId, notes: 'n', includeScreenshot: true })).rejects.toThrow(/full/);
    await expect(s.send({ draftId: draft.draftId, notes: 'n', includeScreenshot: true })).resolves.toMatchObject({ status: 'saved-local' });
    // Consumed now.
    await expect(s.send({ draftId: draft.draftId, notes: 'n', includeScreenshot: true })).rejects.toThrow(/expired/);
  });

  it('tracks receipts as received and notifies listeners', async () => {
    const { create, opts } = fakeSdk();
    const s = service(create);
    await s.start();
    const seen: string[][] = [];
    s.onChange((st) => seen.push(st.received));
    opts().onReceipt!({ id: 'a' });
    opts().onReceipt!({ id: 'b' });
    opts().onReceipt!({ id: 'a' });
    expect(s.status().received).toEqual(['a', 'b']);
    expect(seen.at(-1)).toEqual(['a', 'b']);
  });

  describe('diagnostics log', () => {
    const INVITE = 'A'.repeat(43);
    type Entry = [string, string, Record<string, unknown> | undefined];

    function logged(create: ReturnType<typeof fakeSdk>['create'], clock = { t: 0 }) {
      const entries: Entry[] = [];
      const s = new FeedbackService({
        safeStorage, dataDir: '/data', appVersion: '0.42.0', isOnline: () => true, create: create as never,
        now: () => clock.t, log: (level, msg, meta) => entries.push([level, msg, meta]),
      });
      return { s, entries, clock, find: (msg: string | RegExp) => entries.find(([, m]) => (typeof msg === 'string' ? m === msg : msg.test(m))) };
    }

    it('logs a connect that timed out with the likely cause, never the invitation', async () => {
      const { create, fb } = fakeSdk();
      const { s, entries, clock, find } = logged(create);
      let access = { ...ACCESS, state: 'disconnected' as const, connected: false, enrolled: false, canCapture: false };
      fb.access.status = () => access as never;
      fb.access.connect.mockImplementationOnce(async () => {
        clock.t += 142_050;
        access = { ...access, state: 'connection-uncertain' as never, notice: 'connection-uncertain' };
        return false;
      });
      expect((await s.connect(`  ${INVITE}  `)).connected).toBe(false);
      expect(find('Feedback connect started')?.[2]).toEqual({ from: 'disconnected' });
      const [level, , meta] = find('Feedback connect failed')!;
      expect(level).toBe('warn');
      expect(meta).toMatchObject({ durationMs: 142_050, state: 'connection-uncertain', notice: 'connection-uncertain' });
      expect(meta!.reason).toMatch(/timed out.*retry the same one/);
      expect(JSON.stringify(entries)).not.toContain(INVITE);
    });

    it('logs a successful connect and a disconnect', async () => {
      const { create } = fakeSdk();
      const { s, find } = logged(create);
      await s.connect(INVITE);
      expect(find('Feedback connected')).toEqual(['info', 'Feedback connected', { durationMs: 0, expiresAt: ACCESS.expiresAt }]);
      await s.disconnect();
      expect(find('Feedback disconnect')).toEqual(['info', 'Feedback disconnect', { forgotten: true, revoked: true }]);
    });

    it('logs a connect that threw, and rethrows', async () => {
      const { create, fb } = fakeSdk();
      const { s, find } = logged(create);
      fb.access.connect.mockRejectedValueOnce(new Error('keychain locked'));
      await expect(s.connect(INVITE)).rejects.toThrow('keychain locked');
      expect(find('Feedback connect threw')).toEqual(['error', 'Feedback connect threw', { error: 'keychain locked', durationMs: 0 }]);
    });

    it('logs start, and a start that failed', async () => {
      const ok = fakeSdk();
      const started = logged(ok.create);
      await started.s.start();
      expect(started.find('Feedback started')).toEqual(['info', 'Feedback started', { state: 'connected', notice: null, pending: 2, blocked: 1, durationMs: 0 }]);

      const bad = fakeSdk();
      bad.fb.start.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'busy' }));
      const failed = logged(bad.create);
      await expect(failed.s.start()).rejects.toThrow('locked');
      expect(failed.find('Feedback start failed')).toEqual(['warn', 'Feedback start failed', { error: 'locked', code: 'busy' }]);
    });

    it('logs access transitions once each, problems at warn and in-between states at debug', async () => {
      const { create, opts } = fakeSdk();
      const { s, entries } = logged(create);
      await s.start();
      const view = (state: string, notice: string | null = null) => ({ ...ACCESS, state, notice, connected: state === 'connected' }) as FramebriarAccessView;
      opts().onAccessChange!(view('checking'));
      opts().onAccessChange!(view('connected'));
      opts().onAccessChange!(view('connected'));
      opts().onAccessChange!(view('offline'));
      opts().onAccessChange!(view('access-required', 'access-required'));
      const access = entries.filter(([, m]) => m.startsWith('Feedback access:')).map(([l, m, meta]) => [l, m, meta?.from]);
      expect(access).toEqual([
        ['debug', 'Feedback access: checking', null],
        ['info', 'Feedback access: connected', 'checking'],
        ['warn', 'Feedback access: offline', 'connected'],
        ['warn', 'Feedback access: access-required', 'offline'],
      ]);
    });

    it('logs the outbox: state, queueing, delivery, blocked reports and receipts', async () => {
      const { create, opts } = fakeSdk();
      const { s, entries } = logged(create);
      await s.start();
      const box = (over: Partial<FramebriarOutboxView>) => ({ ...OUTBOX, items: 0, blocked: 0, ...over });
      opts().onOutboxChange!(box({ state: 'available' }));
      opts().onOutboxChange!(box({ items: 1 }));
      opts().onOutboxChange!(box({ items: 0 }));
      opts().onOutboxChange!(box({ items: 1, blocked: 1 }));
      opts().onOutboxChange!(box({ state: 'storage-unavailable', items: 1, blocked: 1 }));
      opts().onReceipt!({ id: 'rep-9', status: 'accepted' });
      expect(entries.map(([l, m]) => [l, m])).toEqual(expect.arrayContaining([
        ['info', 'Feedback outbox: available'],
        ['debug', 'Feedback report queued'],
        ['debug', 'Feedback report left the outbox'],
        ['warn', 'Feedback report can\'t be delivered and stays on this computer'],
        ['warn', 'Feedback outbox: storage-unavailable'],
        ['info', 'Feedback delivered'],
      ]));
      expect(entries.find(([, m]) => m === 'Feedback delivered')?.[2]).toEqual({ id: 'rep-9', status: 'accepted' });
    });

    it('logs capture and send outcomes with sizes, never the notes', async () => {
      const { create, fb } = fakeSdk();
      const { s, entries, find } = logged(create);
      const draft = await s.captureDraft(async () => PNG);
      expect(find('Feedback screenshot captured')).toEqual(['info', 'Feedback screenshot captured', { draftId: draft.draftId, hasScreenshot: true, shots: 1, windows: 1, drafts: 1 }]);
      await expect(s.captureDraft(async () => { throw new Error('gpu'); })).rejects.toThrow();
      expect(find('Feedback capture failed')).toEqual(['warn', 'Feedback capture failed', { error: 'Screenshot capture failed', code: 'capture-failed' }]);

      await s.send({ draftId: draft.draftId, notes: 'secret words', includeScreenshot: true });
      expect(find('Feedback saved for delivery')?.[2]).toEqual({
        draftId: draft.draftId, includeScreenshot: true, notesLength: 12, annotated: false, shotId: null, id: 'rep-1', status: 'saved-local', state: 'connected',
      });
      fb.feedback.submit.mockRejectedValueOnce(Object.assign(new Error('Local feedback storage is full'), { code: 'storage-full' }));
      await expect(s.send({ notes: 'more secret words', includeScreenshot: false })).rejects.toThrow();
      expect(find('Feedback send failed')?.[2]).toMatchObject({ error: 'Local feedback storage is full', code: 'storage-full', notesLength: 17 });
      expect(JSON.stringify(entries)).not.toMatch(/secret words/);
    });
  });

  describe('telemetry (#2309)', () => {
    const INVITE = 'A'.repeat(43);
    const NOTES = 'my private feedback words';
    let rt: TelemetryRuntime;
    beforeEach(() => {
      rt = { level: 'detailed', event: vi.fn(), count: vi.fn() } as unknown as TelemetryRuntime;
      setProducingRuntime(rt);
    });
    afterEach(() => setProducingRuntime(null));
    const events = () => vi.mocked(rt.event).mock.calls.map(([name, attrs]) => [name, attrs ?? []]);
    const named = (name: string) => events().filter(([n]) => n === name).map(([, a]) => a);

    it('records a capture: screenshot, shot and window counts, trigger', async () => {
      const { create } = fakeSdk();
      const s = service(create);
      await s.captureDraft([{ label: 'Main window', grab: async () => PNG }, { label: 'Pop-out', grab: async () => PNG }], 'shortcut');
      await s.captureDraft(async () => null);
      expect(named('clubhouse.feedback.captured')).toEqual([
        [ATTR.feedbackScreenshot(true), ATTR.feedbackShots(2), ATTR.feedbackWindows(2), ATTR.feedbackTrigger('shortcut')],
        [ATTR.feedbackScreenshot(false), ATTR.feedbackShots(0), ATTR.feedbackWindows(1), ATTR.feedbackTrigger('button')],
      ]);
    });

    it('records a failed capture with its error class', async () => {
      const { create } = fakeSdk();
      const s = service(create);
      await expect(s.captureDraft(async () => { throw new Error('gpu at /Users/someone'); })).rejects.toThrow();
      await expect(s.captureDraft(async () => Buffer.from('not a png at all'))).rejects.toThrow();
      expect(named('clubhouse.feedback.failed')).toEqual([
        [ATTR.feedbackStage('capture'), ATTR.feedbackError('capture-failed')],
        [ATTR.feedbackStage('capture'), ATTR.feedbackError('invalid-media')],
      ]);
    });

    it('records a submit: screenshot, annotated, shot count and access state', async () => {
      const { create } = fakeSdk();
      const s = service(create);
      const shot = pngOf(4, 3, 'shot');
      const draft = await s.captureDraft([{ label: 'Main window', grab: async () => shot }, { label: 'Pop-out', grab: async () => shot }]);
      await s.send({ draftId: draft.draftId, notes: NOTES, includeScreenshot: true, annotatedPng: pngOf(4, 3, 'ink').toString('base64') });
      await s.send({ notes: NOTES, includeScreenshot: false });
      expect(named('clubhouse.feedback.submitted')).toEqual([
        [ATTR.feedbackScreenshot(true), ATTR.feedbackAnnotated(true), ATTR.feedbackShots(2), ATTR.feedbackAccessState('connected')],
        [ATTR.feedbackScreenshot(false), ATTR.feedbackAnnotated(false), ATTR.feedbackShots(0), ATTR.feedbackAccessState('connected')],
      ]);
    });

    it('records failed submits with an error class, never the message', async () => {
      const { create, fb } = fakeSdk();
      const s = service(create);
      await expect(s.send({ notes: '  ', includeScreenshot: false })).rejects.toThrow();
      await expect(s.send({ notes: NOTES, includeScreenshot: true })).rejects.toThrow();
      const draft = await s.captureDraft(async () => PNG);
      await expect(s.send({ draftId: draft.draftId, notes: NOTES, includeScreenshot: true, shotId: 's9' })).rejects.toThrow();
      fb.feedback.submit.mockRejectedValueOnce(Object.assign(new Error('Local feedback storage is full'), { code: 'storage-full' }));
      await expect(s.send({ notes: NOTES, includeScreenshot: false })).rejects.toThrow();
      fb.feedback.submit.mockRejectedValueOnce(new Error('something odd at /Users/someone'));
      await expect(s.send({ notes: NOTES, includeScreenshot: false })).rejects.toThrow();
      expect(named('clubhouse.feedback.failed').map((a) => a[1])).toEqual([
        ATTR.feedbackError('notes-required'),
        ATTR.feedbackError('screenshot-expired'),
        ATTR.feedbackError('shot-unavailable'),
        ATTR.feedbackError('storage-full'),
        ATTR.feedbackError('unknown'),
      ]);
      expect(named('clubhouse.feedback.failed').every((a) => a[0].value === 'submit')).toBe(true);
    });

    it('records delivery, undeliverable reports and an unusable outbox', async () => {
      const { create, opts } = fakeSdk();
      const s = service(create);
      await s.start();
      const box = (over: Partial<FramebriarOutboxView>) => ({ ...OUTBOX, items: 0, blocked: 0, ...over });
      opts().onOutboxChange!(box({ state: 'available' }));
      opts().onOutboxChange!(box({ items: 1 }));
      opts().onReceipt!({ id: 'rep-9', status: 'accepted' });
      opts().onOutboxChange!(box({ items: 1, blocked: 1 }));
      opts().onOutboxChange!(box({ state: 'storage-unavailable', items: 1, blocked: 1 }));
      expect(named('clubhouse.feedback.delivered')).toEqual([[]]);
      expect(named('clubhouse.feedback.failed')).toEqual([
        [ATTR.feedbackStage('deliver'), ATTR.feedbackError('undeliverable')],
        [ATTR.feedbackStage('deliver'), ATTR.feedbackError('storage-unavailable')],
      ]);
    });

    it('records connect success, a classified failure and a throw', async () => {
      const { create, fb } = fakeSdk();
      const s = service(create);
      await s.connect(INVITE);
      expect(named('clubhouse.feedback.connected')).toEqual([[]]);
      let access = { ...ACCESS, state: 'disconnected' as const, connected: false };
      fb.access.status = () => access as never;
      fb.access.connect.mockImplementationOnce(async () => { access = { ...access, state: 'access-required' as never, notice: 'access-required' }; return false; });
      await s.connect(INVITE);
      fb.access.connect.mockRejectedValueOnce(Object.assign(new Error('keychain locked'), { code: 'secure-store-unavailable' }));
      await expect(s.connect(INVITE)).rejects.toThrow();
      expect(named('clubhouse.feedback.failed')).toEqual([
        [ATTR.feedbackStage('connect'), ATTR.feedbackError('access-refused')],
        [ATTR.feedbackStage('connect'), ATTR.feedbackError('secure-store-unavailable')],
      ]);
    });

    it('records a failed start', async () => {
      const { create, fb } = fakeSdk();
      fb.start.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'busy' }));
      await expect(service(create).start()).rejects.toThrow();
      expect(named('clubhouse.feedback.failed')).toEqual([[ATTR.feedbackStage('start'), ATTR.feedbackError('busy')]]);
    });

    it('counts a start failure once when a capture or a send started it', async () => {
      for (const act of [(s: FeedbackService) => s.captureDraft(async () => PNG), (s: FeedbackService) => s.send({ notes: NOTES, includeScreenshot: false })]) {
        vi.mocked(rt.event).mockClear();
        const { create, fb } = fakeSdk();
        fb.start.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'busy' }));
        await expect(act(service(create))).rejects.toThrow();
        expect(named('clubhouse.feedback.failed')).toEqual([[ATTR.feedbackStage('start'), ATTR.feedbackError('busy')]]);
      }
    });

    it('records settled access transitions once each', async () => {
      const { create, opts } = fakeSdk();
      await service(create).start();
      const view = (state: string, notice: string | null = null) => ({ ...ACCESS, state, notice }) as FramebriarAccessView;
      opts().onAccessChange!(view('checking'));
      opts().onAccessChange!(view('disconnected'));
      opts().onAccessChange!(view('connecting'));
      opts().onAccessChange!(view('connected'));
      opts().onAccessChange!(view('connected'));
      opts().onAccessChange!(view('checking'));
      opts().onAccessChange!(view('connected'));
      opts().onAccessChange!(view('expired', 'expired'));
      // `from` is the previous settled state, never an in-between one.
      expect(named('clubhouse.feedback.access')).toEqual([
        [ATTR.feedbackAccessState('disconnected'), ATTR.feedbackAccessFrom('none'), ATTR.feedbackNotice('none')],
        [ATTR.feedbackAccessState('connected'), ATTR.feedbackAccessFrom('disconnected'), ATTR.feedbackNotice('none')],
        [ATTR.feedbackAccessState('expired'), ATTR.feedbackAccessFrom('connected'), ATTR.feedbackNotice('expired')],
      ]);
    });

    it('never puts notes, image bytes, the invitation or the report id in telemetry', async () => {
      const { create, opts } = fakeSdk();
      const s = service(create);
      await s.connect(INVITE);
      const draft = await s.captureDraft(async () => PNG);
      const ink = PNG.toString('base64');
      await s.send({ draftId: draft.draftId, notes: NOTES, includeScreenshot: true });
      opts().onReceipt!({ id: 'rep-1' });
      const all = JSON.stringify(events());
      for (const secret of [NOTES, INVITE, 'rep-1', ink, PNG.toString('latin1'), draft.draftId, 'data:image']) expect(all).not.toContain(secret);
      for (const [, attrs] of events()) for (const a of attrs as Array<{ kind: string }>) expect(['enum', 'int', 'bool']).toContain(a.kind);
    });
  });

  describe('report-id correlation (#2309)', () => {
    type Entry = [string, string, Record<string, unknown> | undefined];
    function logged(create: ReturnType<typeof fakeSdk>['create']) {
      const log: Entry[] = [];
      const s = new FeedbackService({
        safeStorage, dataDir: '/data', appVersion: '0.42.0', isOnline: () => true, create: create as never,
        log: (...e) => log.push(e),
      });
      return { s, log };
    }

    it('logs the report id when saved and when delivered, and it survives diag redaction', async () => {
      const id = '3f2b8c1e-9a4d-4e6f-b2c7-0d1e2f3a4b5c';
      const { create, fb, opts } = fakeSdk();
      fb.feedback.submit.mockResolvedValueOnce({ id, gameId: 'clubhouse', status: 'saved-local', sent: false, diagnostics: 'unavailable' });
      const { s, log } = logged(create);
      await s.send({ notes: 'private words', includeScreenshot: false });
      opts().onReceipt!({ id, status: 'accepted' });
      const lines = log.filter(([, m]) => m === 'Feedback saved for delivery' || m === 'Feedback delivered');
      expect(lines.map(([l, m, meta]) => [l, m, meta?.id])).toEqual([
        ['info', 'Feedback saved for delivery', id],
        ['info', 'Feedback delivered', id],
      ]);
      // appLog writes these as diag lines (#2384); the redactor must keep the id.
      const redactor = createDiagRedactor({ homeDir: '/Users/someone' });
      for (const [, , meta] of lines) expect(redactor.meta(meta!).id).toBe(id);
      expect(JSON.stringify(log)).not.toContain('private words');
    });
  });

  it('shuts the SDK down once', async () => {
    const { create, fb } = fakeSdk();
    const s = service(create);
    await s.start();
    await s.shutdown();
    await s.shutdown();
    expect(fb.shutdown).toHaveBeenCalledTimes(1);
    expect(s.isStarted).toBe(false);
  });
});

describe('FeedbackService with the vendored Framebriar SDK (mocked transport)', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-framebriar-')); });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  /** A tiny Framebriar service: access redeem/refresh/disconnect and two-step report upload. */
  function server() {
    const tok = (c: string) => c.repeat(43);
    const calls: string[] = [];
    const reports = new Map<string, { report: Record<string, unknown>; media?: Buffer }>();
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const grant = () => {
      const now = Date.now();
      return { v: 1, gameId: 'clubhouse', scopeVersion: 2, token: tok('t'), refreshToken: tok('r'),
        expiresAt: new Date(now + 50 * 60_000).toISOString(), refreshExpiresAt: new Date(now + 29 * 86400_000).toISOString() };
    };
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const route = `${init?.method ?? 'GET'} ${url.pathname.replace(/^\/api/, '')}`;
      calls.push(route);
      if (route === 'POST /v1/access/redeem' || route === 'POST /v1/access/refresh') return json(grant());
      if (route === 'POST /v1/access/disconnect') return json({ v: 1, disconnected: true });
      if (route === 'POST /v1/reports') {
        const report = JSON.parse(String(init!.body));
        reports.set(report.id, { report });
        return json(report.media ? { id: report.id, status: 'pending', ticket: tok('k') } : { id: report.id, status: 'ready', gameId: 'clubhouse' });
      }
      const media = /^PUT \/v1\/reports\/([^/]+)\/media$/.exec(route);
      if (media) {
        reports.get(media[1])!.media = Buffer.from(init!.body as Uint8Array);
        return json({ id: media[1], status: 'ready', gameId: 'clubhouse' });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, calls, reports };
  }

  async function until(check: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('Timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('connects with an invitation, then delivers feedback with and without a screenshot', async () => {
    const srv = server();
    const s = new FeedbackService({
      safeStorage, dataDir, appVersion: '0.42.0-beta.1', isOnline: () => true,
      create: ((opts: Parameters<typeof createFramebriar>[0]) => createFramebriar({ ...opts, endpoint: 'https://fb.example/api', fetchImpl: srv.fetchImpl })) as typeof createFramebriar,
    });
    try {
      await s.start();
      expect(s.status()).toMatchObject({ started: true, connected: false, canCapture: false });
      expect(s.telemetryExport()).toBeNull();

      const { connected, status } = await s.connect('i'.repeat(43));
      expect(connected).toBe(true);
      expect(status).toMatchObject({ connected: true, canCapture: true, storage: { available: true } });
      expect(Date.parse(status.expiresAt!)).toBeGreaterThan(Date.now() + 28 * 86400_000);
      // Only the refresh credential is on disk, encrypted.
      const stored = fs.readFileSync(path.join(dataDir, 'enrollment.json'), 'utf8');
      expect(stored).not.toContain('iiiiiiiiii');

      // Clubhouse's own telemetry can go to Framebriar now: OTLP URL, current token, feedback session.
      const exp = s.telemetryExport()!;
      expect(exp.host).toBe('fb.example');
      expect(exp.options('traces').url).toBe('https://fb.example/api/v1/otlp/v1/traces');
      expect(await exp.options('metrics').headers()).toEqual({ authorization: `Bearer ${'t'.repeat(43)}` });

      const draft = await s.captureDraft(async () => PNG);
      const withShot = await s.send({ draftId: draft.draftId, notes: 'see screenshot', includeScreenshot: true, scene: 'agents' });
      expect(withShot.status).toBe('saved-local');
      const textOnly = await s.send({ notes: 'text only', includeScreenshot: false });

      // A receipt can arrive just before the outbox removes the report: wait for both.
      await until(() => s.status().received.includes(withShot.id) && s.status().received.includes(textOnly.id) && s.status().outbox.pending === 0);
      expect(srv.reports.get(withShot.id)).toMatchObject({ report: { gameId: 'clubhouse', scene: 'agents', notes: 'see screenshot', appVersion: '0.42.0-beta.1' } });
      expect(srv.reports.get(withShot.id)!.media!.equals(PNG)).toBe(true);
      expect(srv.reports.get(textOnly.id)).toMatchObject({ report: { media: null, notes: 'text only' } });
      expect(srv.reports.get(textOnly.id)!.media).toBeUndefined();
      expect(s.status().outbox.pending).toBe(0);
      // Reports and telemetry share one session, so they correlate.
      expect(srv.reports.get(withShot.id)!.report.sessionId).toBe(exp.sessionId);

      const out = await s.disconnect();
      expect(out).toMatchObject({ forgotten: true, revoked: true, status: { connected: false, canCapture: false } });
      expect(s.telemetryExport()).toBeNull();
    } finally {
      await s.shutdown();
    }
  });

  it('refuses to store anything without secure storage', async () => {
    const srv = server();
    const s = new FeedbackService({
      safeStorage: { ...safeStorage, isEncryptionAvailable: () => false }, dataDir, appVersion: '1.0.0', isOnline: () => true,
      create: ((opts: Parameters<typeof createFramebriar>[0]) => createFramebriar({ ...opts, endpoint: 'https://fb.example/api', fetchImpl: srv.fetchImpl })) as typeof createFramebriar,
    });
    try {
      await s.start();
      expect(s.status()).toMatchObject({ canCapture: false, storage: { available: false, reason: 'encryption-unavailable' } });
      await s.connect('i'.repeat(43));
      expect(s.status().canCapture).toBe(false);
      expect(fs.existsSync(path.join(dataDir, 'enrollment.json'))).toBe(false);
    } finally {
      await s.shutdown();
    }
  });

  it('recovers a lost redeem reply through the SDK without exposing credentials or enabling SDK telemetry', async () => {
    const srv = server();
    const requests: Array<Record<string, string>> = [];
    const logs: unknown[] = [];
    let reply: Response | undefined;
    let fb: Framebriar | undefined;
    // Simulated idempotent backend; the upstream issuer is exercised separately.
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/redeem')) {
        requests.push(JSON.parse(String(init!.body)));
        if (reply) return reply;
        reply = await srv.fetchImpl(url, init);
        throw new TypeError('reply lost after redemption');
      }
      return srv.fetchImpl(url, init);
    };
    const s = new FeedbackService({
      safeStorage, dataDir, appVersion: '0.42.0-beta.1', isOnline: () => true,
      log: (...entry) => logs.push(entry),
      create: (opts) => {
        fb = createFramebriar({ ...opts, endpoint: 'https://fb.example/api', fetchImpl });
        return fb;
      },
    });
    try {
      expect(await s.connect('i'.repeat(43))).toMatchObject({ connected: true, status: { canCapture: true } });
      expect(requests).toHaveLength(2);
      expect(requests[0].attemptId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      expect(requests[1]).toEqual(requests[0]);
      expect(fb!.telemetry).toBeUndefined();
      expect(srv.calls).toEqual(['POST /v1/access/redeem']);
      expect(JSON.stringify(s.status())).not.toMatch(/attemptId|refreshToken|invitation/);
      expect(JSON.stringify(logs)).not.toContain('i'.repeat(43));
      expect(JSON.stringify(logs)).not.toContain(requests[0].attemptId);
      expect(JSON.stringify(logs)).not.toContain('r'.repeat(43));
      // The host-owned OTLP destination remains available only through its existing access gate.
      expect(await s.telemetryExport()!.options('logs').headers()).toEqual({ authorization: `Bearer ${'t'.repeat(43)}` });
      await s.disconnect();
      expect(s.telemetryExport()).toBeNull();
    } finally {
      await s.shutdown();
    }
  });
});

describe('connectFailureClass', () => {
  const INVITE = 'A'.repeat(43);
  it('classifies each failure for telemetry', () => {
    expect(connectFailureClass('short', 'disconnected', 'disconnected', null, 0)).toBe('invitation-malformed');
    expect(connectFailureClass(INVITE, 'disconnecting', 'disconnecting', null, 0)).toBe('busy');
    expect(connectFailureClass(INVITE, 'disconnected', 'storage-unavailable', null, 300)).toBe('storage-unavailable');
    expect(connectFailureClass(INVITE, 'disconnected', 'access-required', 'access-required', 300)).toBe('access-refused');
    expect(connectFailureClass(INVITE, 'disconnected', 'connection-uncertain', 'connection-uncertain', 142_000)).toBe('timeout');
    expect(connectFailureClass(INVITE, 'disconnected', 'connection-uncertain', 'connection-uncertain', 800)).toBe('connection-uncertain');
    expect(connectFailureClass(INVITE, 'disconnected', 'disconnected', null, 800)).toBe('unknown');
  });
});

describe('connectFailureReason', () => {
  const INVITE = 'A'.repeat(43);
  it('says nothing was sent for a malformed invitation or a busy connect', () => {
    expect(connectFailureReason('short', 'disconnected', 'disconnected', null, 0)).toBe('invitation-malformed (length 5); nothing was sent');
    expect(connectFailureReason(INVITE, 'connecting', 'connecting', null, 0)).toMatch(/in progress; nothing was sent/);
  });

  it('separates refusal, storage failure, timeout and other uncertain outcomes', () => {
    expect(connectFailureReason(INVITE, 'disconnected', 'access-required', 'access-required', 300)).toMatch(/server refused/);
    expect(connectFailureReason(INVITE, 'disconnected', 'storage-unavailable', null, 300)).toMatch(/secure storage/);
    expect(connectFailureReason(INVITE, 'disconnected', 'connection-uncertain', 'connection-uncertain', 9_999)).toMatch(/^request failed/);
    expect(connectFailureReason(INVITE, 'disconnected', 'connection-uncertain', 'connection-uncertain', 44_499)).toMatch(/^request failed/);
    expect(connectFailureReason(INVITE, 'disconnected', 'connection-uncertain', 'connection-uncertain', 44_500)).toMatch(/45 s per call and retries twice/);
    expect(connectFailureReason(INVITE, 'disconnected', 'connection-uncertain', 'connection-uncertain', 142_000)).toMatch(/may have timed out/);
    expect(connectFailureReason(INVITE, 'disconnected', 'connection-uncertain', 'connection-uncertain', 800)).toMatch(/^request failed/);
    expect(connectFailureReason(INVITE, 'disconnected', 'disconnected', null, 800)).toBe('unknown');
  });
});
