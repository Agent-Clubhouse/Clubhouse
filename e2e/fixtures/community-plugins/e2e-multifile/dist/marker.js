// Sibling module imported by the entry (dist/main.js). If relative-import
// resolution is broken, importing this throws and the plugin fails to activate.
export const MARKER = 'sibling-resolved-ok';

// A second hop: marker.js itself imports a deeper sibling, so the E2E proves
// transitive relative resolution, not just one level.
export { NESTED } from './lib/nested.js';
