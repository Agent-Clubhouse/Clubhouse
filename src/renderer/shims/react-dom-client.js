// Re-exports the host's `react-dom/client` (globalThis.ReactDOMClient).
// React 19 removed createRoot/hydrateRoot from `react-dom`, so this must
// not read from globalThis.ReactDOM (renderer/plugin-shims.test.ts).
const C = globalThis.ReactDOMClient;
export default C;
export const { createRoot, hydrateRoot, version } = C;
