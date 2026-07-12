import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';

// Regression guard for the v0.40+ plugin-launch failure
//   TypeError: Failed to fetch dynamically imported module
// caused by the renderer import map pointing at the WRONG shim path.
//
// Layout of the packaged renderer output (forge webpack plugin):
//   .webpack/renderer/index.html        ← NO: the entry is named 'main_window'
//   .webpack/renderer/main_window/index.html   ← the actual document
//   .webpack/renderer/shims/react.js           ← CopyWebpackPlugin: from src/renderer/shims → 'shims'
//
// Import-map addresses resolve against the *document's* URL, which is one level
// deep (main_window/). So the map must use '../shims/…' to climb out to the
// shims dir. './shims/…' resolves to main_window/shims/… which does not exist →
// 404 → the plugin's whole module graph fails to fetch. (It only worked in dev,
// where the dev server serves the entry without the main_window/ segment.)

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, 'index.html'), 'utf-8');

function getImportMap(): Record<string, string> {
  const m = html.match(/<script type="importmap"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no importmap script block found in index.html');
  return JSON.parse(m[1]).imports as Record<string, string>;
}

describe('renderer index.html import map', () => {
  const imports = getImportMap();

  it('maps the React bare specifiers plugins need', () => {
    expect(Object.keys(imports).sort()).toEqual(
      ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'].sort(),
    );
  });

  it('points shims one level up (../shims), not at the main_window-relative ./shims', () => {
    for (const [spec, addr] of Object.entries(imports)) {
      expect(addr, `${spec} → ${addr}`).toMatch(/^\.\.\/shims\//);
      expect(addr, `${spec} must not be main_window-relative`).not.toMatch(/^\.\/shims\//);
    }
  });

  it('resolves each shim to .webpack/renderer/shims from the main_window document', () => {
    // Simulate resolution against the real document URL.
    const docUrl = new URL('https://app/.webpack/renderer/main_window/index.html');
    for (const addr of Object.values(imports)) {
      const resolved = new URL(addr, docUrl).pathname;
      expect(resolved.startsWith('/.webpack/renderer/shims/')).toBe(true);
    }
  });
});
