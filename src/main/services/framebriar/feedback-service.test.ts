import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFramebriar } from '../../vendor/framebriar/adapters/node/index.mjs';
import type { Framebriar, FramebriarAccessView, FramebriarOutboxView } from '../../vendor/framebriar/adapters/node/index.mjs';
import { FeedbackService, sdkVersion, toFeedbackStatus } from './feedback-service';

const ACCESS: FramebriarAccessView = { state: 'connected', connected: true, enrolled: true, canCapture: true, notice: null, expiresAt: '2026-11-15T00:00:00.000Z' };
const OUTBOX: FramebriarOutboxView = { state: 'available', items: 2, bytes: 1234, maxItems: 10, maxBytes: 33554432, blocked: 1, retention: 'until-delivered-or-cleared' };
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fake-image-bytes')]);

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

  it('sends with the captured screenshot, or text-only without it', async () => {
    const { create, fb } = fakeSdk();
    const s = service(create);
    const draft = await s.captureDraft(async () => PNG);
    await s.send({ draftId: draft.draftId, notes: 'broken', includeScreenshot: true, scene: 'agents' });
    expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ notes: 'broken', png: PNG, context: { scene: 'agents' } }));
    expect(fb.feedback.submit).toHaveBeenLastCalledWith(expect.anything(), { includeDiagnostics: false });

    const second = await s.captureDraft(async () => PNG);
    await s.send({ draftId: second.draftId, notes: 'just text', includeScreenshot: false, scene: 'Not A Code!' });
    expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ png: null, capturedAt: '2026-10-17T10:00:00.000Z', context: { scene: 'app' } }));

    await s.send({ notes: 'no capture at all', includeScreenshot: false });
    expect(fb.feedback.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ png: null }));
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

      const { connected, status } = await s.connect('i'.repeat(43));
      expect(connected).toBe(true);
      expect(status).toMatchObject({ connected: true, canCapture: true, storage: { available: true } });
      expect(Date.parse(status.expiresAt!)).toBeGreaterThan(Date.now() + 28 * 86400_000);
      // Only the refresh credential is on disk, encrypted.
      const stored = fs.readFileSync(path.join(dataDir, 'enrollment.json'), 'utf8');
      expect(stored).not.toContain('iiiiiiiiii');

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

      const out = await s.disconnect();
      expect(out).toMatchObject({ forgotten: true, revoked: true, status: { connected: false, canCapture: false } });
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
});
