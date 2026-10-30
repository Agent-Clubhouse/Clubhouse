// Plain JavaScript on purpose (as src/main/telemetry/lazy-chunks.js). ts-loader
// compiles our TypeScript with `module: commonjs`, which rewrites `import()`
// into `require()` and would inline pdf.js into the renderer bundle, and
// rejects `import.meta`. webpack parses this file natively: pdf.js becomes a
// lazy chunk loaded the first time a PDF preview opens, and its worker an
// asset of its own.

/** pdf.js and the helpers that drive it, loaded on first use. */
export function loadPdfDocument() {
  return import(/* webpackChunkName: "pdfjs" */ './pdf-document');
}

/* global Worker */
/** A new pdf.js worker (a module worker, from pdf.js's own build). */
export function createPdfWorker() {
  return new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' });
}
