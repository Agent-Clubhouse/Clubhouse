/**
 * PDF previews in chat (rich chat content, #2478), with pdf.js rather than
 * Chromium's PDF plugin (plugins stay off). Loaded only when a PDF preview
 * opens (pdf-loader.js). The bytes come from main's file preview, already
 * size-capped; pdf.js parses them in its worker and pages are drawn to a
 * canvas. Nothing is fetched: no font, CMap or wasm URLs are given, so
 * pdf.js falls back to system fonts and skips what needs them.
 */

import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import { createPdfWorker } from './pdf-loader';

/** A page is drawn at most this many device pixels: its own size can be anything. */
const MAX_CANVAS_PIXELS = 4096 * 4096;

let workerReady = false;

/** One worker for every preview: starting one costs more than parsing a small PDF. */
function ensureWorker(): void {
  if (workerReady) return;
  GlobalWorkerOptions.workerPort = createPdfWorker();
  workerReady = true;
}

export type PdfOpenError = 'password' | 'invalid';

export interface OpenedPdf {
  numPages: number;
  /** Draw page `n` (1-based) into `canvas`, fit inside `width` x `height` CSS pixels. */
  renderPage(n: number, canvas: HTMLCanvasElement, width: number, height: number): { done: Promise<void>; cancel(): void };
  close(): void;
}

/** Open PDF bytes. Rejects with an Error whose message is a PdfOpenError. */
export async function openPdf(data: Uint8Array): Promise<OpenedPdf> {
  ensureWorker();
  // pdf.js moves the buffer to its worker: give it a copy, the caller keeps theirs.
  const task = getDocument({ data: data.slice(), isOffscreenCanvasSupported: false, enableXfa: false, stopAtErrors: false });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (err) {
    // With no onPassword handler pdf.js rejects a protected file: a prompt would need a UI of its own.
    throw new Error(err instanceof Error && err.name === 'PasswordException' ? 'password' : 'invalid');
  }
  return {
    numPages: doc.numPages,
    renderPage(n, canvas, width, height) {
      let rendering: RenderTask | undefined;
      let cancelled = false;
      const done = (async () => {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const ratio = window.devicePixelRatio || 1;
        const fit = Math.min(width / base.width, height / base.height);
        const scale = Math.min(fit * ratio, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = `${Math.floor(base.width * fit)}px`;
        canvas.style.height = `${Math.floor(base.height * fit)}px`;
        rendering = page.render({ canvas, viewport });
        await rendering.promise;
      })();
      return { done, cancel: () => { cancelled = true; rendering?.cancel(); } };
    },
    close() { void task.destroy(); },
  };
}
