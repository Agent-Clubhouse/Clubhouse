// PILOT, never ships. Plain JavaScript for the same reason as chat/rich/pdf-loader.js: ts-loader compiles
// to commonjs and rejects import.meta, and webpack needs this exact shape to emit the worker as an asset.

/* global Worker */
export function createPilotWorker() {
  return new Worker(new URL('./pilot-flatten-worker.js', import.meta.url));
}
