import { describe, it, expect, beforeAll } from 'vitest';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';

// Community plugins are loaded via native ESM and resolve 'react' & co.
// through the import map in index.html to src/renderer/shims/*.js, which
// re-export the host's copies from globalThis (set in renderer/index.ts).
// ESM named exports are static, so every shim must spell out its export
// list. These tests pin that list to the installed packages' public
// surface, so a React upgrade that adds/removes an export fails here
// instead of breaking plugins at link time ("does not provide an export
// named ...").
//
// Not colocated in shims/: CopyWebpackPlugin ships that whole directory.

/**
 * Public named exports: everything except `default`, `__…INTERNALS…` keys,
 * and the `module.exports` key Vite's CJS interop adds to the namespace.
 */
function publicKeys(mod: object): string[] {
  return Object.keys(mod)
    .filter((k) => k !== 'default' && k !== 'module.exports' && !k.startsWith('__'))
    .sort();
}

const g = globalThis as Record<string, unknown>;

const cases = [
  { spec: 'react', load: () => import('./shims/react.js'), real: React },
  { spec: 'react-dom', load: () => import('./shims/react-dom.js'), real: ReactDOM },
  { spec: 'react-dom/client', load: () => import('./shims/react-dom-client.js'), real: ReactDOMClient },
  { spec: 'react/jsx-runtime', load: () => import('./shims/react-jsx-runtime.js'), real: jsxRuntime },
] as const;

describe('community-plugin React shims', () => {
  beforeAll(() => {
    // Mirror renderer/index.ts before any shim module evaluates.
    g.React = React;
    g.ReactDOM = ReactDOM;
    g.ReactDOMClient = ReactDOMClient;
    g.__REACT_JSX_RUNTIME__ = jsxRuntime;
  });

  for (const { spec, load, real } of cases) {
    it(`${spec} shim exports exactly the public named exports of the real module`, async () => {
      const shim = (await load()) as Record<string, unknown>;
      expect(publicKeys(shim)).toEqual(publicKeys(real));
    });

    it(`${spec} shim re-exports the host's actual bindings`, async () => {
      const shim = (await load()) as Record<string, unknown>;
      const realMod = real as unknown as Record<string, unknown>;
      for (const key of publicKeys(real)) {
        expect(shim[key], `${spec}.${key}`).toBe(realMod[key]);
        expect(shim[key], `${spec}.${key}`).not.toBeUndefined();
      }
    });
  }

  it('react-dom/client shim provides createRoot/hydrateRoot (removed from react-dom in React 19)', async () => {
    const shim = await import('./shims/react-dom-client.js');
    expect(typeof shim.createRoot).toBe('function');
    expect(typeof shim.hydrateRoot).toBe('function');
    expect(shim.createRoot).toBe(ReactDOMClient.createRoot);
    expect((ReactDOM as Record<string, unknown>).createRoot).toBeUndefined();
  });
});
