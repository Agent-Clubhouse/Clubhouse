/**
 * PILOT, never ships. `window.__feedbackEditorPilot`: what e2e/feedback-editor-pilot-scenario.mjs drives,
 * in Electron on CI and in plain headless Chromium locally. Fakes nothing about the renderer: real canvas,
 * real CSP, real webpack output. Only the IPC call to main is replaced.
 */
import type { FeedbackCaptureResult, FeedbackSendInput, FeedbackSendResult } from '../../../shared/feedback-types';
import { useFeedbackStore } from '../../stores/feedbackStore';
import { pilotHooks } from './pilot-hooks';
import { createScreenshotEditorModel, flattenScreenshot, screenshotEditorSupported, type ScreenshotEditorModel, type ScreenshotMark, type ScreenshotRaster } from './pilot-vendor/screenshot-editor.mjs';
import { patternPixels, readRgbPng, vectorFailures, withTextChunk } from './pilot-vendor/test-support/flatten-vectors.mjs';
import { createPilotWorker } from './pilot-worker-factory';

const violations: string[] = [];
const longTasks: number[] = [];

/** A window-like picture: panels, lines of "text", and a band of noise, so PNG size is roughly realistic. */
function pictureOf(width: number, height: number, seed = 1): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  let x = (seed * 2654435761) >>> 0 || 1;
  const random = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  for (let py = 0; py < height; py++) {
    const line = Math.floor(py / 22);
    const inText = py % 22 < 12;
    const rule = random();
    for (let px = 0, i = py * width * 4; px < width; px++, i += 4) {
      const panel = Math.floor(px / 480) % 3;
      let v = 30 + panel * 12;
      if (inText && px % 480 > 24 && px % 480 < 440 && ((px >> 2) * 7 + line * 13 + (rule & 15)) % 5 < 2) v = 210;
      data[i] = v; data[i + 1] = v + (seed * 9) % 30; data[i + 2] = v + 6; data[i + 3] = 255;
      if (py > height * 0.8 && py < height * 0.85) { const n = random(); data[i] = n & 255; data[i + 1] = (n >> 8) & 255; data[i + 2] = (n >> 16) & 255; }
    }
  }
  return new ImageData(data, width, height);
}

async function pngOf(image: ImageData): Promise<Blob> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

const toDataUrl = async (blob: Blob) => `data:image/png;base64,${btoa(Array.from(new Uint8Array(await blob.arrayBuffer()), (b) => String.fromCharCode(b)).join(''))}`;

/**
 * The model's own canvas raster, which isn't exported, with one way to fail: a surface of a chosen width can't be
 * made, as when a canvas allocation fails. The preview only decodes, so it still shows, and only a flatten fails.
 */
const failingWidths = new Set<number>();
const realRaster: ScreenshotRaster = {
  async decode(source) {
    if (source instanceof ImageBitmap) return { width: source.width, height: source.height, image: source };
    const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
    return { width: bitmap.width, height: bitmap.height, image: bitmap, close() { bitmap.close(); } };
  },
  surface(width, height) {
    if (failingWidths.has(width)) throw new Error('Canvas unavailable.');
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb', willReadFrequently: true })!;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    return {
      context: context as never, image: canvas,
      draw(image) { context.drawImage(image as CanvasImageSource, 0, 0, width, height); },
      read() { return context.getImageData(0, 0, width, height).data; },
      release() { canvas.width = 0; canvas.height = 0; },
    };
  },
};

const sends: Array<{ input: Omit<FeedbackSendInput, 'annotatedPng'>; bytes: number | null; sha: string | null; annotatedPng: string | null }> = [];
let nextResults: Array<FeedbackSendResult | Error> = [];

const sha = async (base64: string) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
};

function deepActive(): string[] {
  const path: string[] = [];
  let at: Element | null = document.activeElement;
  while (at) {
    path.push(`${at.tagName.toLowerCase()}${at.getAttribute('data-action') ? `[${at.getAttribute('data-action')}]` : ''}${at.getAttribute('data-testid') ? `#${at.getAttribute('data-testid')}` : ''}`);
    at = at.shadowRoot?.activeElement ?? null;
  }
  return path;
}

const api = {
  violations,
  sends,
  supported: () => screenshotEditorSupported(),
  env: () => ({
    location: location.protocol, ua: navigator.userAgent,
    createImageBitmap: typeof createImageBitmap, offscreenCanvas: typeof OffscreenCanvas, compressionStream: typeof CompressionStream,
    adoptedStyleSheets: 'adoptedStyleSheets' in Document.prototype, dialog: typeof HTMLDialogElement,
  }),
  /** Opens the real dialog on the real store, with windows drawn here. Returns the shots' sizes and hashes. */
  async open(specs: Array<{ width: number; height: number; label: string; seed?: number }>) {
    pilotHooks.editorOptions = { raster: realRaster };
    pilotHooks.send = async (input) => {
      const { annotatedPng = null, ...rest } = input;
      sends.push({ input: rest, bytes: annotatedPng ? Math.floor(annotatedPng.length * 3 / 4) : null, sha: annotatedPng ? await sha(annotatedPng) : null, annotatedPng });
      const next = nextResults.shift();
      if (next instanceof Error) throw next;
      return next ?? { id: 'pilot-report', status: 'saved-local' as const } as unknown as FeedbackSendResult;
    };
    const shots = await Promise.all(specs.map(async (spec, i) => ({ shotId: `s${i}`, label: spec.label, preview: await toDataUrl(await pngOf(pictureOf(spec.width, spec.height, spec.seed ?? i + 1))) })));
    const draft: FeedbackCaptureResult = { draftId: `pilot-${Date.now()}`, preview: shots[0]?.preview ?? null, shots };
    useFeedbackStore.getState().closeDraft();
    useFeedbackStore.getState().openDraft(draft);
    return Promise.all(shots.map(async (s) => ({ shotId: s.shotId, sha: await sha(s.preview.slice(s.preview.indexOf(',') + 1)) })));
  },
  close: () => useFeedbackStore.getState().closeDraft(),
  storeHoldsImages: () => {
    const draft = useFeedbackStore.getState().draft;
    return draft ? draft.preview !== null || draft.shots.some((s) => s.preview) : false;
  },
  failNextSend: (message: string) => { nextResults.push(Object.assign(new Error(message), { code: 'storage-full' })); },
  /** The next Send is answered the way main answers a moved enrollment: a new draft with the sent image. */
  reopenOnNextSend: () => {
    nextResults = [];
    const original = pilotHooks.send!;
    pilotHooks.send = async (input) => {
      pilotHooks.send = original;
      const preview = `data:image/png;base64,${input.annotatedPng}`;
      return { status: 'enrollment-changed', draft: { draftId: `pilot-${Date.now()}`, preview, shots: [{ shotId: 's0', label: 'This window', preview }] } } as FeedbackSendResult;
    };
  },
  deepActive,
  failFlattenOf: (width: number) => { failingWidths.add(width); },
  clearFailures: () => { failingWidths.clear(); },
  sendCount: () => sends.length,

  // ---- Revert, Cancel and Clear after finality, with real pixels: can anything from before it come back? ----
  async revertCases() {
    const SECRET = [250, 10, 20];
    const canvas = new OffscreenCanvas(64, 64);
    const context = canvas.getContext('2d')!;
    context.fillStyle = `rgb(${SECRET.join(',')})`;
    context.fillRect(0, 0, 64, 64);
    const source = await canvas.convertToBlob({ type: 'image/png' });
    const RED: ScreenshotMark = { type: 'redact', x: 0, y: 0, width: 32, height: 32 };
    const LATER: ScreenshotMark = { type: 'redact', x: 40, y: 40, width: 8, height: 8 };
    const pixelOf = async (blob: Blob | null, x = 10, y = 10) => {
      if (!blob) return null;
      const bitmap = await createImageBitmap(blob);
      const read = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true })!;
      read.drawImage(bitmap, 0, 0);
      bitmap.close();
      return Array.from(read.getImageData(x, y, 1, 1).data.slice(0, 3));
    };
    const previewOf = async (model: ScreenshotEditorModel) => {
      const frame = await model.openPreview();
      const read = new OffscreenCanvas(64, 64).getContext('2d', { willReadFrequently: true })!;
      frame?.draw(read);
      frame?.close();
      return Array.from(read.getImageData(10, 10, 1, 1).data.slice(0, 3));
    };
    // A Send that started, whose save then failed: what a Cancel or Clear from here can reach.
    const afterFailedSend = async () => {
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source }] });
      model.addMark(RED);
      const first = await model.beginSend();
      return { model, first };
    };
    const rows: Array<Record<string, unknown>> = [];
    const row = async (name: string, model: ScreenshotEditorModel, extra: Record<string, unknown> = {}) => {
      const { marks, editsAreFinal, edited, dirty } = model.getSnapshot();
      const begun = await model.beginSend();
      rows.push({ name, marks: marks.length, editsAreFinal, edited, dirty, ok: begun.ok, original: begun.original, covered: await pixelOf(begun.finalBytes), preview: await previewOf(model), ...extra });
      model.dispose();
    };
    {
      const { model, first } = await afterFailedSend();
      model.addMark(LATER);
      model.revert();
      await row('after failed Send: mark, then Cancel', model, { sameBytes: (await model.beginSend()).finalBytes === first.finalBytes });
    }
    {
      const { model } = await afterFailedSend();
      model.addMark(LATER);
      await model.commit();
      model.undo();
      model.revert();
      await row('after failed Send: mark, Done, Undo, then Cancel', model);
    }
    {
      const { model } = await afterFailedSend();
      model.addMark(LATER);
      await model.commit();
      model.clear();
      await model.commit();
      await row('after failed Send: mark, Done, Clear, Done', model);
    }
    {
      const { model } = await afterFailedSend();
      model.revert();
      model.clear();
      await row('after failed Send: Cancel and Clear with no new marks', model);
    }
    {
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source }] });
      model.addMark(RED);
      await model.commit();
      model.addMark(LATER);
      model.revert();
      await row('before any Send: Done, mark, Cancel returns to the Done', model);
    }
    {
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source }] });
      model.addMark(RED);
      model.revert();
      await row('before any Send: mark, Cancel: the original, which is honest and no Send has started', model);
    }
    {
      const flattened = (await (await afterFailedSend()).first).finalBytes!;
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source: flattened, editsAreFinal: true }] });
      model.addMark(LATER);
      await model.commit();
      model.clear();
      await model.commit();
      await row('carried: mark, Done, Clear, Done', model);
    }
    {
      const flattened = (await (await afterFailedSend()).first).finalBytes!;
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source: flattened, editsAreFinal: true }] });
      model.addMark(LATER);
      model.revert();
      await row('carried: mark, Cancel', model);
    }
    // A refused Send ends nothing, so a revert there is still reversible: what it can reach.
    {
      const failing: ScreenshotRaster = { ...realRaster, surface() { throw new Error('Canvas unavailable.'); } };
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: failing });
      model.addMark(RED);
      const refused = await model.beginSend();
      model.revert();
      const after = model.getSnapshot();
      await row('refused Send, then revert', model, { refused: 'code' in refused ? refused.code : null, finalAfterRevert: after.editsAreFinal });
    }
    return { secret: SECRET, rows };
  },

  // ---- Two calls at once, and one during the save, with real pixels ----
  async concurrentCases() {
    const source = await pngOf(pictureOf(1600, 1000));
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }] });
    model.addMark({ type: 'redact', x: 0, y: 0, width: 32, height: 32 });
    const before = model.getSnapshot().revision;
    const [one, two] = await Promise.all([model.beginSend(), model.beginSend()]);
    const during = await model.beginSend();
    const row = { first: one.ok, second: two.ok, secondCode: 'code' in two ? two.code : null, secondBlock: 'block' in two ? two.block : null, afterFirstEnds: during.ok, sameBytesAfter: during.finalBytes === one.finalBytes, revisionMoved: model.getSnapshot().revision - before };
    model.dispose();
    return row;
  },

  // ---- Begin-Send with real pixels, one row per case, and what a retry does ----
  async beginSendCases() {
    const SECRET = [250, 10, 20];
    const canvas = new OffscreenCanvas(64, 64);
    const context = canvas.getContext('2d')!;
    context.fillStyle = `rgb(${SECRET.join(',')})`;
    context.fillRect(0, 0, 64, 64);
    const source = await canvas.convertToBlob({ type: 'image/png' });
    const other = await pngOf(pictureOf(48, 48));
    const RED: ScreenshotMark = { type: 'redact', x: 0, y: 0, width: 32, height: 32 };
    const covered = async (blob: Blob | null) => {
      if (!blob) return null;
      const bitmap = await createImageBitmap(blob);
      const read = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true })!;
      read.drawImage(bitmap, 0, 0);
      bitmap.close();
      return Array.from(read.getImageData(10, 10, 1, 1).data.slice(0, 3));
    };
    const run = async (name: string, setUp: (model: ScreenshotEditorModel) => Promise<void> | void, views = [{ id: 's0', label: 'Main', source }]) => {
      const model = createScreenshotEditorModel({ views });
      await setUp(model);
      const begun = await model.beginSend();
      const before = model.getSnapshot();
      let notified = 0;
      model.subscribe(() => { notified++; });
      const again = await model.beginSend();
      const row = {
        name, ok: begun.ok, viewId: begun.viewId, hasBytes: begun.bytes !== null, hasFinal: begun.finalBytes !== null, original: begun.original, edited: begun.edited,
        finalIsSource: begun.finalBytes === source, coveredPixel: await covered(begun.finalBytes),
        final: before.editsAreFinal, viewsLeft: before.views.length,
        retry: { sameBytes: again.bytes === begun.bytes, sameFinal: again.finalBytes === begun.finalBytes, sameFlags: again.original === begun.original && again.edited === begun.edited && again.viewId === begun.viewId, notified, sameSnapshot: model.getSnapshot() === before },
      };
      model.dispose();
      return row;
    };
    const big = await pngOf(pictureOf(6016, 3384));
    const during = async (act: 'dispose' | 'remove') => {
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source: big }] });
      const pending = model.beginSend();
      await new Promise((r) => setTimeout(r, 20));
      if (act === 'dispose') model.dispose(); else model.remove();
      const answer: { settled: string; ok: boolean | null; code: string | null; hasFinal: boolean | null } = await pending.then((value) => ({ settled: 'resolved', ok: value.ok, code: 'code' in value ? value.code : null, hasFinal: value.finalBytes !== null }), (error: Error) => ({ settled: `rejected ${error.name}`, ok: null as boolean | null, code: null as string | null, hasFinal: null as boolean | null }));
      await new Promise((r) => setTimeout(r, 200));
      return { ...answer, later: await model.beginSend().then((value) => ('code' in value ? value.code : 'ok')) };
    };
    return {
      secret: SECRET,
      rows: [
        await run('never edited', () => undefined),
        await run('marked', (m) => { m.addMark(RED); }),
        await run('marked, committed, cleared', async (m) => { m.addMark(RED); await m.commit(); m.clear(); }),
        await run('marked, cleared, no commit', (m) => { m.addMark(RED); m.clear(); }),
        await run('left out, never edited', (m) => { m.setIncluded(false); }),
        await run('left out, marked', (m) => { m.addMark(RED); m.setIncluded(false); }),
        await run('left out, committed, cleared', async (m) => { m.addMark(RED); await m.commit(); m.clear(); m.setIncluded(false); }),
        await run('removed', (m) => { m.addMark(RED); m.remove(); }),
        await run('second of two windows selected', (m) => { m.addMark(RED); m.setActiveView('s1'); }, [{ id: 's0', label: 'Main', source }, { id: 's1', label: 'Pop-out', source: other }]),
      ],
      dispose: await during('dispose'),
      remove: await during('remove'),
    };
  },
  /** The SDK view's inner element for a selector, through its shadow root. */
  deepRect(selector: string) {
    const host = document.querySelector('[data-feedback-capture="exclude"]');
    const el = (host?.shadowRoot ?? document).querySelector(selector) ?? document.querySelector(selector);
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const box = el.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  },
  mountedState() {
    const host = document.querySelector('[data-feedback-capture="exclude"]');
    const root = host?.shadowRoot;
    const dialog = root?.querySelector('dialog.editor') as HTMLDialogElement | undefined;
    const stage = root?.querySelector('.stage');
    return {
      mounted: Boolean(host),
      open: dialog?.open ?? false,
      modal: dialog?.matches(':modal') ?? false,
      sheets: root?.adoptedStyleSheets.length ?? 0,
      background: dialog ? getComputedStyle(dialog).backgroundColor : null,
      text: dialog ? getComputedStyle(dialog).color : null,
      stageVar: stage ? getComputedStyle(stage).backgroundColor : null,
      fontFamily: dialog ? getComputedStyle(dialog).fontFamily : null,
      fontSize: dialog ? getComputedStyle(dialog).fontSize : null,
      buttonHeight: root?.querySelector('button')?.getBoundingClientRect().height ?? null,
      themeBase: getComputedStyle(document.documentElement).getPropertyValue('--ctp-base'),
      confirmText: (root?.querySelector('dialog.confirm p') as HTMLElement | null)?.textContent ?? null,
    };
  },
  /** A pixel of the bytes that would reach main, read from the PNG itself, not through a browser decoder. */
  async sentPixels(index: number, points: Array<[number, number]>) {
    const sent = sends[index < 0 ? sends.length + index : index];
    if (!sent?.annotatedPng) return null;
    const bytes = Uint8Array.from(atob(sent.annotatedPng), (c) => c.charCodeAt(0));
    const png = await readRgbPng(new Blob([bytes], { type: 'image/png' }));
    return { width: png.width, height: png.height, chunks: png.chunks.map((c: { type: string }) => c.type).filter((t: string, i: number, all: string[]) => all.indexOf(t) === i), colorType: png.colorType, pixels: png.pixels ? points.map(([x, y]) => png.at(x, y)) : null };
  },

  // ---- contract section 3: the shared vectors, the way the contract and Framebriar's own page run them ----
  async runVector(fixture: { vectors: Array<{ id: string; source: { width: number; height: number; pattern: unknown; metadataText?: string }; marks: ScreenshotMark[]; limits?: object; expect: { rejects?: boolean } }> }, id: string) {
    const vector = fixture.vectors.find((item) => item.id === id)!;
    let source = await pngOf(new ImageData(patternPixels(vector.source), vector.source.width, vector.source.height));
    if (vector.source.metadataText) source = new Blob([withTextChunk(new Uint8Array(await source.arrayBuffer()), vector.source.metadataText)], { type: 'image/png' });
    const started = performance.now();
    try {
      const output = await flattenScreenshot(source, vector.marks, { limits: vector.limits });
      const ms = Math.round(performance.now() - started);
      if (vector.expect.rejects) return { id, failures: ['should have failed'], ms };
      const failures: string[] = await vectorFailures(fixture, vector, output);
      if (output === source) failures.push('returned the source');
      const read = await readRgbPng(output);
      const chunks = read.chunks.map((chunk: { type: string }) => chunk.type).join();
      if (chunks !== 'IHDR,IDAT,IEND') failures.push(`chunks ${chunks}`);
      return { id, failures, ms, size: output.size, width: read.width, height: read.height };
    } catch (error) {
      return { id, failures: vector.expect.rejects ? [] : [`rejected: ${(error as Error).message}`], ms: Math.round(performance.now() - started) };
    }
  },

  // ---- Include off, Send fails, Include on, with real pixels: is any original pixel reachable? ----
  async leftOutCases() {
    const SECRET = [250, 10, 20];
    const canvas = new OffscreenCanvas(64, 64);
    const context = canvas.getContext('2d')!;
    context.fillStyle = `rgb(${SECRET.join(',')})`;
    context.fillRect(0, 0, 64, 64);
    const source = await canvas.convertToBlob({ type: 'image/png' });
    const describeBytes = async (bytes: Blob | null) => {
      if (!bytes) return null;
      // The source is the browser's own RGBA PNG, which the fixture's reader doesn't parse: only flattened bytes are RGB.
      const png = await readRgbPng(bytes);
      if (png.pixels) return { isSource: bytes === source, covered: png.at(10, 10), outside: png.at(60, 60) };
      const bitmap = await createImageBitmap(bytes);
      const read = new OffscreenCanvas(64, 64).getContext('2d', { willReadFrequently: true })!;
      read.drawImage(bitmap, 0, 0);
      bitmap.close();
      const at = (x: number, y: number) => Array.from(read.getImageData(x, y, 1, 1).data.slice(0, 3));
      return { isSource: bytes === source, covered: at(10, 10), outside: at(60, 60), colorType: png.colorType };
    };
    const row = async (step: string, model: ScreenshotEditorModel) => {
      const { edited, dirty, editsAreFinal, revision } = model.getSnapshot();
      return { step, edited, dirty, final: editsAreFinal, revision, bytes: await describeBytes(await model.bytesToSend()) };
    };
    const run = async (mark: boolean) => {
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source }] });
      const rows = [await row('open', model)];
      if (mark) {
        model.addMark({ type: 'redact', x: 0, y: 0, width: 32, height: 32 });
        await model.commit();
        rows.push(await row('marked and committed', model));
      }
      model.setIncluded(false);
      rows.push(await row('include off', model));
      await model.commit();
      const noEdits = !model.getSnapshot().edited;
      model.endReversibility();
      rows.push({ ...(await row('left-out Send, then it fails', model)), noEdits } as (typeof rows)[number]);
      model.setIncluded(true);
      rows.push(await row('include on', model));
      const frame = await model.openPreview();
      const seen = new OffscreenCanvas(64, 64).getContext('2d', { willReadFrequently: true })!;
      frame?.draw(seen);
      frame?.close();
      const previewAfter = Array.from(seen.getImageData(10, 10, 1, 1).data.slice(0, 3));
      model.dispose();
      return { rows, previewAfter };
    };
    return { secret: SECRET, neverEdited: await run(false), edited: await run(true) };
  },

  // ---- who hears a key while the mounted view has focus ----
  watchKeys() {
    const heard = { windowCapture: 0, documentCapture: 0, documentBubble: 0, windowBubble: 0 };
    window.addEventListener('keydown', () => { heard.windowCapture++; }, true);
    document.addEventListener('keydown', () => { heard.documentCapture++; }, true);
    document.addEventListener('keydown', () => { heard.documentBubble++; });
    window.addEventListener('keydown', () => { heard.windowBubble++; });
    (api as unknown as { heard: typeof heard }).heard = heard;
  },
  heardKeys: () => ({ ...(api as unknown as { heard: object }).heard }),

  // ---- CSP: what works under the policy this page really has ----
  async probeCsp() {
    const blob = await pngOf(pictureOf(16, 16));
    const loads = (src: string) => new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = src;
    });
    const objectUrl = URL.createObjectURL(blob);
    const before = violations.length;
    const result = {
      imgBlobUrl: await loads(objectUrl),
      imgDataUrl: await loads(await toDataUrl(blob)),
      createImageBitmapFromBlob: await createImageBitmap(blob).then((b) => { b.close(); return true; }, () => false),
      fetchDataUrl: await fetch(await toDataUrl(blob)).then((r) => r.ok, () => false),
      constructableSheet: (() => { try { new CSSStyleSheet().replaceSync('p{color:red}'); return true; } catch { /* telemetry-exempt: pilot probe */ return false; } })(),
      violations: [] as string[],
    };
    URL.revokeObjectURL(objectUrl);
    await new Promise((r) => setTimeout(r, 50));
    result.violations = violations.slice(before);
    return result;
  },
  async probeWorker() {
    const blob = await pngOf(pictureOf(400, 300));
    let messages = 0;
    let errors = 0;
    let created = 0;
    const started = performance.now();
    const output = await flattenScreenshot(blob, [{ type: 'redact', x: 10, y: 10, width: 40, height: 40 }], {
      workerFactory: () => {
        created++;
        const worker = createPilotWorker();
        worker.addEventListener('message', () => { messages++; });
        worker.addEventListener('error', () => { errors++; });
        return worker;
      },
    });
    return { created, messages, errors, ms: Math.round(performance.now() - started), size: output.size };
  },

  // ---- size: flatten time, main-thread blocking and encoder size at real capture sizes ----
  async perf(width: number, height: number, useWorker = false) {
    const picture = pictureOf(width, height);
    const source = await pngOf(picture);
    longTasks.length = 0;
    const started = performance.now();
    const output = await flattenScreenshot(source, [{ type: 'redact', x: width * 0.1, y: height * 0.1, width: width * 0.2, height: height * 0.1 }], useWorker ? { workerFactory: createPilotWorker } : {});
    const ms = Math.round(performance.now() - started);
    await new Promise((r) => setTimeout(r, 100));
    return {
      width, height, useWorker, ms,
      longestTaskMs: Math.round(Math.max(0, ...longTasks)),
      sourceBytes: source.size, flattenedBytes: output.size,
      decodedMb: Math.round(width * height * 4 / 1048576),
      outWidth: new DataView(await output.slice(16, 20).arrayBuffer()).getUint32(0),
    };
  },
};

declare global {
  interface Window { __feedbackEditorPilot?: typeof api }
}

if (typeof document !== 'undefined' && !navigator.userAgent.includes('jsdom')) {
  document.addEventListener('securitypolicyviolation', (event) => violations.push(`${event.violatedDirective} ${event.blockedURI}`));
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) longTasks.push(entry.duration); }).observe({ entryTypes: ['longtask'] });
  } catch { // telemetry-exempt: pilot, no long task data then
  }
  window.__feedbackEditorPilot = api;
}
