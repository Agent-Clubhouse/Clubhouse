// Re-exports the host's `react-dom` (globalThis.ReactDOM). The named-export
// list must match the installed package's public surface (renderer/plugin-shims.test.ts).
const D = globalThis.ReactDOM;
export default D;
export const {
  createPortal, flushSync, preconnect, prefetchDNS, preinit, preinitModule,
  preload, preloadModule, requestFormReset, unstable_batchedUpdates,
  useFormState, useFormStatus, version,
} = D;
