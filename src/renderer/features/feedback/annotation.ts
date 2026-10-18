/**
 * Ink on the feedback screenshot (#2099). Strokes are kept in the screenshot's own
 * pixels (device pixels, so 2x on Retina), never preview pixels: the preview is
 * scaled down by CSS, and the upload is composited at the capture's full size.
 */

/** Fixed colors, not theme tokens: ink has to show up on any screenshot. */
export const INKS = [
  { id: 'red', label: 'Red', color: '#ff3b30' },
  { id: 'yellow', label: 'Yellow', color: '#ffd60a' },
  { id: 'blue', label: 'Blue', color: '#0a84ff' },
  { id: 'white', label: 'White', color: '#ffffff' },
] as const;

export type InkColor = (typeof INKS)[number]['color'];

export interface Point { x: number; y: number }

export interface Stroke {
  color: string;
  /** Line width in image pixels. */
  width: number;
  points: Point[];
}

export interface Size { width: number; height: number }

/** A line width that reads the same at any capture size: about 0.35% of the width, 2px at least. */
export function strokeWidthFor(image: Size): number {
  return Math.max(2, Math.round(image.width / 280));
}

/**
 * A pointer position in image pixels. `rect` is the drawn preview's client box; the
 * ratio to the natural size already includes the display's pixel ratio, so
 * devicePixelRatio is never applied on top. Clamped to the image.
 */
export function toImagePoint(clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, image: Size): Point {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  const x = ((clientX - rect.left) / rect.width) * image.width;
  const y = ((clientY - rect.top) / rect.height) * image.height;
  return {
    x: Math.min(image.width, Math.max(0, x)),
    y: Math.min(image.height, Math.max(0, y)),
  };
}

/** Draw strokes onto a context in image pixels. A single point draws a dot. */
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[]): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    const [first, ...rest] = s.points;
    if (rest.length === 0) {
      ctx.beginPath();
      ctx.arc(first.x, first.y, s.width / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read the screenshot to add your drawing"));
    img.src = src;
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't save the screenshot with your drawing"))), 'image/png');
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

/**
 * The screenshot with the strokes baked in, at the capture's native size, as base64
 * PNG (no data: prefix). toBlob encodes off the main thread, unlike toDataURL.
 */
export async function compositeAnnotatedPng(previewSrc: string, strokes: readonly Stroke[]): Promise<string> {
  const img = await loadImage(previewSrc);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Couldn't save the screenshot with your drawing");
  ctx.drawImage(img, 0, 0);
  drawStrokes(ctx, strokes);
  const blob = await canvasToPng(canvas);
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}
