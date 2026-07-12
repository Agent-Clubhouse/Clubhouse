// Entry module for the E2E multi-file fixture plugin.
//
// The point of this fixture: the entry imports a sibling (./marker.js), which
// in turn imports a deeper sibling (./lib/nested.js). Under the #1499 blob-wrap
// regression these relative imports could not resolve (a blob: URL has no
// path). With the durable same-origin protocol (Part B), they resolve in both
// dev and prod. A successful activation — observable via the DOM marker below —
// is runtime proof that sibling resolution works.
import { MARKER, NESTED } from './marker.js';

export function activate() {
  document.documentElement.setAttribute('data-e2e-multifile', `${MARKER}:${NESTED}`);
}

export function deactivate() {
  document.documentElement.removeAttribute('data-e2e-multifile');
}
