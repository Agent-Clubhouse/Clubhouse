/**
 * PILOT, never ships. The state-level check of Begin-Send against main: the real model (Framebriar e9a4276) with a fake raster, feeding the real FeedbackService and vendored SDK from origin/main on a temp directory,
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
  const prepared: Array<Promise<{ report: { id: string } }>> = [];
  const service = new FeedbackService({
    safeStorage: asyncOnlySafeStorage(keychain), dataDir, appVersion: '0.42.0', isOnline: () => false,
    create: ((opts: Parameters<typeof createFramebriar>[0]) => {
      const real = createFramebriar({ ...opts, endpoint: 'https://framebriar.test/api', fetchImpl: fetchImpl as never, now: () => NOW }) as Sdk;
      sdk = { ...real, feedback: { ...real.feedback, prepare: (input: never) => { const result = real.feedback.prepare(input); prepared.push(result as never); return result; }, submit: async (value: never, options: never) => {
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
    lastReportId: async () => (await prepared[prepared.length - 1]).report.id,
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
function modelFor(draft: FeedbackCaptureResult, fail?: { on: boolean }, carriedFlattened = false): ScreenshotEditorModel {
  return createScreenshotEditorModel({ views: draft.shots.map((s) => ({ id: s.shotId, label: s.label, source: dataUrlToPngBlob(s.preview), ...(carriedFlattened && { editsAreFinal: true }) })), raster: raster(fail) });
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
  it('never edited: the original, its bytes go, and main takes its capture by hash', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    const begun = await started(model);
    expect([begun.original, begun.edited, begun.viewId]).toEqual([true, false, 's0']);
    const { fields, result } = await send(h, draft.draftId, begun);
    expect(noPayload(fields)).toEqual({ includeScreenshot: true, shotId: 's0', annotatedPng: 'bytes' });
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
  async function reopened(h: ReturnType<typeof harness>, edit: 'mark' | 'none' | 'second-window') {
    const { draft, model } = await opened(h);
    if (edit === 'mark') model.addMark(REDACT);
    if (edit === 'second-window') model.setActiveView('s1');
    const begun = await started(model);
    await h.reconnect();
    const result = await h.service.send({ draftId: draft.draftId, notes: 'it broke', ...(await sendFields(begun)) });
    if (result.status !== 'enrollment-changed') throw new Error('expected a reopen');
    return { begun, model, next: result.draft };
  }
  const bytesOf = async (blob: Blob | null) => Buffer.from(await blob!.arrayBuffer());
  const FAILED = { code: 'storage-full', saved: false };

  it('carried flattened, included: final from creation, original false, no bytes is refused, and bytes save', async () => {
    const h = harness();
    const { begun, next } = await reopened(h, 'mark');
    expect(begun.original).toBe(false); // What the host passes on as carriedFlattened.
    const model = modelFor(next, undefined, true);
    const start = model.getSnapshot();
    expect([start.editsAreFinal, start.edited, start.canUndo]).toEqual([true, true, false]);
    const carried = await started(model);
    expect([carried.original, carried.edited, carried.viewId]).toEqual([false, true, 's0']);
    await expect(h.service.send({ draftId: next.draftId, notes: 'it broke', includeScreenshot: true, shotId: 's0' })).rejects.toMatchObject({ code: 'flattened-required' });
    const sent = await send(h, next.draftId, carried);
    expect(noPayload(sent.fields)).toEqual({ includeScreenshot: true, shotId: 's0', annotatedPng: 'bytes' });
    expect(sha(h.media(idOf(sent.result)))).toBe(sha(await bytesOf(begun.bytes)));
  });

  it('carried flattened: Clear goes no further than the carried source, and it stays final', async () => {
    const h = harness();
    const { begun, next } = await reopened(h, 'mark');
    const model = modelFor(next, undefined, true);
    model.addMark({ type: 'redact', x: 5, y: 5, width: 2, height: 2 });
    await model.commit();
    model.clear();
    const carried = await started(model);
    expect([carried.original, carried.edited, model.getSnapshot().editsAreFinal]).toEqual([false, true, true]);
    const sent = await send(h, next.draftId, carried);
    // Fake raster: identical pixels, so this says only that main takes it. Real pixels are in the real-renderer run.
    expect(pngSize(h.media(idOf(sent.result)))).toEqual(pngSize(await bytesOf(begun.bytes)));
  });

  it('carried capture, included: the bytes are the capture, and main takes its original path by hash', async () => {
    const h = harness();
    const { next } = await reopened(h, 'none');
    const sent = await send(h, next.draftId, await started(modelFor(next)));
    expect(noPayload(sent.fields)).toEqual({ includeScreenshot: true, shotId: 's0', annotatedPng: 'bytes' });
    expect(sha(h.media(idOf(sent.result)))).toBe(sha(CAPTURE));
  });

  it('carried capture of the second window: renamed s0, and a fresh model sends it', async () => {
    const h = harness();
    const { next } = await reopened(h, 'second-window');
    expect(next.shots.map((s) => s.shotId)).toEqual(['s0']);
    const sent = await send(h, next.draftId, await started(modelFor(next)));
    expect(sha(h.media(idOf(sent.result)))).toBe(sha(OTHER));
  });

  it('TRAP: a kept model naming s1 is refused, and those capture bytes count as edits, so the capture is stranded', async () => {
    const h = harness();
    const { model, next } = await reopened(h, 'second-window');
    await expect(h.service.send({ draftId: next.draftId, notes: 'it broke', ...(await sendFields(await started(model))) })).rejects.toMatchObject({ code: 'shot-unavailable' });
    // No shot matches, so `edited` is true by imageToSend's hash test, and the png went before the refusal.
    await expect(send(h, next.draftId, await started(modelFor(next)))).rejects.toMatchObject({ code: 'flattened-required' });
  });

  it('carried flattened, new marks: a new flatten, and it fits', async () => {
    const h = harness();
    const { begun, next } = await reopened(h, 'mark');
    const model = modelFor(next, undefined, true);
    model.addMark({ type: 'redact', x: 5, y: 5, width: 2, height: 2 });
    const carried = await started(model);
    expect([carried.original, carried.edited]).toEqual([false, true]);
    const sent = await send(h, next.draftId, carried);
    const media = h.media(idOf(sent.result));
    // The fake raster's pixels are all the same, so whether the new flatten differs is for the real renderer.
    expect(sha(media)).toBe(sha(await bytesOf(carried.bytes)));
    expect(carried.bytes).not.toBe(begun.bytes);
  });

  it('carried flattened, left out, then included: its bytes go with no flag, and the next included Send brings them again', async () => {
    const h = harness();
    const { begun, next } = await reopened(h, 'mark');
    const model = modelFor(next, undefined, true);
    model.setIncluded(false);
    const fields = await sendFields(await started(model));
    expect(noPayload(fields)).toEqual({ includeScreenshot: false, shotId: 's0', annotatedPng: 'bytes' });
    h.state.submitFails = FAILED;
    await expect(h.service.send({ draftId: next.draftId, notes: 'it broke', ...fields })).rejects.toMatchObject({ code: 'storage-full' });
    await expect(h.service.send({ draftId: next.draftId, notes: 'it broke', includeScreenshot: true, shotId: 's0' })).rejects.toMatchObject({ code: 'flattened-required' });
    model.setIncluded(true);
    const sent = await send(h, next.draftId, await started(model));
    expect(sha(h.media(idOf(sent.result)))).toBe(sha(await bytesOf(begun.bytes)));
  });

  it('TRAP: editsAreFinal on a carried capture says not original, so left out it loses the capture, and the included retry is refused', async () => {
    const h = harness();
    const { begun, next } = await reopened(h, 'none');
    expect(begun.original).toBe(true); // The host's flag is false here, which is what keeps this from happening.
    const model = modelFor(next, undefined, true);
    model.setIncluded(false);
    const fields = await sendFields(await started(model));
    expect(noPayload(fields)).toEqual({ includeScreenshot: false, shotId: 's0', annotatedPng: 'bytes' });
    h.state.submitFails = FAILED;
    await expect(h.service.send({ draftId: next.draftId, notes: 'it broke', ...fields })).rejects.toMatchObject({ code: 'storage-full' });
    model.setIncluded(true);
    await expect(send(h, next.draftId, await started(model))).rejects.toMatchObject({ code: 'flattened-required' });
  });

  it('a re-encode carried over counts as flattened, because main no longer holds the capture for it', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    await model.commit();
    model.clear();
    const begun = await started(model);
    expect([begun.original, begun.edited]).toEqual([false, false]);
    await h.reconnect();
    const result = await h.service.send({ draftId: draft.draftId, notes: 'it broke', ...(await sendFields(begun)) });
    if (result.status !== 'enrollment-changed') throw new Error('expected a reopen');
    const next = modelFor(result.draft, undefined, !begun.original);
    next.setIncluded(false);
    const fields = await sendFields(await started(next));
    expect(noPayload(fields)).toEqual({ includeScreenshot: false, shotId: 's0', annotatedPng: 'bytes' });
    h.state.submitFails = FAILED;
    await expect(h.service.send({ draftId: result.draft.draftId, notes: 'it broke', ...fields })).rejects.toMatchObject({ code: 'storage-full' });
    next.setIncluded(true);
    const sent = await send(h, result.draft.draftId, await started(next));
    expect(sha(h.media(idOf(sent.result)))).toBe(sha(await bytesOf(begun.bytes)));
  });

  it('carried capture, left out, then included: noEdits keeps it, and the bytes go by hash', async () => {
    const h = harness();
    const { next } = await reopened(h, 'none');
    const model = modelFor(next);
    model.setIncluded(false);
    const fields = await sendFields(await started(model));
    expect(noPayload(fields)).toEqual({ includeScreenshot: false, shotId: 's0', noEdits: true });
    h.state.submitFails = FAILED;
    await expect(h.service.send({ draftId: next.draftId, notes: 'it broke', ...fields })).rejects.toMatchObject({ code: 'storage-full' });
    model.setIncluded(true);
    const sent = await send(h, next.draftId, await started(model));
    expect(sha(h.media(idOf(sent.result)))).toBe(sha(CAPTURE));
  });

  it('TRAP: carried capture left out with bytes and no flag: main drops it, and the included retry is refused', async () => {
    const h = harness();
    const { next } = await reopened(h, 'none');
    const model = modelFor(next);
    model.setIncluded(false);
    const begun = await started(model);
    h.state.submitFails = FAILED;
    const annotatedPng = Buffer.from(await begun.finalBytes!.arrayBuffer()).toString('base64');
    await expect(h.service.send({ draftId: next.draftId, notes: 'it broke', includeScreenshot: false, shotId: 's0', annotatedPng })).rejects.toMatchObject({ code: 'storage-full' });
    model.setIncluded(true);
    await expect(send(h, next.draftId, await started(model))).rejects.toMatchObject({ code: 'flattened-required' });
  });

  it('a flat capture left out with both bytes and the flag keeps it, so the flag is what matters, but the rule is no bytes', async () => {
    const h = harness();
    const { next } = await reopened(h, 'none');
    const model = modelFor(next);
    model.setIncluded(false);
    const begun = await started(model);
    h.state.submitFails = FAILED;
    const annotatedPng = Buffer.from(await begun.finalBytes!.arrayBuffer()).toString('base64');
    await expect(h.service.send({ draftId: next.draftId, notes: 'it broke', includeScreenshot: false, shotId: 's0', annotatedPng, noEdits: true })).rejects.toMatchObject({ code: 'storage-full' });
    model.setIncluded(true);
    const sent = await send(h, next.draftId, await started(model));
    expect(sha(h.media(idOf(sent.result)))).toBe(sha(CAPTURE));
  });

  it('marks after a reopen, left out, then included: the flatten goes both times, and the capture is gone', async () => {
    const h = harness();
    const { next } = await reopened(h, 'none');
    const model = modelFor(next);
    model.addMark(REDACT);
    model.setIncluded(false);
    const begun = await started(model);
    const fields = await sendFields(begun);
    expect(noPayload(fields)).toEqual({ includeScreenshot: false, shotId: 's0', annotatedPng: 'bytes' });
    h.state.submitFails = FAILED;
    await expect(h.service.send({ draftId: next.draftId, notes: 'it broke', ...fields })).rejects.toMatchObject({ code: 'storage-full' });
    await expect(h.service.send({ draftId: next.draftId, notes: 'it broke', includeScreenshot: true, shotId: 's0' })).rejects.toMatchObject({ code: 'flattened-required' });
    model.setIncluded(true);
    const sent = await send(h, next.draftId, await started(model));
    expect(sha(h.media(idOf(sent.result)))).toBe(sha(await bytesOf(begun.finalBytes)));
  });

  it('a second reopen: carried flattened and carried capture both still work', async () => {
    for (const edit of ['mark', 'none'] as const) {
      const h = harness();
      const { begun, next } = await reopened(h, edit);
      const model = modelFor(next, undefined, !begun.original);
      const carried = await started(model);
      await h.service.disconnect();
      await h.service.connect(FIRST_INVITE);
      const again = await h.service.send({ draftId: next.draftId, notes: 'it broke', ...(await sendFields(carried)) });
      if (again.status !== 'enrollment-changed') throw new Error('expected a second reopen');
      const sent = await send(h, again.draft.draftId, await started(modelFor(again.draft, undefined, !carried.original)));
      expect(sha(h.media(idOf(sent.result)))).toBe(sha(edit === 'mark' ? await bytesOf(begun.bytes) : CAPTURE));
      await h.service.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = mkdtempSync(join(tmpdir(), 'pilot-beginsend-'));
      keychain = fakeKeychain();
    }
  });

  it('left out at the reopen itself: no image comes across, so there is no model', async () => {
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
});

describe('refusals and the way out', () => {
  it('two beginSend calls at once: the second refuses in-progress, and the first goes on', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    const revision = model.getSnapshot().revision;
    const [one, two] = await Promise.all([model.beginSend(), model.beginSend()]);
    expect(one.ok).toBe(true);
    expect(two).toMatchObject({ ok: false, code: 'in-progress', viewId: null, bytes: null, finalBytes: null });
    expect(model.getSnapshot().revision).toBeGreaterThanOrEqual(revision);
    if (one.ok !== true) throw new Error('refused');
    const { result } = await send(h, draft.draftId, one);
    expect(await h.savedIds()).toEqual([idOf(result)]);
  });

  it('the refusal covers only the preparation: during the save a new call says ok, so without a host guard main answers it busy', async () => {
    const h = harness();
    const { draft, model } = await opened(h);
    model.addMark(REDACT);
    const one = await started(model);
    // The first save is running now: the model has finished, and only the host knows.
    const saving = send(h, draft.draftId, one);
    const two = await started(model);
    expect(two.bytes).toBe(one.bytes);
    await expect(send(h, draft.draftId, two)).rejects.toMatchObject({ code: 'busy' });
    await expect(saving).resolves.toBeTruthy();
    expect(await h.savedIds()).toHaveLength(1);
  });

  describe('report identity, under the corrected meaning of revision', () => {
    const FAILED = { code: 'storage-full', saved: false };
    const attempt = async (h: ReturnType<typeof harness>, draftId: string, model: ScreenshotEditorModel, notes = 'it broke') => {
      h.state.submitFails = FAILED;
      const fields = await sendFields(await started(model));
      await expect(h.service.send({ draftId, notes, ...fields })).rejects.toMatchObject({ code: 'storage-full' });
      return h.lastReportId();
    };

    it('Include off and on with no Send between moves revision by 2 and keeps the ID: unchanged note and bytes', async () => {
      const h = harness();
      const { draft, model } = await opened(h);
      model.addMark(REDACT);
      const first = await attempt(h, draft.draftId, model);
      const revision = model.getSnapshot().revision;
      model.setIncluded(false);
      model.setIncluded(true);
      expect(model.getSnapshot().revision).toBe(revision + 2);
      expect(await attempt(h, draft.draftId, model)).toBe(first);
    });

    it('a retry keeps the ID', async () => {
      const h = harness();
      const { draft, model } = await opened(h);
      expect(await attempt(h, draft.draftId, model)).toBe(await attempt(h, draft.draftId, model));
    });

    it('a changed note gets a new ID, and a changed image too', async () => {
      const h = harness();
      const { draft, model } = await opened(h);
      const first = await attempt(h, draft.draftId, model);
      const second = await attempt(h, draft.draftId, model, 'another note');
      expect(second).not.toBe(first);
      model.addMark(REDACT);
      expect(await attempt(h, draft.draftId, model, 'another note')).not.toBe(second);
    });

    it('EDGE: included, left out, included again, each with a failed save: the same note and bytes as the first get a new ID', async () => {
      const h = harness();
      const { draft, model } = await opened(h);
      model.addMark(REDACT);
      const first = await attempt(h, draft.draftId, model);
      model.setIncluded(false);
      const between = await attempt(h, draft.draftId, model);
      expect(between).not.toBe(first);
      model.setIncluded(true);
      expect(await attempt(h, draft.draftId, model)).not.toBe(first);
    });
  });

  it('prepare-failed on an excluded unattachable capture: nothing ends, the block is the words, only Remove gets the note out', async () => {
    const big = pngOf(6016, 3384, 'a full-screen capture on a 6K display');
    const fail = { on: true };
    const h = harness();
    const { draft, model } = await opened(h, { capture: big, fail });
    model.setIncluded(false);
    const before = model.getSnapshot();
    const begun = await model.beginSend();
    expect(begun).toMatchObject({ ok: false, code: 'prepare-failed', block: 'This image couldn\'t be prepared, so nothing was sent. Remove the screenshot to send your note.', viewId: null, bytes: null, finalBytes: null });
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
