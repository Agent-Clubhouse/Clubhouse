/**
 * PILOT, never ships. What the pinned model does in jsdom and under React, recorded as tests so each
 * finding has something to run. A test named "GAP:" passes because the gap is real.
 */
import { StrictMode, useEffect, useState, useSyncExternalStore } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  createScreenshotEditorModel, flattenScreenshot, mountScreenshotEditor, renderMarks, screenshotEditorSupported,
  type ScreenshotEditorModel, type ScreenshotMark, type ScreenshotRaster,
} from './pilot-vendor/screenshot-editor.mjs';
import { FEEDBACK_COPY, logsControl, type FeedbackCopy } from './pilot-vendor/feedback-copy.mjs';
import { beginSend, dataUrlToPngBlob, useScreenshotEditorModel } from './pilot-editor';

/** A real PNG header with the given size. The fake raster never reads the rest. */
function pngOf(width: number, height: number, tag = 0): Blob {
  const bytes = new Uint8Array(40);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes[39] = tag;
  return new Blob([bytes], { type: 'image/png' });
}

/** Solid pixels from arrays, what the contract's "injectable raster for Node tests" means in practice. */
function fakeRaster(options: { fail?: (source: unknown) => boolean } = {}): ScreenshotRaster {
  const noop = () => undefined;
  return {
    async decode(source) {
      if (options.fail?.(source)) throw new Error('decode failed');
      const head = new DataView(await (source as Blob).slice(0, 24).arrayBuffer());
      return { width: head.getUint32(16), height: head.getUint32(20), image: source };
    },
    surface(width, height) {
      const context = { fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, arc: noop, fill: noop } as unknown as Parameters<typeof renderMarks>[0];
      return { context, image: {}, draw: noop, read: () => new Uint8ClampedArray(width * height * 4), release: noop };
    },
  };
}

const REDACT: ScreenshotMark = { type: 'redact', x: 1, y: 1, width: 2, height: 2 };
const PEN: ScreenshotMark = { type: 'pen', points: [[1, 1], [2, 2]], width: 2, ink: 'yellow' };
const pixelsOf = async (blob: Blob) => {
  const head = new DataView(await blob.slice(0, 24).arrayBuffer());
  return { width: head.getUint32(16), height: head.getUint32(20) };
};
const firstSend = async (model: ScreenshotEditorModel) => {
  await model.commit();
  model.endReversibility();
  return model.bytesToSend();
};

describe('what jsdom has', () => {
  it('records the globals the modules reach for', () => {
    const probe = window as unknown as Record<string, unknown>;
    expect({
      createImageBitmap: typeof probe.createImageBitmap,
      OffscreenCanvas: typeof probe.OffscreenCanvas,
      ResizeObserver: typeof probe.ResizeObserver,
      showModal: typeof HTMLDialogElement.prototype.showModal,
      replaceSync: 'replaceSync' in CSSStyleSheet.prototype,
      blobArrayBuffer: typeof Blob.prototype.arrayBuffer,
      CompressionStream: typeof CompressionStream,
      Response: typeof Response,
    }).toMatchSnapshot();
  });

  it('GAP: says the mounted view is supported, then mounting throws on showModal and the model stays marked as mounted', () => {
    expect(screenshotEditorSupported()).toBe(true);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }], raster: fakeRaster() });
    const container = document.createElement('div');
    expect(() => mountScreenshotEditor(container, { model })).toThrow(/showModal/);
    // The second call returns the half-built view from the WeakMap rather than throwing again.
    expect(mountScreenshotEditor(container, { model }).root).toBe(container.firstElementChild);
  });

  it('runs the headless model with an injected raster: marks, commit and PNG encoding', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    model.addMark(REDACT);
    const bytes = await firstSend(model);
    expect(bytes).not.toBe(source);
    expect(await pixelsOf(bytes!)).toEqual({ width: 4, height: 4 });
  });

  it('cannot flatten without a raster, because createImageBitmap is missing', async () => {
    await expect(flattenScreenshot(pngOf(4, 4), [])).rejects.toThrow(/createImageBitmap/);
  });
});

describe('types', () => {
  it('resolve through the .d.mts under moduleResolution: node, and FeedbackCopy is not any', () => {
    const inks: FeedbackCopy['inks'] = FEEDBACK_COPY.inks;
    // @ts-expect-error if FeedbackCopy collapsed to any this directive would itself be an error
    const wrong: number = inks.default;
    expect(wrong).toBe('red');
  });
});

describe('shots as views', () => {
  it('needs a PNG type on the Blob, or an unedited capture is re-encoded rather than attached', async () => {
    const typed = dataUrlToPngBlob('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAMBAQB+AwEAAAAASUVORK5CYII=');
    expect(typed.type).toBe('image/png');
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: typed }], raster: fakeRaster() });
    expect(await model.bytesToSend()).toBe(typed);

    const untyped = new Blob([await typed.arrayBuffer()]);
    const other = createScreenshotEditorModel({ views: [{ id: 's0', source: untyped }], raster: fakeRaster() });
    expect(await other.bytesToSend()).not.toBe(untyped);
  });

  it('GAP: throws on no views and on the empty shotId of an older main, so a text-only draft has no model at all', () => {
    expect(() => createScreenshotEditorModel({ views: [] })).toThrow(/At least one view/);
    expect(() => createScreenshotEditorModel({ views: [{ id: '', source: pngOf(4, 4) }] })).toThrow(/own id/);
  });

  it('keeps marks per view, and a Send tap flattens the views it is about to drop', async () => {
    const decoded: unknown[] = [];
    const raster = fakeRaster({ fail: (source) => { decoded.push(source); return false; } });
    const a = pngOf(4, 4, 1);
    const b = pngOf(8, 8, 2);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', label: 'Main', source: a }, { id: 's1', label: 'Pop-out', source: b }], raster });
    model.addMark(PEN);
    model.setActiveView('s1');
    expect(model.getSnapshot().marks).toEqual([]);
    model.addMark(REDACT);
    model.setActiveView('s0');
    expect(model.getSnapshot().marks).toHaveLength(1);
    await firstSend(model);
    expect(decoded).toContain(b); // s1 was flattened, then thrown away
    expect(model.getSnapshot().views.map((v) => v.id)).toEqual(['s0']);
  });

  it('GAP: a flatten failure on the view not being sent blocks the Send of the view that is', async () => {
    const b = pngOf(8, 8, 2);
    const model = createScreenshotEditorModel({
      views: [{ id: 's0', source: pngOf(4, 4, 1) }, { id: 's1', source: b }],
      raster: fakeRaster({ fail: (source) => source === b }),
    });
    model.setActiveView('s1');
    model.addMark(REDACT);
    model.setActiveView('s0');
    await expect(model.commit()).rejects.toThrow(/decode failed/);
    expect(() => model.endReversibility()).toThrow(/Commit or revert/);
    expect(model.getSnapshot().editsAreFinal).toBe(false);
  });

  it('locks the view after the first Send: the dropped id is a silent no-op and an unknown id throws', async () => {
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4, 1) }, { id: 's1', source: pngOf(8, 8, 2) }], raster: fakeRaster() });
    await firstSend(model);
    const before = model.getSnapshot();
    model.setActiveView('s1');
    expect(model.getSnapshot()).toBe(before);
    expect(() => model.setActiveView('nope')).toThrow(/Unknown view/);
  });
});

describe('edited, dirty and revision', () => {
  it('walks mark, commit, Cancel, Undo and Clear', async () => {
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }], raster: fakeRaster() });
    const start = model.getSnapshot();
    expect([start.edited, start.dirty, start.revision]).toEqual([false, false, 0]);

    model.addMark(PEN);
    expect([model.getSnapshot().edited, model.getSnapshot().dirty, model.getSnapshot().revision]).toEqual([false, true, 0]);
    model.revert();
    expect([model.getSnapshot().marks.length, model.getSnapshot().dirty, model.getSnapshot().revision]).toEqual([0, false, 0]);

    model.addMark(PEN);
    await model.commit();
    const committed = model.getSnapshot();
    expect([committed.edited, committed.dirty]).toEqual([true, false]);
    expect(committed.revision).toBe(1);

    model.undo();
    expect([model.getSnapshot().edited, model.getSnapshot().dirty]).toEqual([true, true]);
    model.revert();
    expect(model.getSnapshot().marks).toHaveLength(1);
    expect(model.getSnapshot().revision).toBe(1);
  });

  it('GAP: after Clear, edited is false yet bytesToSend is not the attachment, so edited cannot decide what to upload', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    model.addMark(REDACT);
    await model.commit();
    model.clear();
    await model.commit();
    expect(model.getSnapshot().edited).toBe(false);
    const bytes = await model.bytesToSend();
    expect(bytes).not.toBe(source);
  });

  it('GAP: an unedited capture over the pixel limit is fitted down with edited false, and the size no longer matches main', async () => {
    const source = pngOf(6016, 3384); // A full-screen capture on a 6K display: 20.36 MP.
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    const bytes = await firstSend(model);
    expect(model.getSnapshot().edited).toBe(false);
    expect(bytes).not.toBe(source);
    const out = await pixelsOf(bytes!);
    expect(out.width).toBeLessThan(6016);
    expect(out.width * out.height).toBeLessThanOrEqual(20_000_000);
  }, 60_000);

  it('GAP: Include off and on moves revision twice with the same bytes, where section 5 keeps the same report ID', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    const first = await model.bytesToSend();
    const revision = model.getSnapshot().revision;
    model.setIncluded(false);
    expect(await model.bytesToSend()).toBeNull();
    model.setIncluded(true);
    expect(model.getSnapshot().revision).toBe(revision + 2);
    expect(await model.bytesToSend()).toBe(first);
  });
});

describe('first Send', () => {
  it('throws on uncommitted marks, so commit has to come first', () => {
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }], raster: fakeRaster() });
    model.addMark(PEN);
    expect(() => model.endReversibility()).toThrow(/Commit or revert/);
  });

  it('is final after a Send with marks: Clear can\'t bring the original back, and the same bytes retry', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    model.addMark(REDACT);
    const sent = await firstSend(model);
    const after = model.getSnapshot();
    expect([after.editsAreFinal, after.marks.length, after.edited, after.imageVersion]).toEqual([true, 0, true, 1]);
    expect(await firstSend(model)).toBe(sent);
    model.addMark(PEN);
    model.clear();
    expect(await firstSend(model)).toBe(sent);
  });

  it('GAP: a fresh model on a carried-over image can\'t be made final, so after a reopen Clear says the original comes back', async () => {
    // What FeedbackDialogHost does today: a reopened draft is a new draftId, so a new dialog and a new model.
    const flattened = pngOf(4, 4, 9);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: flattened }], raster: fakeRaster() });
    model.endReversibility();
    expect(model.getSnapshot().editsAreFinal).toBe(false);
    expect(model.getSnapshot().edited).toBe(false);
  });

  it('with the image left out still ends reversibility, and bytes are null', async () => {
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }, { id: 's1', source: pngOf(8, 8) }], raster: fakeRaster() });
    model.setIncluded(false);
    expect(await firstSend(model)).toBeNull();
    expect(model.getSnapshot().views).toHaveLength(1);
  });

  it('Remove drops everything and moves revision', async () => {
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }], raster: fakeRaster() });
    const revision = model.getSnapshot().revision;
    model.remove();
    expect(model.getSnapshot().status).toBe('removed');
    expect(model.getSnapshot().revision).toBeGreaterThan(revision);
    expect(await model.bytesToSend()).toBeNull();
    expect(model.addMark(PEN)).toBe(false);
  });
});

describe('Include off, Send fails, Include on', () => {
  // The host's Send tap, with main answering "failed". What the left-out Send would say is read after commit.
  const leftOutSend = async (model: ScreenshotEditorModel) => {
    await model.commit();
    const atSend = model.getSnapshot().edited;
    model.endReversibility();
    const bytes = await model.bytesToSend();
    return { atSend, bytes };
  };
  const row = (model: ScreenshotEditorModel) => {
    const s = model.getSnapshot();
    return { edited: s.edited, dirty: s.dirty, final: s.editsAreFinal, revision: s.revision };
  };

  it('never edited: edited stays false, null while left out, then the source itself', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    expect(row(model)).toEqual({ edited: false, dirty: false, final: false, revision: 0 });
    expect(await model.bytesToSend()).toBe(source);

    model.setIncluded(false);
    expect(row(model)).toEqual({ edited: false, dirty: false, final: false, revision: 1 });
    expect(await model.bytesToSend()).toBeNull();

    const { atSend, bytes } = await leftOutSend(model);
    expect(atSend).toBe(false);
    expect(bytes).toBeNull();
    expect(row(model)).toEqual({ edited: false, dirty: false, final: false, revision: 1 });

    model.setIncluded(true);
    expect(row(model)).toEqual({ edited: false, dirty: false, final: false, revision: 2 });
    expect(await model.bytesToSend()).toBe(source);
  });

  it('edited and committed: edited is true at the left-out Send, and Include on gives the flattened bytes, never the source', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    model.addMark(REDACT);
    await model.commit();
    expect(row(model)).toEqual({ edited: true, dirty: false, final: false, revision: 1 });
    const flattened = await model.bytesToSend();
    expect(flattened).not.toBe(source);

    model.setIncluded(false);
    expect(row(model)).toEqual({ edited: true, dirty: false, final: false, revision: 2 });
    expect(await model.bytesToSend()).toBeNull();

    const { atSend, bytes } = await leftOutSend(model);
    expect(atSend).toBe(true);
    expect(bytes).toBeNull();
    expect(row(model)).toEqual({ edited: true, dirty: false, final: true, revision: 2 });

    model.setIncluded(true);
    expect(row(model)).toEqual({ edited: true, dirty: false, final: true, revision: 3 });
    const after = await model.bytesToSend();
    expect(after).toBe(flattened);
    expect(after).not.toBe(source);
  });

  it('never prepared: marks committed with the image off still flatten, and Include on still gives those bytes', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    model.addMark(REDACT);
    model.setIncluded(false);
    const { atSend, bytes } = await leftOutSend(model);
    expect([atSend, bytes]).toEqual([true, null]);
    model.setIncluded(true);
    expect(await model.bytesToSend()).not.toBe(source);
  });

  it('GAP: edited reads false while marks are uncommitted, so read before commit it would wrongly say no edits', async () => {
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }], raster: fakeRaster() });
    model.addMark(REDACT);
    model.setIncluded(false);
    expect(row(model)).toEqual({ edited: false, dirty: true, final: false, revision: 1 });
    expect(() => model.endReversibility()).toThrow(/Commit or revert/); // The one guard: a host can't get past it unflattened.
    expect((await leftOutSend(model)).atSend).toBe(true);
  });

  it('GAP: edited is only the selected view: redact one window, select another, and it reads false', async () => {
    const a = pngOf(4, 4, 1);
    const b = pngOf(8, 8, 2);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: a }, { id: 's1', source: b }], raster: fakeRaster() });
    model.addMark(REDACT);
    await model.commit();
    expect(model.getSnapshot().edited).toBe(true);
    model.setActiveView('s1');
    expect(model.getSnapshot().edited).toBe(false);
    model.setIncluded(false);
    const { atSend } = await leftOutSend(model);
    expect(atSend).toBe(false); // True of s1, and s0 and its redaction are dropped by this tap.
    expect(model.getSnapshot().views.map((v) => v.id)).toEqual(['s1']);
    model.setIncluded(true);
    expect(await model.bytesToSend()).toBe(b);
  });

  it('after Clear: edited is false with re-encoded bytes, so no edits does not mean the bytes equal the capture', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    model.addMark(REDACT);
    await model.commit();
    model.clear();
    model.setIncluded(false);
    const { atSend } = await leftOutSend(model);
    expect(atSend).toBe(false);
    model.setIncluded(true);
    const bytes = await model.bytesToSend();
    expect(bytes).not.toBe(source);
    expect(model.getSnapshot().edited).toBe(false);
    expect(model.getSnapshot().editsAreFinal).toBe(false);
  });

  it('final stays final: a second left-out Send after an edited first one still says edited', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    model.addMark(REDACT);
    await firstSend(model);
    model.setIncluded(false);
    expect((await leftOutSend(model)).atSend).toBe(true);
    model.setIncluded(true);
    expect(await model.bytesToSend()).not.toBe(source);
  });

  it('GAP: a flatten failure blocks a left-out Send too, though it needs no image', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster({ fail: (s) => s === source }) });
    model.addMark(REDACT);
    model.setIncluded(false);
    await expect(leftOutSend(model)).rejects.toThrow(/decode failed/);
    expect(row(model)).toEqual({ edited: false, dirty: true, final: false, revision: 1 });
  });
});

describe('Framebriar\'s stated behavior, against ac13f32', () => {
  const state = (model: ScreenshotEditorModel) => ({ edited: model.getSnapshot().edited, final: model.getSnapshot().editsAreFinal });

  it('never edited: the original, edited false', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    expect(await firstSend(model)).toBe(source);
    expect(state(model)).toEqual({ edited: false, final: false });
  });

  it('DIFFERS: never edited but not attachable is not the original, with edited false', async () => {
    for (const source of [new Blob([await pngOf(4, 4).arrayBuffer()]), pngOf(8193, 2)]) {
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
      const bytes = await firstSend(model);
      expect(bytes).not.toBe(source);
      expect(state(model)).toEqual({ edited: false, final: false });
    }
  });

  it('marks at first Send: flattened only, edited, final, even excluded', async () => {
    const source = pngOf(4, 4);
    const included = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    included.addMark(REDACT);
    expect(await firstSend(included)).not.toBe(source);
    expect(state(included)).toEqual({ edited: true, final: true });

    const excluded = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    excluded.addMark(REDACT);
    excluded.setIncluded(false);
    expect(await firstSend(excluded)).toBeNull();
    expect(state(excluded)).toEqual({ edited: true, final: true });
    excluded.setIncluded(true);
    expect(await excluded.bytesToSend()).not.toBe(source);
  });

  it('marked, committed, then cleared before Send: re-encoded, edited false, final false, not the original', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    model.addMark(REDACT);
    await model.commit();
    model.clear();
    const bytes = await firstSend(model);
    expect(bytes).not.toBe(source);
    expect(state(model)).toEqual({ edited: false, final: false });
  });

  it('DIFFERS: marked and cleared with no commit between is the original, not re-encoded', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    model.addMark(REDACT);
    model.clear();
    expect(await firstSend(model)).toBe(source);
    expect(state(model)).toEqual({ edited: false, final: false });
  });

  it('uncommitted marks make endReversibility throw, and nothing changes', () => {
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }, { id: 's1', source: pngOf(8, 8) }], raster: fakeRaster() });
    model.addMark(REDACT);
    const before = model.getSnapshot();
    expect(() => model.endReversibility()).toThrow(/Commit or revert/);
    expect(model.getSnapshot()).toBe(before);
  });

  it('a commit failure on the Send path: nothing final, all views kept, marks stay dirty, and it can be retried', async () => {
    const source = pngOf(4, 4);
    let failing = true;
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }, { id: 's1', source: pngOf(8, 8) }], raster: fakeRaster({ fail: () => failing }) });
    model.addMark(REDACT);
    await expect(firstSend(model)).rejects.toThrow(/decode failed/);
    const after = model.getSnapshot();
    expect([after.edited, after.dirty, after.editsAreFinal, after.views.length, after.flattening]).toEqual([false, true, false, 2, false]);
    failing = false;
    expect(await firstSend(model)).not.toBe(source);
    expect(state(model)).toEqual({ edited: true, final: true });
  });

  it('a commit failure leaves only revert or remove: revert restores the original, which the user asked to mark up', async () => {
    const source = pngOf(4, 4);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster({ fail: () => true }) });
    model.addMark(REDACT);
    await expect(model.commit()).rejects.toThrow();
    model.revert();
    expect(model.getSnapshot().marks).toEqual([]);
    expect(await model.bytesToSend()).toBe(source);
  });

  it('GAP: a flatten failure after commit, for an oversized unedited source, comes after the views are already dropped', async () => {
    const big = pngOf(8193, 2);
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: big }, { id: 's1', source: pngOf(8, 8) }], raster: fakeRaster({ fail: (s) => s === big }) });
    await expect(firstSend(model)).rejects.toThrow(/decode failed/);
    expect(model.getSnapshot().views.map((v) => v.id)).toEqual(['s0']);
  });

  describe('telling the original from re-encoded bytes, without comparing bytes', () => {
    it('GAP: edited and editsAreFinal are the same for the original and for re-encoded', async () => {
      const source = pngOf(4, 4);
      const original = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
      const cleared = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
      cleared.addMark(REDACT);
      await cleared.commit();
      cleared.clear();
      await firstSend(original);
      await firstSend(cleared);
      const pick = (m: ScreenshotEditorModel) => { const { edited, dirty, editsAreFinal } = m.getSnapshot(); return { edited, dirty, editsAreFinal }; };
      expect(pick(original)).toEqual(pick(cleared));
    });

    it('object identity works while included, if the host keeps its own Blob: bytesToSend returns that same object', async () => {
      const source = pngOf(4, 4);
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
      expect(await firstSend(model) === source).toBe(true);
    });

    it('GAP: while excluded there are no bytes to ask about: bytesToSend and exportBytes are both null', async () => {
      const source = pngOf(4, 4);
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
      model.addMark(REDACT);
      await model.commit();
      model.setIncluded(false);
      expect(await model.bytesToSend()).toBeNull();
      expect(await model.exportBytes()).toBeNull();
    });

    it('GAP: the only way to bytes on a left-out Send is Include on and off around it, which moves revision by two', async () => {
      const source = pngOf(4, 4);
      const model = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
      model.addMark(REDACT);
      model.setIncluded(false);
      await model.commit();
      const revision = model.getSnapshot().revision;
      const listener = vi.fn();
      model.subscribe(listener);
      model.setIncluded(true);
      const bytes = await model.bytesToSend();
      model.setIncluded(false);
      model.endReversibility();
      expect(bytes).not.toBeNull();
      expect(bytes).not.toBe(source);
      expect(model.getSnapshot().revision).toBe(revision + 2);
      expect(listener.mock.calls.some(([s]) => s.included)).toBe(true); // The composer would render "included" for a moment.
    });
  });
});

describe('the interim Send mapping', () => {
  it('included always gives bytes, and left out gives noEdits read after commit, plus the shot', async () => {
    const source = pngOf(4, 4);
    const unedited = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    expect(await beginSend(unedited)).toEqual({ bytes: source, noEdits: true, shotId: 's0' });

    const pending = createScreenshotEditorModel({ views: [{ id: 's0', source }], raster: fakeRaster() });
    pending.addMark(REDACT);
    pending.setIncluded(false);
    expect(pending.getSnapshot().edited).toBe(false); // Before commit this would have said no edits.
    expect(await beginSend(pending)).toEqual({ bytes: null, noEdits: false, shotId: 's0' });
  });
});

describe('under React', () => {
  function Naive({ onModel }: { onModel: (m: ScreenshotEditorModel) => void }) {
    // The obvious shape: create once, dispose on unmount.
    const [model] = useState(() => createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }], raster: fakeRaster() }));
    useEffect(() => () => model.dispose(), [model]);
    useSyncExternalStore(model.subscribe, model.getSnapshot);
    onModel(model);
    return null;
  }

  it('GAP: StrictMode kills the model of the obvious hook: its simulated unmount disposes for good', () => {
    let model: ScreenshotEditorModel | undefined;
    render(<StrictMode><Naive onModel={(m) => { model = m; }} /></StrictMode>);
    expect(model!.addMark(PEN)).toBe(false);
    expect(model!.getSnapshot().marks).toEqual([]);
  });

  function Safe({ onModel, onRender }: { onModel: (m: ScreenshotEditorModel | null) => void; onRender?: () => void }) {
    const { model, snapshot } = useScreenshotEditorModel(
      [{ shotId: 's0', label: 'Main', preview: 'data:image/png;base64,iVBORw0KGgo=' }],
      { raster: fakeRaster() },
    );
    onModel(model);
    onRender?.();
    return <p data-testid="marks">{snapshot?.marks.length ?? -1}</p>;
  }

  it('survives StrictMode with a deferred dispose, and renders from the store', async () => {
    let model: ScreenshotEditorModel | null = null;
    const view = render(<StrictMode><Safe onModel={(m) => { model = m; }} /></StrictMode>);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    act(() => { expect(model!.addMark(PEN)).toBe(true); });
    expect(view.getByTestId('marks').textContent).toBe('1');
  });

  it('disposes after a real unmount', async () => {
    let model: ScreenshotEditorModel | null = null;
    const view = render(<Safe onModel={(m) => { model = m; }} />);
    view.unmount();
    await new Promise((r) => setTimeout(r, 5));
    expect(model!.addMark(PEN)).toBe(false);
  });

  it('has a stable snapshot: no change means the same object, and an unsubscribed listener is not called', () => {
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }], raster: fakeRaster() });
    const first = model.getSnapshot();
    expect(model.getSnapshot()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    const listener = vi.fn();
    const off = model.subscribe(listener);
    model.undo(); // nothing to undo: no notification, same object
    expect(listener).not.toHaveBeenCalled();
    expect(model.getSnapshot()).toBe(first);
    model.addMark(PEN);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot()).not.toBe(first);
    off();
    model.undo();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('takes bare methods, so useSyncExternalStore(model.subscribe, model.getSnapshot) needs no bind', () => {
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }], raster: fakeRaster() });
    const { subscribe, getSnapshot } = model;
    let calls = 0;
    const off = subscribe(() => { calls++; });
    model.addMark(PEN);
    expect(calls).toBe(1);
    expect(getSnapshot().marks).toHaveLength(1);
    off();
  });

  it('notifies nobody after dispose and keeps the last snapshot, so a stale reader can\'t tell', () => {
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }], raster: fakeRaster() });
    const listener = vi.fn();
    model.subscribe(listener);
    const last = model.getSnapshot();
    model.dispose();
    expect(listener).not.toHaveBeenCalled();
    expect(model.getSnapshot()).toBe(last);
    expect(model.getSnapshot().status).toBe('ready');
  });

  it('cancels a commit on dispose: it rejects with AbortError and no bytes land', async () => {
    const model = createScreenshotEditorModel({ views: [{ id: 's0', source: pngOf(4, 4) }], raster: fakeRaster() });
    model.addMark(PEN);
    const commit = model.commit();
    model.dispose();
    await expect(commit).rejects.toMatchObject({ name: 'AbortError' });
    expect(await model.bytesToSend()).toBeNull();
  });
});

describe('logsControl with Clubhouse\'s facts', () => {
  const SEPARATE = { attach: 'report-lines', available: true, automatic: 'separate-consent', marker: false, lines: { delivery: 'separate', lostOnQuit: true, retention: 'They are kept for 30 days, even if the report is deleted.' } } as const;

  it('says separate delivery, loss on quit and the verified retention, with no marker sentence', () => {
    const on = logsControl({ ...SEPARATE, checked: true });
    expect(on.explanation).toEqual([
      FEEDBACK_COPY.logs.automaticSeparateConsent,
      FEEDBACK_COPY.logs.automaticSwitch,
      FEEDBACK_COPY.logs.addsLinesSeparate,
      FEEDBACK_COPY.logs.linesLostOnQuit,
      'They are kept for 30 days, even if the report is deleted.',
    ]);
    expect(on.explanation.join(' ')).not.toMatch(/marker/i);
  });

  it('drops the lines sentences when unticked', () => {
    const off = logsControl({ ...SEPARATE, checked: false });
    expect(off.checked).toBe(false);
    expect(off.explanation.join(' ')).not.toMatch(/log lines/);
  });

  it('says in-report delivery for the report.diagnostics mode', () => {
    const on = logsControl({ ...SEPARATE, lines: { delivery: 'in-report' } });
    expect(on.explanation).toContain(FEEDBACK_COPY.logs.addsLines);
    expect(on.explanation).not.toContain(FEEDBACK_COPY.logs.linesLostOnQuit);
  });

  it('GAP: the label still says "with this report" while its own sentence says separately', () => {
    const on = logsControl(SEPARATE);
    expect(on.label).toBe('Send recent logs with this report');
    expect(on.explanation).toContain('The recent log lines shown here are sent separately from this report.');
  });

  it('GAP: no reason fits "no lines": it reads as a fault, so Clubhouse keeps its own sentence with attach none', () => {
    const none = logsControl({ attach: 'report-lines', available: false, unavailableReason: 'unavailable', automatic: 'separate-consent' });
    expect(none.reason).toBe('Recent logs can\'t be sent with this report right now.');
    expect(logsControl({ attach: 'none', automatic: 'separate-consent' }).shown).toBe(false);
  });

  it('maps not connected, and never shows a disabled box as checked', () => {
    const off = logsControl({ attach: 'report-lines', available: false, unavailableReason: 'not-enrolled', automatic: 'separate-consent', checked: true });
    expect([off.shown, off.enabled, off.checked, off.reason]).toEqual([true, false, false, FEEDBACK_COPY.logs.disabledNotEnrolled]);
  });

  it('throws if report-lines is available with no delivery', () => {
    expect(() => logsControl({ attach: 'report-lines', available: true })).toThrow(/lines.delivery/);
  });
});
