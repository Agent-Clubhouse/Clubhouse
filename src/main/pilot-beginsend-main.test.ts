/**
 * PILOT, never ships. The state-level check of Begin-Send against main: the real model (Framebriar PR 69,
 * ccc59cd) with a fake raster, feeding the real FeedbackService and vendored SDK from #2794 on a temp directory,
 * with the network refused. No pixels are real here. A row of the mapping per case, through to the saved media.
 */
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFramebriar } from './vendor/framebriar/adapters/node/index.mjs';
import { asyncOnlySafeStorage, fakeKeychain } from './telemetry/__test-utils__/fake-safe-storage';
import type { FeedbackCaptureResult, FeedbackSendResult } from '../shared/feedback-types';
import { FeedbackService, pngSize } from './services/framebriar/feedback-service';
import { dataUrlToPngBlob, sendFields } from '../renderer/features/feedback/pilot-editor';
import {
  createScreenshotEditorModel, type ScreenshotEditorModel, type ScreenshotMark, type ScreenshotRaster, type ScreenshotSendStarted,
} from '../renderer/features/feedback/pilot-vendor/screenshot-editor.mjs';

const REDACT: ScreenshotMark = { type: 'redact', x: 1, y: 1, width: 2, height: 2 };
const FIRST_INVITE = 'a'.repeat(43);
const SECOND_INVITE = 'b'.repeat(43);
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function pngOf(width: number, height: number, body: string): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ihdr, Buffer.from(body)]);
}

function raster(fail: { on: boolean } = { on: false }): ScreenshotRaster {
  const noop = () => undefined;
  return {
    async decode(source) {
      const head = new DataView(await (source as Blob).slice(0, 24).arrayBuffer());
      return { width: head.getUint32(16), height: head.getUint32(20), image: source };
    },
    surface(width, height) {
      if (fail.on) throw new Error('canvas failed');
      const context = { fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, arc: noop, fill: noop } as never;
      return { context, image: {}, draw: noop, read: () => new Uint8ClampedArray(width * height * 4), release: noop };
    },
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
let dataDir: string;
let keychain: ReturnType<typeof fakeKeychain>;
const NOW = Date.parse('2026-11-01T12:00:00.000Z');

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pilot-beginsend-'));
  mkdirSync(dataDir, { recursive: true });
  keychain = fakeKeychain();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

function harness() {
  const state = { submitFails: null as { code: string; saved: boolean } | null };
  let token = 't';
  const grant = () => ({ v: 1, gameId: 'clubhouse', scopeVersion: 2, token: token.repeat(43), refreshToken: `${token}r`.repeat(22).slice(0, 43), expiresAt: new Date(NOW + 3_600_000).toISOString(), refreshExpiresAt: new Date(NOW + 30 * 86_400_000).toISOString() });
  const fetchImpl = vi.fn(async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/v1/access/redeem') || path.endsWith('/v1/access/refresh')) return json(grant());
    if (path.endsWith('/v1/access/disconnect')) return json({ v: 1, disconnected: true });
    throw new Error(`Unexpected request: ${path}`);
  });
  type Sdk = ReturnType<typeof createFramebriar> & { outbox: { dir: string; list(): Promise<Array<{ id: string }>> } };
  let sdk: Sdk | undefined;
  const service = new FeedbackService({
    safeStorage: asyncOnlySafeStorage(keychain), dataDir, appVersion: '0.42.0', isOnline: () => false,
    create: ((opts: Parameters<typeof createFramebriar>[0]) => {
      const real = createFramebriar({ ...opts, endpoint: 'https://framebriar.test/api', fetchImpl: fetchImpl as never, now: () => NOW }) as Sdk;
      sdk = { ...real, feedback: { ...real.feedback, submit: async (value: never, options: never) => {
        const fails = state.submitFails;
        state.submitFails = null;
        if (fails && !fails.saved) throw Object.assign(new Error('Local feedback storage failed'), { code: fails.code });
        return real.feedback.submit(value, options);
      } } } as Sdk;
      return sdk;
    }) as never,
    now: () => NOW, captureCorrelation: () => ({ data: {} }) as never,
    diagnostics: () => ({ status: 'none', reason: 'no_lines', windowStart: '', windowEnd: '', lines: [], bytes: 0, dropped: 0 }) as never,
    createExcerptTelemetry: vi.fn() as never, reportDiagnosticsField: true,
  });
  cleanups.push(() => service.shutdown());
  return {
    service, state,
    reconnect: async () => { await service.disconnect(); token = 'u'; await service.connect(SECOND_INVITE); },
    savedIds: async () => (await sdk!.outbox.list()).map((item) => item.id),
    media: (id: string) => readFileSync(join(sdk!.outbox.dir, 'reports', id, 'media.png')),
    hasMedia: async (id: string) => { try { readFileSync(join(sdk!.outbox.dir, 'reports', id, 'media.png')); return true; } catch { return false; } },
  };
}

const CAPTURE = pngOf(32, 20, 'the original capture of the main window');
const OTHER = pngOf(16, 10, 'another window entirely, with its own bytes');

async function opened(h: ReturnType<typeof harness>, options: { capture?: Buffer; fail?: { on: boolean } } = {}) {
  await h.service.connect(FIRST_INVITE);
  const draft = await h.service.captureDraft([{ label: 'Main window', grab: async () => options.capture ?? CAPTURE }, { label: 'Pop-out', grab: async () => OTHER }]);
  return { draft, model: modelFor(draft, options.fail) };
}
function modelFor(draft: FeedbackCaptureResult, fail?: { on: boolean }): ScreenshotEditorModel {
  return createScreenshotEditorModel({ views: draft.shots.map((s) => ({ id: s.shotId, label: s.label, source: dataUrlToPngBlob(s.preview) })), raster: raster(fail) });
}
async function started(model: ScreenshotEditorModel): Promise<ScreenshotSendStarted> {
  const begun = await model.beginSend();
  if (begun.ok !== true) throw new Error(`refused: ${begun.code}`);
  return begun;
}
async function send(h: ReturnType<typeof harness>, draftId: string, begun: ScreenshotSendStarted) {
  const fields = await sendFields(begun);
  return { fields, result: await h.service.send({ draftId, notes: 'it broke', ...fields }) };
}
const idOf = (result: FeedbackSendResult) => {
  if (result.status !== 'saved-local') throw new Error('expected a save');
  return result.id;
};
const noPayload = ({ annotatedPng, ...rest }: Awaited<ReturnType<typeof sendFields>>) => ({ ...rest, ...(annotatedPng !== undefined && { annotatedPng: 'bytes' }) });

describe('beginSend through #2794: included', () => {
  it('never edited: the original, no bytes over IPC, and main sends its capture', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    const begun = await started(model);
    expect([begun.original, begun.edited, begun.viewId]).toEqual([true, false, 's0']);
    const { fields, result } = await send(h, draft.draftId, begun);
    expect(noPayload(fields)).toEqual({ includeScreenshot: true, shotId: 's0' });
    expect(sha(h.media(idOf(result)))).toBe(sha(CAPTURE));
  });

  it('marked: flattened bytes, and main saves those', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    const begun = await started(model);
    expect([begun.original, begun.edited, begun.viewId]).toEqual([false, true, 's0']);
    const { fields, result } = await send(h, draft.draftId, begun);
    expect(noPayload(fields)).toEqual({ includeScreenshot: true, shotId: 's0', annotatedPng: 'bytes' });
    const media = h.media(idOf(result));
    expect(sha(media)).toBe(sha(Buffer.from(await begun.bytes!.arrayBuffer())));
    expect(sha(media)).not.toBe(sha(CAPTURE));
  });

  it('marked and committed, then cleared: a re-encode with edited false, and main takes it as flattened bytes', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    await model.commit();
    model.clear();
    const begun = await started(model);
    expect([begun.original, begun.edited]).toEqual([false, false]);
    const { fields, result } = await send(h, draft.draftId, begun);
    expect(noPayload(fields)).toEqual({ includeScreenshot: true, shotId: 's0', annotatedPng: 'bytes' });
    expect(sha(h.media(idOf(result)))).not.toBe(sha(CAPTURE));
  });

  it('marked and cleared with no commit: the original', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    model.clear();
    const begun = await started(model);
    expect([begun.original, begun.edited]).toEqual([true, false]);
    const { result } = await send(h, draft.draftId, begun);
    expect(sha(h.media(idOf(result)))).toBe(sha(CAPTURE));
  });

  it('never edited, over the pixel limit: fitted down, original false, and main accepts the fit', async () => {
    const big = pngOf(6016, 3384, 'a full-screen capture on a 6K display');
    const h = harness();
    const { draft, model } = await opened(h, { capture: big });
    const begun = await started(model);
    expect([begun.original, begun.edited]).toEqual([false, false]);
    const { result } = await send(h, draft.draftId, begun);
    const size = pngSize(h.media(idOf(result)))!;
    expect(size.width).toBeLessThan(6016);
    expect(size.width * size.height).toBeLessThanOrEqual(20_000_000);
  }, 60_000);

  it('the selected window is the one bound: a marked second window goes under its own id', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    model.setActiveView('s1');
    model.addMark(REDACT);
    const begun = await started(model);
    expect(begun.viewId).toBe('s1');
    const { result } = await send(h, draft.draftId, begun);
    expect(pngSize(h.media(idOf(result)))).toEqual({ width: 16, height: 10 });
  });
});

describe('beginSend through #2794: left out, and a retry', () => {
  const FAILED = { code: 'storage-full', saved: false };

  it('never edited: finalBytes held back, noEdits and shotId, and a later included Send is the capture', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.setIncluded(false);
    const begun = await started(model);
    expect([begun.bytes, begun.original, begun.edited, begun.finalBytes !== null]).toEqual([null, true, false, true]);
    h.state.submitFails = FAILED;
    const fields = await sendFields(begun);
    expect(noPayload(fields)).toEqual({ includeScreenshot: false, shotId: 's0', noEdits: true });
    await expect(h.service.send({ draftId: draft.draftId, notes: 'it broke', ...fields })).rejects.toMatchObject({ code: 'storage-full' });

    model.setIncluded(true);
    const retry = await started(model);
    const { result } = await send(h, draft.draftId, retry);
    expect(sha(h.media(idOf(result)))).toBe(sha(CAPTURE));
  });

  it('marked: the flattened bytes go, with no flag, and main can never reach the original after', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    model.setIncluded(false);
    const begun = await started(model);
    expect([begun.bytes, begun.original, begun.edited, begun.finalBytes !== null]).toEqual([null, false, true, true]);
    const fields = await sendFields(begun);
    expect(noPayload(fields)).toEqual({ includeScreenshot: false, shotId: 's0', annotatedPng: 'bytes' });
    h.state.submitFails = FAILED;
    await expect(h.service.send({ draftId: draft.draftId, notes: 'it broke', ...fields })).rejects.toMatchObject({ code: 'storage-full' });

    // A renderer that "forgets" the bytes can't get the capture back.
    await expect(h.service.send({ draftId: draft.draftId, notes: 'it broke', includeScreenshot: true, shotId: 's0' })).rejects.toMatchObject({ code: 'flattened-required' });

    model.setIncluded(true);
    const retry = await started(model);
    expect(sha(Buffer.from(await retry.bytes!.arrayBuffer()))).toBe(sha(Buffer.from(await begun.finalBytes!.arrayBuffer())));
    const { result } = await send(h, draft.draftId, retry);
    expect(sha(h.media(idOf(result)))).not.toBe(sha(CAPTURE));
  });

  it('committed then cleared: the re-encode goes, so main drops the capture', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    await model.commit();
    model.clear();
    model.setIncluded(false);
    const begun = await started(model);
    expect([begun.original, begun.edited]).toEqual([false, false]);
    const fields = await sendFields(begun);
    expect(noPayload(fields)).toEqual({ includeScreenshot: false, shotId: 's0', annotatedPng: 'bytes' });
    h.state.submitFails = FAILED;
    await expect(h.service.send({ draftId: draft.draftId, notes: 'it broke', ...fields })).rejects.toMatchObject({ code: 'storage-full' });
    await expect(h.service.send({ draftId: draft.draftId, notes: 'it broke', includeScreenshot: true, shotId: 's0' })).rejects.toMatchObject({ code: 'flattened-required' });
  });

  it('Remove: no image, no flag, no shot, and the note saves with no media', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    model.remove();
    const begun = await started(model);
    expect(begun).toEqual({ ok: true, viewId: null, bytes: null, finalBytes: null, original: false, edited: false });
    const { fields, result } = await send(h, draft.draftId, begun);
    expect(fields).toEqual({ includeScreenshot: false });
    expect(await h.hasMedia(idOf(result))).toBe(false);
  });

  it('a save failure: the second beginSend has the same bytes, flags and view, tells no one, and keeps the report id', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    const begun = await started(model);
    const fields = await sendFields(begun);
    h.state.submitFails = FAILED;
    await expect(h.service.send({ draftId: draft.draftId, notes: 'it broke', ...fields })).rejects.toMatchObject({ code: 'storage-full' });

    const snapshot = model.getSnapshot();
    const listener = vi.fn();
    model.subscribe(listener);
    const again = await started(model);
    expect(again.bytes).toBe(begun.bytes);
    expect(again.finalBytes).toBe(begun.finalBytes);
    expect([again.original, again.edited, again.viewId]).toEqual([begun.original, begun.edited, begun.viewId]);
    expect(listener).not.toHaveBeenCalled();
    expect(model.getSnapshot()).toBe(snapshot);
    const { result } = await send(h, draft.draftId, again);
    expect(sha(h.media(idOf(result)))).toBe(sha(Buffer.from(await begun.bytes!.arrayBuffer())));
  });

  it('a save failure on an original: the second beginSend is still original, and main still has the capture', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    const begun = await started(model);
    const fields = await sendFields(begun);
    h.state.submitFails = FAILED;
    await expect(h.service.send({ draftId: draft.draftId, notes: 'it broke', ...fields })).rejects.toMatchObject({ code: 'storage-full' });
    const again = await started(model);
    expect(again.original).toBe(true);
    expect(again.bytes).toBe(begun.bytes);
    const { result } = await send(h, draft.draftId, again);
    expect(sha(h.media(idOf(result)))).toBe(sha(CAPTURE));
  });
});

describe('beginSend through #2794: reopen', () => {
  it('marked: a fresh model on the carried image says original, and main sends what it carried', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    const begun = await started(model);
    const fields = await sendFields(begun);
    await h.reconnect();
    const { result } = { result: await h.service.send({ draftId: draft.draftId, notes: 'it broke', ...fields }) };
    if (result.status !== 'enrollment-changed') throw new Error('expected a reopen');

    const next = modelFor(result.draft);
    expect(next.getSnapshot().editsAreFinal).toBe(false); // No API for it: the Clear words have to come from the host.
    const carried = await started(next);
    expect([carried.original, carried.edited, carried.viewId]).toEqual([true, false, 's0']);
    const sent = await send(h, result.draft.draftId, carried);
    expect(noPayload(sent.fields)).toEqual({ includeScreenshot: true, shotId: 's0' });
    expect(sha(h.media(idOf(sent.result)))).toBe(sha(Buffer.from(await begun.bytes!.arrayBuffer())));
  });

  it('never edited, second window: the carried draft renames it s0, so a kept model would name a window main no longer has', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.setActiveView('s1');
    const begun = await started(model);
    expect(begun.viewId).toBe('s1');
    const fields = await sendFields(begun);
    await h.reconnect();
    const result = await h.service.send({ draftId: draft.draftId, notes: 'it broke', ...fields });
    if (result.status !== 'enrollment-changed') throw new Error('expected a reopen');
    expect(result.draft.shots.map((s) => s.shotId)).toEqual(['s0']);
    await expect(h.service.send({ draftId: result.draft.draftId, notes: 'it broke', ...(await sendFields(await started(model))) })).rejects.toMatchObject({ code: 'shot-unavailable' });
    const fresh = await started(modelFor(result.draft));
    expect(fresh.viewId).toBe('s0');
    const sent = await send(h, result.draft.draftId, fresh);
    expect(sha(h.media(idOf(sent.result)))).toBe(sha(OTHER));
  });

  it('left out: the reopened draft has no image, so there is no model', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    model.setIncluded(false);
    const fields = await sendFields(await started(model));
    await h.reconnect();
    const result = await h.service.send({ draftId: draft.draftId, notes: 'it broke', ...fields });
    if (result.status !== 'enrollment-changed') throw new Error('expected a reopen');
    expect(result.draft.shots).toEqual([]);
  });

  it('left out on a carried image: noEdits keeps what was carried for a later included Send', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    const begun = await started(model);
    await h.reconnect();
    const result = await h.service.send({ draftId: draft.draftId, notes: 'it broke', ...(await sendFields(begun)) });
    if (result.status !== 'enrollment-changed') throw new Error('expected a reopen');
    const next = modelFor(result.draft);
    next.setIncluded(false);
    const fields = await sendFields(await started(next));
    expect(noPayload(fields)).toEqual({ includeScreenshot: false, shotId: 's0', noEdits: true });
    h.state.submitFails = { code: 'storage-full', saved: false };
    await expect(h.service.send({ draftId: result.draft.draftId, notes: 'it broke', ...fields })).rejects.toMatchObject({ code: 'storage-full' });
    next.setIncluded(true);
    const sent = await send(h, result.draft.draftId, await started(next));
    expect(sha(h.media(idOf(sent.result)))).toBe(sha(Buffer.from(await begun.bytes!.arrayBuffer())));
  });
});

describe('refusals and the way out', () => {
  it('two beginSend calls at once: both say ok with the same bytes, so without a host guard main answers the second busy', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    const [one, two] = await Promise.all([model.beginSend(), model.beginSend()]);
    if (one.ok !== true || two.ok !== true) throw new Error('refused');
    expect(two.bytes).toBe(one.bytes);
    const [a, b] = await Promise.allSettled([send(h, draft.draftId, one), send(h, draft.draftId, two)]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const refused = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'busy' });
    expect(await h.savedIds()).toHaveLength(1);
  });

  it('prepare-failed on an excluded unattachable capture: nothing ends, the block is the words, only Remove gets the note out', async () => {
    const big = pngOf(6016, 3384, 'a full-screen capture on a 6K display');
    const fail = { on: true };
    const h = harness();
    const { draft, model } = await opened(h, { capture: big, fail });
    model.setIncluded(false);
    const before = model.getSnapshot();
    const begun = await model.beginSend();
    expect(begun).toMatchObject({ ok: false, code: 'prepare-failed', block: 'This image couldn\'t be prepared. It hasn\'t changed.', viewId: null, bytes: null, finalBytes: null });
    expect(model.getSnapshot().views.length).toBe(before.views.length);
    expect(model.getSnapshot().editsAreFinal).toBe(false);
    expect((await model.beginSend()).ok).toBe(false); // No marks to Undo or Clear, so nothing else changes the answer.
    model.remove();
    const { result } = await send(h, draft.draftId, await started(model));
    expect(await h.hasMedia(idOf(result))).toBe(false);
  }, 60_000);

  it('another window\'s failure blocks beginSend no longer, and its marks go with it, but public commit still fails on it', async () => {
    const h = harness();
    await h.service.connect(FIRST_INVITE);
    const draft = await h.service.captureDraft([{ label: 'Main window', grab: async () => CAPTURE }, { label: 'Pop-out', grab: async () => OTHER }]);
    const views = draft.shots.map((s) => ({ id: s.shotId, label: s.label, source: dataUrlToPngBlob(s.preview) }));
    const base = raster();
    const model = createScreenshotEditorModel({ views, raster: { decode: base.decode, surface(w, ht) { if (w === 16) throw new Error('canvas failed'); return base.surface(w, ht); } } });
    model.setActiveView('s1');
    model.addMark(REDACT);
    model.setActiveView('s0');
    model.addMark(REDACT);
    await expect(model.commit()).rejects.toThrow(/canvas failed/);
    expect(model.hasUncommittedMarks()).toBe(true);
    const begun = await started(model);
    expect([begun.viewId, begun.edited]).toEqual(['s0', true]);
    expect(model.hasUncommittedMarks()).toBe(false);
    const { result } = await send(h, draft.draftId, begun);
    expect(pngSize(h.media(idOf(result)))).toEqual({ width: 32, height: 20 });
  });

  it('dispose during beginSend resolves disposed, with no bytes, and doesn\'t reject', async () => {
    const big = pngOf(6016, 3384, 'a full-screen capture on a 6K display');
    const h = harness();
    const { model } = await opened(h, { capture: big });
    const pending = model.beginSend();
    await new Promise((r) => setTimeout(r, 0));
    model.dispose();
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'disposed', bytes: null, finalBytes: null });
    await expect(model.beginSend()).resolves.toMatchObject({ ok: false, code: 'disposed' });
  }, 60_000);

  it('remove during beginSend resolves as a started Send with no image', async () => {
    const big = pngOf(6016, 3384, 'a full-screen capture on a 6K display');
    const h = harness();
    const { model } = await opened(h, { capture: big });
    const pending = model.beginSend();
    await new Promise((r) => setTimeout(r, 0));
    model.remove();
    await expect(pending).resolves.toMatchObject({ ok: true, viewId: null, bytes: null, finalBytes: null });
  }, 60_000);
});
