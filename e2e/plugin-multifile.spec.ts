/**
 * Part B E2E — durable multi-file plugin loading via the `clubhouse-plugin:`
 * protocol.
 *
 * This is the coverage #1520 structurally could not provide: jsdom/vitest can't
 * execute a real `import './sibling.js'`, so #1520's regression tests were a
 * unit proxy. Here we run the REAL Chromium ESM loader in the REAL packaged-style
 * (file://) renderer, importing a real multi-file fixture plugin over the custom
 * protocol, and assert its transitive relative imports resolve at runtime.
 *
 * We drive `import()` directly in the renderer rather than the full plugin-enable
 * UI flow: the mechanism Part B changes is module resolution, and this exercises
 * the actual scheme registration + main-process handler + Chromium relative URL
 * resolution + CSP + path-version cache-busting end-to-end.
 *
 * NOTE: E2E runs only in CI (packaged build); it is not run locally.
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof launchApp>>['electronApp'];
let window: Page;
let pluginsDir: string;

const FIXTURE_SRC = path.resolve(__dirname, 'fixtures/community-plugins/e2e-multifile');

/**
 * Build a clubhouse-plugin:// URL — MUST match src/shared/plugin-protocol-url.ts
 * (kept simple; that format is locked by unit tests). Version in the path so a
 * new version busts the whole module subtree.
 */
function pluginUrl(absFilePath: string, version: number): string {
  const norm = absFilePath.replace(/\\/g, '/');
  const withSlash = norm.startsWith('/') ? norm : `/${norm}`;
  const enc = withSlash
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/%3A/gi, ':'))
    .join('/');
  return `clubhouse-plugin://plugin/v${version}${enc}`;
}

/** Import the URL in the renderer, run activate(), return the DOM marker. */
async function importAndActivate(url: string): Promise<{ ok: boolean; marker: string | null; error?: string }> {
  return window.evaluate(async (u) => {
    try {
      document.documentElement.removeAttribute('data-e2e-multifile');
      const mod: { activate?: () => void | Promise<void> } = await import(u);
      await mod.activate?.();
      return { ok: true, marker: document.documentElement.getAttribute('data-e2e-multifile') };
    } catch (e) {
      return { ok: false, marker: null, error: String(e) };
    }
  }, url);
}

test.beforeAll(async () => {
  // Install the fixture into a sandbox plugins dir the app + handler will use.
  pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-plugins-'));
  fs.cpSync(FIXTURE_SRC, path.join(pluginsDir, 'e2e-multifile'), { recursive: true });
  ({ electronApp, window } = await launchApp({ pluginsDir }));
  // Sanity: we must be in the packaged-style file:// renderer for this to mean anything.
  expect(window.url().startsWith('file://')).toBe(true);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (pluginsDir) fs.rmSync(pluginsDir, { recursive: true, force: true });
});

test.describe('clubhouse-plugin: protocol — real multi-file resolution', () => {
  const entryAbs = () => path.join(pluginsDir, 'e2e-multifile', 'dist', 'main.js');

  test('resolves transitive relative imports (main → ./marker.js → ./lib/nested.js)', async () => {
    const res = await importAndActivate(pluginUrl(entryAbs(), Date.now()));
    expect(res.error ?? '').toBe('');
    expect(res.ok).toBe(true);
    // marker = `${MARKER}:${NESTED}` — proves BOTH sibling hops resolved.
    expect(res.marker).toBe('sibling-resolved-ok:nested-ok');
  });

  test('a malformed / out-of-root request is denied (404), not served', async () => {
    // Point at a file outside the plugins root — handler must reject it.
    const escaped = pluginUrl('/etc/hosts', Date.now());
    const res = await importAndActivate(escaped);
    expect(res.ok).toBe(false);
  });

  test('path-version cache-busting picks up rebuilt sibling code', async () => {
    const v1 = Date.now();
    const first = await importAndActivate(pluginUrl(entryAbs(), v1));
    expect(first.marker).toBe('sibling-resolved-ok:nested-ok');

    // "Rebuild" the deepest sibling.
    const nestedPath = path.join(pluginsDir, 'e2e-multifile', 'dist', 'lib', 'nested.js');
    fs.writeFileSync(nestedPath, "export const NESTED = 'nested-RELOADED';\n");

    // Same version → still cached (per-URL immutability).
    const cached = await importAndActivate(pluginUrl(entryAbs(), v1));
    expect(cached.marker).toBe('sibling-resolved-ok:nested-ok');

    // New version → whole subtree re-fetched, new sibling code observed.
    const reloaded = await importAndActivate(pluginUrl(entryAbs(), v1 + 1));
    expect(reloaded.marker).toBe('sibling-resolved-ok:nested-RELOADED');
  });
});
