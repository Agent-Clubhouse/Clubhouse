/**
 * Regression: the named z-index utilities (z-modal, z-toast, z-dropdown,
 * z-canvas-overlay, z-canvas-dialog, z-top, z-raised, z-dropdown-backdrop)
 * must compile to real CSS rules with the expected z-index values.
 *
 * Tailwind v4 generates `z-*` utilities only from the `--z-index-*`
 * namespace — not `--z-*`. A previous version of `src/renderer/index.css`
 * declared `--z-modal: 200; --z-toast: 300; …` which set CSS custom
 * properties on :root but produced NO Tailwind utilities. Every modal,
 * dropdown, and overlay using these classes silently fell back to
 * `z-index: auto`, breaking visible stacking in update-gate modals,
 * project context menus, and the Annex SatelliteLockOverlay.
 */
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, unlink } from 'fs/promises';
import * as path from 'path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

const projectRoot = path.resolve(__dirname, '..');
const indexCssPath = path.join(projectRoot, 'src/renderer/index.css');

async function compileWithProbe(probeClasses: string[]): Promise<string> {
  const htmlPath = path.join(__dirname, '.tailwind-z-probe.html');
  await writeFile(htmlPath, `<div class="${probeClasses.join(' ')}"></div>`);
  try {
    const baseCss = await readFile(indexCssPath, 'utf8');
    // Force the probe HTML into Tailwind's content scan
    const input = `@source "${htmlPath}";\n${baseCss}`;
    const result = await postcss([tailwindcss()]).process(input, { from: indexCssPath });
    return result.css;
  } finally {
    try { await unlink(htmlPath); } catch { /* ignore */ }
  }
}

/** Extracts the z-index value Tailwind emitted for the given utility class. */
function findZIndexFor(css: string, utility: string): string | undefined {
  // Tailwind v4 emits ".z-modal { z-index: var(--z-index-modal); }" or the
  // computed value depending on configuration. We accept either form and
  // resolve var() references against the :root declarations.
  const escapedUtility = utility.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ruleRe = new RegExp(`\\.${escapedUtility}\\s*\\{[^}]*z-index\\s*:\\s*([^;}]+)`, 'i');
  const match = css.match(ruleRe);
  if (!match) return undefined;
  const value = match[1].trim();
  const varMatch = value.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (varMatch) {
    const varName = varMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rootRe = new RegExp(`${varName}\\s*:\\s*([^;\\n]+)`);
    const rootMatch = css.match(rootRe);
    if (rootMatch) return rootMatch[1].trim();
  }
  return value;
}

describe('Tailwind named z-index utilities', () => {
  const expected: Record<string, string> = {
    'z-raised': '10',
    'z-dropdown-backdrop': '40',
    'z-dropdown': '50',
    'z-modal': '200',
    'z-toast': '300',
    'z-canvas-overlay': '9999',
    'z-canvas-dialog': '10000',
    'z-top': '100000',
  };

  it('compiles every named z-index utility to its declared value', async () => {
    const css = await compileWithProbe(Object.keys(expected));
    for (const [utility, value] of Object.entries(expected)) {
      const actual = findZIndexFor(css, utility);
      expect(actual, `${utility} should resolve to ${value}, got ${actual ?? '(no rule emitted)'}`).toBe(value);
    }
  }, 30_000);

  it('preserves the documented z-order: toast > modal > dropdown > raised', async () => {
    const css = await compileWithProbe(['z-raised', 'z-dropdown', 'z-modal', 'z-toast']);
    const z = (u: string) => parseInt(findZIndexFor(css, u) ?? 'NaN', 10);
    expect(z('z-toast')).toBeGreaterThan(z('z-modal'));
    expect(z('z-modal')).toBeGreaterThan(z('z-dropdown'));
    expect(z('z-dropdown')).toBeGreaterThan(z('z-raised'));
  }, 30_000);
});
