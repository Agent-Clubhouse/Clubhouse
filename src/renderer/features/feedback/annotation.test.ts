import { afterEach, describe, expect, it, vi } from 'vitest';
import { compositeAnnotatedPng, drawStrokes, strokeWidthFor, toImagePoint, type Stroke } from './annotation';

function mockContext() {
  return {
    lineCap: '', lineJoin: '', strokeStyle: '', fillStyle: '', lineWidth: 0,
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    clearRect: vi.fn(), drawImage: vi.fn(),
  };
}

describe('toImagePoint', () => {
  it('maps a preview position to image pixels at a non-1 scale (Retina capture)', () => {
    // A 2880x1800 capture drawn into a 480x300 preview: 6 image pixels per CSS pixel.
    const rect = { left: 100, top: 50, width: 480, height: 300 };
    expect(toImagePoint(100 + 240, 50 + 150, rect, { width: 2880, height: 1800 })).toEqual({ x: 1440, y: 900 });
    expect(toImagePoint(100 + 10, 50 + 5, rect, { width: 2880, height: 1800 })).toEqual({ x: 60, y: 30 });
  });

  it('does not apply devicePixelRatio on top of the natural size', () => {
    const before = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      expect(toImagePoint(50, 50, { left: 0, top: 0, width: 100, height: 100 }, { width: 200, height: 200 })).toEqual({ x: 100, y: 100 });
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: before, configurable: true });
    }
  });

  it('clamps to the image and survives an empty box', () => {
    const rect = { left: 0, top: 0, width: 100, height: 50 };
    expect(toImagePoint(-20, 80, rect, { width: 200, height: 100 })).toEqual({ x: 0, y: 100 });
    expect(toImagePoint(5, 5, { left: 0, top: 0, width: 0, height: 0 }, { width: 200, height: 100 })).toEqual({ x: 0, y: 0 });
  });
});

describe('strokeWidthFor', () => {
  it('scales with the capture width, 2px at least', () => {
    expect(strokeWidthFor({ width: 2880, height: 1800 })).toBe(10);
    expect(strokeWidthFor({ width: 1440, height: 900 })).toBe(5);
    expect(strokeWidthFor({ width: 200, height: 100 })).toBe(2);
  });
});

describe('drawStrokes', () => {
  it('draws a single point as a dot and longer strokes as paths, in each color', () => {
    const ctx = mockContext();
    const strokes: Stroke[] = [
      { color: '#ff3b30', width: 10, points: [{ x: 5, y: 5 }] },
      { color: '#0a84ff', width: 4, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
      { color: '#ffffff', width: 4, points: [] },
    ];
    drawStrokes(ctx as unknown as CanvasRenderingContext2D, strokes);
    expect(ctx.arc).toHaveBeenCalledWith(5, 5, 5, 0, Math.PI * 2);
    expect(ctx.fill).toHaveBeenCalledTimes(1);
    expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
    expect(ctx.lineTo).toHaveBeenCalledTimes(2);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.strokeStyle).toBe('#0a84ff');
    expect(ctx.lineCap).toBe('round');
  });
});

describe('compositeAnnotatedPng', () => {
  const OriginalImage = globalThis.Image;
  afterEach(() => {
    globalThis.Image = OriginalImage;
    vi.restoreAllMocks();
  });

  it('draws the capture and the strokes at native resolution and encodes with toBlob', async () => {
    class FakeImage {
      naturalWidth = 2880;
      naturalHeight = 1800;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    }
    globalThis.Image = FakeImage as unknown as typeof Image;
    const ctx = mockContext();
    const sizes: Array<[number, number]> = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      sizes.push([this.width, this.height]);
      return ctx as unknown as CanvasRenderingContext2D;
    } as never);
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL');
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
      cb(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
    });

    const out = await compositeAnnotatedPng('data:image/png;base64,AAAA', [{ color: '#ff3b30', width: 10, points: [{ x: 1440, y: 900 }] }]);

    expect(sizes).toEqual([[2880, 1800]]);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0);
    expect(ctx.arc).toHaveBeenCalledWith(1440, 900, 5, 0, Math.PI * 2);
    expect(toDataURL).not.toHaveBeenCalled();
    expect(out).toBe(btoa(String.fromCharCode(137, 80, 78, 71)));
  });

  it('rejects when the capture cannot be read', async () => {
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onerror?.()); }
    }
    globalThis.Image = BrokenImage as unknown as typeof Image;
    await expect(compositeAnnotatedPng('data:image/png;base64,AAAA', [])).rejects.toThrow(/Couldn't read the screenshot/);
  });
});
