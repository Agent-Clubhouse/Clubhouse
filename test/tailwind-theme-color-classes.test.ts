/**
 * Regression (#2011): a `ctp-*` / `surface-*` color class with no matching
 * `--color-*` token in index.css `@theme` compiles to nothing, so the element
 * silently loses its color. Runtime-built names (`bg-${x}/10`) are invisible
 * to Tailwind's scanner and fail the same way. This scans renderer source for
 * both.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import * as path from 'path';

const rendererRoot = path.resolve(__dirname, '../src/renderer');
const indexCss = readFileSync(path.join(rendererRoot, 'index.css'), 'utf8');

const UTILITY = String.raw`(?:bg|text|border(?:-[trblxy])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|divide|placeholder|decoration|accent|caret|shadow)`;
const THEME_CLASS = new RegExp(String.raw`(?<![\w-])${UTILITY}-((?:ctp|surface)-[a-z0-9]+(?:-[a-z0-9]+)*)`, 'g');
const RUNTIME_CLASS = new RegExp(String.raw`(?<![\w-])${UTILITY}-\$\{`, 'g');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const definedColors = new Set([...indexCss.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));

describe('Tailwind theme color classes', () => {
  const files = sourceFiles(rendererRoot);

  it('finds the theme tokens', () => {
    expect(definedColors.has('ctp-base')).toBe(true);
    expect(definedColors.has('surface-0')).toBe(true);
  });

  it('every ctp-* / surface-* color class maps to a --color-* token in index.css', () => {
    const missing: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(THEME_CLASS)) {
          if (!definedColors.has(m[1])) {
            missing.push(`${path.relative(rendererRoot, file)}:${i + 1} ${m[0]}`);
          }
        }
      });
    }
    expect(missing).toEqual([]);
  });

  it('no color utility is built from a runtime template', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (RUNTIME_CLASS.test(line)) offenders.push(`${path.relative(rendererRoot, file)}:${i + 1}`);
        RUNTIME_CLASS.lastIndex = 0;
      });
    }
    expect(offenders).toEqual([]);
  });
});
